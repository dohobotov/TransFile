//! Connection management for network (TCP) ADB devices: device-list tracking, readiness checks and a
//! connect routine that never makes a busy device worse.
//!
//! Background (measured on MuMu Player instances reachable over the LAN): adbd on such a device blocks its
//! main loop for ~129 s while it tears down an ADB connection that was closed by the host. The teardown of
//! a dropped connection is triggered by the NEXT connection, and teardowns are processed one after another.
//! Consequences:
//! - after «Отключить», the first reconnection is accepted instantly, but the device answers no command for
//!   ~130 s (Explorer looked stuck);
//! - every additional closed connection adds another ~129 s: `adb connect` gives up after its fixed 10 s
//!   handshake timeout and closes its socket, so connecting/disconnecting again while the device is busy keeps
//!   it "offline" much longer;
//! - the adb server keeps an offline transport and re-connects it on its own with a socket it does NOT
//!   abort, so such a device comes back by itself once adbd is free — as long as nobody closes that socket.
//! Therefore: never close a connection without need, don't treat "already connected" to an offline transport
//! as success, wait for a new transport to answer before using it, and keep the UI updated automatically.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncReadExt;

use crate::adb::{execute_adb_command_async, find_adb_path, netstat_tcp_output};

/// Emitted (no payload) whenever the adb server reports a change of the device list.
pub const DEVICES_CHANGED_EVENT: &str = "adb-devices-changed";
/// Emitted with [`ReadinessEvent`] when a device starts/finishes answering after (re)connection.
pub const READINESS_EVENT: &str = "device-readiness-changed";
/// Emitted with [`ConnectProgress`] while `connect_lan_devices` works on a host.
pub const CONNECT_PROGRESS_EVENT: &str = "lan-connect-progress";

/// Longest wait for a freshly connected device to answer. A device can be busy for several 129 s periods if
/// connections were dropped repeatedly; after this the device is reported as unresponsive.
pub const READY_TIMEOUT: Duration = Duration::from_secs(300);
const READY_MARKER: &str = "__transfile_ready__";
const MAX_PARALLEL_PROBES: usize = 8;

// ---------------------------------------------------------------------------------------------------------
// adb server state helpers
// ---------------------------------------------------------------------------------------------------------

/// One entry of `adb devices -l` / `adb track-devices -l`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdbEntry {
    pub serial: String,
    pub state: String,
    pub transport_id: Option<String>,
}

pub fn parse_device_list(text: &str) -> Vec<AdbEntry> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with("List of devices") || line.starts_with('*') {
                return None;
            }
            let mut parts = line.split_whitespace();
            let serial = parts.next()?.to_string();
            let state = parts.next()?.to_string();
            let transport_id = parts
                .find_map(|p| p.strip_prefix("transport_id:"))
                .map(|s| s.to_string());
            Some(AdbEntry { serial, state, transport_id })
        })
        .collect()
}

/// Current state of every transport known to the adb server ("device", "offline", "unauthorized", ...).
pub async fn adb_states() -> Result<HashMap<String, String>, String> {
    let out = execute_adb_command_async(&["devices"], 5).await?;
    Ok(parse_device_list(&out).into_iter().map(|e| (e.serial, e.state)).collect())
}

/// True when the adb server currently holds an open TCP connection (or a connect in progress) to `host`.
/// An offline transport with such a socket is a reconnect the server is still waiting on: closing it
/// (`adb disconnect`) would cost a busy MuMu device another ~129 s.
pub async fn adb_server_has_live_socket(host: String) -> bool {
    tokio::task::spawn_blocking(move || {
        let Some(netstat) = netstat_tcp_output() else { return false };
        server_socket_to_host(&netstat, &host)
    })
    .await
    .unwrap_or(false)
}

/// Pure part of [`adb_server_has_live_socket`] (testable): finds the adb server by its listening port 5037,
/// then an ESTABLISHED / SYN_SENT connection of that process to `host`.
pub fn server_socket_to_host(netstat: &str, host: &str) -> bool {
    let rows: Vec<Vec<&str>> = netstat.lines().map(|l| l.split_whitespace().collect()).collect();
    let server_pid = rows.iter().find_map(|r| {
        (r.len() >= 5 && r[0] == "TCP" && r[3] == "LISTENING" && r[1].ends_with(":5037")).then(|| r[4])
    });
    let Some(pid) = server_pid else { return false };
    rows.iter().any(|r| {
        r.len() >= 5 && r[0] == "TCP" && r[2] == host && (r[3] == "ESTABLISHED" || r[3] == "SYN_SENT") && r[4] == pid
    })
}

// ---------------------------------------------------------------------------------------------------------
// Readiness: does a connected transport actually answer commands?
// ---------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
enum Readiness {
    Checking { since: Instant, generation: u64 },
    Ready,
    Unresponsive,
}

static READINESS: LazyLock<Mutex<HashMap<String, Readiness>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
static PROBE_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static PROBE_SLOTS: LazyLock<tokio::sync::Semaphore> = LazyLock::new(|| tokio::sync::Semaphore::new(MAX_PARALLEL_PROBES));

#[derive(Debug, Clone, Serialize)]
pub struct ReadinessEvent {
    pub serial: String,
    /// "checking" | "ready" | "unresponsive"
    pub status: String,
}

/// Readiness of a serial for [`crate::adb::DeviceInfo`]: (status, ms since the check started).
/// "unknown" when the device was never probed (e.g. USB devices before the first track-devices frame).
pub fn readiness_of(serial: &str) -> (String, Option<u64>) {
    let map = READINESS.lock().unwrap();
    match map.get(serial) {
        Some(Readiness::Checking { since, .. }) => ("checking".into(), Some(since.elapsed().as_millis() as u64)),
        Some(Readiness::Ready) => ("ready".into(), None),
        Some(Readiness::Unresponsive) => ("unresponsive".into(), None),
        None => ("unknown".into(), None),
    }
}

fn forget_readiness(serial: &str) {
    READINESS.lock().unwrap().remove(serial);
}

/// Starts a background readiness probe for `serial` unless one is already running. The probe is a single
/// `shell echo` (one stream on the existing transport — it never opens or closes a TCP connection), so it
/// is harmless for a busy device: it simply completes once adbd processes it.
pub fn start_readiness_probe(app: &AppHandle, serial: &str) {
    let generation = PROBE_GENERATION.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1;
    {
        let mut map = READINESS.lock().unwrap();
        if matches!(map.get(serial), Some(Readiness::Checking { .. })) {
            return;
        }
        map.insert(serial.to_string(), Readiness::Checking { since: Instant::now(), generation });
    }
    let _ = app.emit(READINESS_EVENT, ReadinessEvent { serial: serial.to_string(), status: "checking".into() });

    // Regular devices answer within milliseconds and the UI keeps showing them as connected. If the check is
    // still running after 2 s, the device is busy: let the UI refresh so it shows «ждём ответа».
    {
        let app = app.clone();
        let serial = serial.to_string();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let still_checking = matches!(
                READINESS.lock().unwrap().get(&serial),
                Some(Readiness::Checking { generation: g, .. }) if *g == generation
            );
            if still_checking {
                let _ = app.emit(DEVICES_CHANGED_EVENT, ());
            }
        });
    }

    let app = app.clone();
    let serial = serial.to_string();
    tauri::async_runtime::spawn(async move {
        let ok = {
            let _slot = PROBE_SLOTS.acquire().await;
            probe_ready(&serial, READY_TIMEOUT).await
        };
        let status = {
            let mut map = READINESS.lock().unwrap();
            // A newer probe (new transport) or a removal supersedes this result
            match map.get(&serial) {
                Some(Readiness::Checking { generation: g, .. }) if *g == generation => {
                    map.insert(serial.clone(), if ok { Readiness::Ready } else { Readiness::Unresponsive });
                    Some(if ok { "ready" } else { "unresponsive" })
                }
                _ => None,
            }
        };
        if let Some(status) = status {
            let _ = app.emit(READINESS_EVENT, ReadinessEvent { serial, status: status.into() });
            let _ = app.emit(DEVICES_CHANGED_EVENT, ());
        }
    });
}

async fn probe_ready(serial: &str, timeout: Duration) -> bool {
    match execute_adb_command_async(&["-s", serial, "shell", "echo", READY_MARKER], timeout.as_secs()).await {
        Ok(out) => out.contains(READY_MARKER),
        Err(_) => false,
    }
}

/// Waits until `serial` answers commands (reusing a running probe), up to `timeout`.
pub async fn ensure_ready(app: &AppHandle, serial: &str, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    match READINESS.lock().unwrap().get(serial) {
        Some(Readiness::Ready) => return Ok(()),
        _ => {}
    }
    let needs_probe = !matches!(READINESS.lock().unwrap().get(serial), Some(Readiness::Checking { .. }));
    if needs_probe {
        // Unknown or previously unresponsive: check again now
        READINESS.lock().unwrap().remove(serial);
        start_readiness_probe(app, serial);
    }
    loop {
        match READINESS.lock().unwrap().get(serial) {
            Some(Readiness::Ready) => return Ok(()),
            Some(Readiness::Unresponsive) => {
                return Err("Устройство не отвечает на команды ADB. Эмулятор MuMu после переподключения бывает недоступен по ~2 мин на каждый обрыв соединения — подождите или перезапустите эмулятор.".into())
            }
            None => return Err("Устройство отключено".into()),
            Some(Readiness::Checking { .. }) => {}
        }
        if Instant::now() >= deadline {
            return Err("Устройство ещё не отвечает (ожидание после переподключения)".into());
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

/// Explorer / UI: wait for the device to answer. Also re-probes a device marked ready whose commands just
/// timed out (it may have become busy since).
#[tauri::command]
pub async fn wait_device_ready(app: AppHandle, serial: String, timeout_secs: Option<u64>, recheck: Option<bool>) -> Result<(), String> {
    if recheck.unwrap_or(false) {
        let mut map = READINESS.lock().unwrap();
        if !matches!(map.get(&serial), Some(Readiness::Checking { .. })) {
            map.remove(&serial);
        }
    }
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(READY_TIMEOUT.as_secs()).clamp(1, READY_TIMEOUT.as_secs()));
    ensure_ready(&app, &serial, timeout).await
}

// ---------------------------------------------------------------------------------------------------------
// Device watcher: `adb track-devices -l`
// ---------------------------------------------------------------------------------------------------------

/// Follows `adb track-devices -l` for the whole app lifetime: emits [`DEVICES_CHANGED_EVENT`] on every
/// change (the UI refreshes itself instead of showing a stale "offline") and probes every new transport.
pub fn start_device_watcher(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut known: HashMap<String, AdbEntry> = HashMap::new();
        loop {
            if let Err(e) = run_tracker(&app, &mut known).await {
                eprintln!("adb track-devices stopped: {e}");
            }
            // adb server restarted / adb missing: transports are gone, re-sync after a pause
            for serial in known.keys() {
                forget_readiness(serial);
            }
            known.clear();
            let _ = app.emit(DEVICES_CHANGED_EVENT, ());
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

async fn run_tracker(app: &AppHandle, known: &mut HashMap<String, AdbEntry>) -> Result<(), String> {
    let adb = find_adb_path()?;
    let mut cmd = tokio::process::Command::new(adb);
    cmd.args(["track-devices", "-l"]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::null());
    cmd.stdin(std::process::Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(0x08000000);
    cmd.kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    crate::proc_guard::bind_to_app_lifetime(&child);
    let mut stdout = child.stdout.take().ok_or("no stdout")?;
    let mut buf = [0u8; 8192];

    loop {
        // Output is only used as a "something changed" signal. The frames themselves (4 hex digits of length
        // + list) can't be parsed reliably: on Windows the adb client writes them in text mode, turning every
        // "\n" into "\r\n" so the length prefix no longer matches. The list is read with `adb devices -l`.
        if stdout.read(&mut buf).await.map_err(|e| e.to_string())? == 0 {
            return Err("track-devices exited".into());
        }
        // Coalesce a burst of updates (e.g. many devices reconnecting at once) into one refresh
        loop {
            match tokio::time::timeout(Duration::from_millis(150), stdout.read(&mut buf)).await {
                Ok(Ok(0)) => return Err("track-devices exited".into()),
                Ok(Ok(_)) => continue,
                Ok(Err(e)) => return Err(e.to_string()),
                Err(_) => break,
            }
        }
        let list = execute_adb_command_async(&["devices", "-l"], 5).await?;
        apply_tracker_frame(app, known, parse_device_list(&list));
        let _ = app.emit(DEVICES_CHANGED_EVENT, ());
    }
}

/// Serials whose transport just became usable ("device" with a new transport id) — they need a readiness
/// probe. Pure for tests.
pub fn new_device_transports(known: &HashMap<String, AdbEntry>, entries: &[AdbEntry]) -> Vec<String> {
    entries
        .iter()
        .filter(|e| e.state == "device")
        .filter(|e| match known.get(&e.serial) {
            Some(prev) => prev.state != "device" || prev.transport_id != e.transport_id,
            None => true,
        })
        .map(|e| e.serial.clone())
        .collect()
}

fn apply_tracker_frame(app: &AppHandle, known: &mut HashMap<String, AdbEntry>, entries: Vec<AdbEntry>) {
    for serial in new_device_transports(known, &entries) {
        // A new transport must prove it answers; an old "ready" belongs to the previous connection
        forget_readiness(&serial);
        start_readiness_probe(app, &serial);
    }
    for (serial, _) in known.iter() {
        let still_device = entries.iter().any(|e| &e.serial == serial && e.state == "device");
        if !still_device {
            forget_readiness(serial);
        }
    }
    *known = entries.into_iter().map(|e| (e.serial.clone(), e)).collect();
}

// ---------------------------------------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct ConnectOutcome {
    pub host: String,
    /// "connected" | "unauthorized" | "pending" | "failed"
    pub state: String,
    pub message: String,
    /// Connected, but the device doesn't answer commands yet (MuMu needs ~2 min after a reconnect)
    pub busy: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConnectProgress {
    pub host: String,
    /// "connecting" | "waiting" (the adb server keeps reconnecting a busy device) | "done"
    pub phase: String,
}

fn outcome(host: &str, state: &str, message: impl Into<String>) -> ConnectOutcome {
    ConnectOutcome { host: host.to_string(), state: state.to_string(), message: message.into(), busy: false }
}

const PENDING_MESSAGE: &str = "Устройство ещё не ответило (вероятно, занято после предыдущего отключения). adb продолжает подключение сам — статус обновится автоматически, повторно нажимать не нужно.";

/// Connects one network host without ever dropping a connection the adb server is still waiting on.
pub async fn connect_host(app: Option<&AppHandle>, host: &str) -> ConnectOutcome {
    let emit = |phase: &str| {
        if let Some(app) = app {
            let _ = app.emit(CONNECT_PROGRESS_EVENT, ConnectProgress { host: host.to_string(), phase: phase.to_string() });
        }
    };
    emit("connecting");
    let mut result = connect_host_inner(host, &emit).await;
    if result.state == "connected" {
        if let Some(app) = app {
            // A regular device answers at once; a busy MuMu instance won't for ~2 min. Tell the UI which.
            result.busy = ensure_ready(app, host, Duration::from_millis(2500)).await.is_err();
        }
    }
    emit("done");
    result
}

async fn connect_host_inner(host: &str, emit: &(dyn Fn(&str) + Sync)) -> ConnectOutcome {
    let state = adb_states().await.ok().and_then(|m| m.get(host).cloned());
    match state.as_deref() {
        Some("device") => return outcome(host, "connected", "Уже подключено"),
        Some("unauthorized") => return outcome(host, "unauthorized", "Подтвердите отладку по ADB на экране устройства"),
        Some(_) => {
            // offline / connecting / authorizing: "adb connect" would only answer "already connected".
            if adb_server_has_live_socket(host.to_string()).await {
                // The server is mid-reconnect: give it a moment, never close its socket
                emit("waiting");
                return wait_for_online(host, Duration::from_secs(12)).await;
            }
            // Dead entry without a socket: removing it closes nothing on the device
            let _ = execute_adb_command_async(&["disconnect", host], 5).await;
        }
        None => {}
    }

    // adb's own handshake timeout is 10 s: give the client more so it is never killed mid-handshake
    let res = execute_adb_command_async(&["connect", host], 20).await;
    let text = match &res {
        Ok(t) | Err(t) => t.trim().to_string(),
    };
    let lower = text.to_lowercase();
    if lower.contains("connected to") && !lower.contains("failed") && !lower.contains("cannot") && !lower.contains("unable") {
        return wait_for_online(host, Duration::from_secs(3)).await;
    }
    let legacy_port = host.rsplit(':').next() == Some("5555");
    if legacy_port && lower.starts_with("failed to connect to") && !lower.contains("(100") {
        // TCP connected but adbd didn't answer the handshake in 10 s: the device is busy. The adb server
        // already re-connects it in the background with a patient socket. (On Android 11+ TLS ports the
        // same text usually means "not paired", so it stays a failure there.)
        emit("waiting");
        return outcome(host, "pending", PENDING_MESSAGE);
    }
    if text.is_empty() {
        return outcome(host, "failed", "Нет ответа от adb");
    }
    outcome(host, "failed", text)
}

/// Polls the adb server (locally, no device traffic) until `serial` is in state "device".
pub async fn wait_for_device_state(serial: &str, max_wait: Duration) -> bool {
    let deadline = Instant::now() + max_wait;
    loop {
        if adb_states().await.ok().and_then(|m| m.get(serial).cloned()).as_deref() == Some("device") {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn wait_for_online(host: &str, max_wait: Duration) -> ConnectOutcome {
    let deadline = Instant::now() + max_wait;
    loop {
        match adb_states().await.ok().and_then(|m| m.get(host).cloned()).as_deref() {
            Some("device") => return outcome(host, "connected", "Подключено"),
            Some("unauthorized") => return outcome(host, "unauthorized", "Подтвердите отладку по ADB на экране устройства"),
            None => return outcome(host, "failed", "Подключение не удалось"),
            Some(_) => {}
        }
        if Instant::now() >= deadline {
            return outcome(host, "pending", PENDING_MESSAGE);
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_device_list() {
        let text = "List of devices attached\n\
                    192.168.1.101:5555     device product:dm2q model:SM_S916U device:dm2q transport_id:630\n\
                    192.168.1.104:5555     offline transport_id:592\n\
                    R58M123ABC\tunauthorized usb:1-1 transport_id:7\n\n";
        let e = parse_device_list(text);
        assert_eq!(e.len(), 3);
        assert_eq!(e[0], AdbEntry { serial: "192.168.1.101:5555".into(), state: "device".into(), transport_id: Some("630".into()) });
        assert_eq!(e[1].state, "offline");
        assert_eq!(e[2].serial, "R58M123ABC");
        assert_eq!(e[2].state, "unauthorized");
        assert!(parse_device_list("* daemon started successfully\nList of devices attached\n").is_empty());
    }

    #[test]
    fn test_new_device_transports() {
        let mut known = HashMap::new();
        known.insert("a:5555".to_string(), AdbEntry { serial: "a:5555".into(), state: "device".into(), transport_id: Some("1".into()) });
        known.insert("b:5555".to_string(), AdbEntry { serial: "b:5555".into(), state: "offline".into(), transport_id: Some("2".into()) });
        let entries = vec![
            // unchanged transport: no probe
            AdbEntry { serial: "a:5555".into(), state: "device".into(), transport_id: Some("1".into()) },
            // offline -> device: probe
            AdbEntry { serial: "b:5555".into(), state: "device".into(), transport_id: Some("2".into()) },
            // brand new: probe
            AdbEntry { serial: "c:5555".into(), state: "device".into(), transport_id: Some("3".into()) },
            // new but offline: nothing to probe yet
            AdbEntry { serial: "d:5555".into(), state: "offline".into(), transport_id: Some("4".into()) },
        ];
        assert_eq!(new_device_transports(&known, &entries), vec!["b:5555".to_string(), "c:5555".to_string()]);
        // reconnect of the same serial gets a new transport id: probe again
        let again = vec![AdbEntry { serial: "a:5555".into(), state: "device".into(), transport_id: Some("9".into()) }];
        assert_eq!(new_device_transports(&known, &again), vec!["a:5555".to_string()]);
    }

    #[test]
    fn test_server_socket_to_host() {
        let netstat = "\
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    127.0.0.1:5037         0.0.0.0:0              LISTENING       34632
  TCP    192.168.1.84:61632     192.168.1.37:5555      ESTABLISHED     34632
  TCP    192.168.1.84:63483     192.168.1.37:5555      FIN_WAIT_2      34632
  TCP    192.168.1.84:53262     192.168.1.118:5555     ESTABLISHED     36108
  TCP    192.168.1.84:50000     192.168.1.40:5555      FIN_WAIT_2      34632
";
        assert!(server_socket_to_host(netstat, "192.168.1.37:5555"));
        // socket owned by another process (not the adb server)
        assert!(!server_socket_to_host(netstat, "192.168.1.118:5555"));
        // only a closing socket
        assert!(!server_socket_to_host(netstat, "192.168.1.40:5555"));
        assert!(!server_socket_to_host(netstat, "192.168.1.99:5555"));
        // no adb server listening
        assert!(!server_socket_to_host("  TCP    192.168.1.84:61632     192.168.1.37:5555      ESTABLISHED     34632", "192.168.1.37:5555"));
    }
}
