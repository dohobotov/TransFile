use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Emitter, Manager};


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub serial: String,
    pub model: String,
    pub product: String,
    pub device_type: String, // "wifi" | "usb"
    pub state: String,       // "device" | "unauthorized" | "offline"
    pub ip: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteFileItem {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub mtime: String,
    pub permissions: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransferProgress {
    pub transfer_id: String,
    pub file_name: String,
    pub current_bytes: u64,
    pub total_bytes: u64,
    pub percentage: f32,
    pub speed_mb_s: f32,
    pub status: String, // "starting" | "transferring" | "completed" | "error"
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TargetDevice {
    pub id: String,          // serial or ip:port
    pub name: String,        // model or display name
    pub is_connected: bool,  // true if already in adb devices
    pub device_type: String, // "usb" | "wifi" | "lan"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MultiTransferDeviceProgress {
    pub device_id: String,
    pub device_name: String,
    pub current_file: String,
    pub total_files: usize,
    pub completed_files: usize,
    pub percentage: f32,
    pub speed_mb_s: f32,
    pub status: String, // "connecting" | "pushing" | "completed" | "error"
    pub error_message: Option<String>,
}

static CUSTOM_ADB_PATH: Mutex<Option<PathBuf>> = Mutex::new(None);
static FILE_LIST_CACHE: std::sync::LazyLock<Mutex<HashMap<(String, String), (Instant, Vec<RemoteFileItem>)>>> =
    std::sync::LazyLock::new(|| Mutex::new(HashMap::new()));
const FILE_CACHE_TTL: Duration = Duration::from_secs(5);

pub fn get_cached_device_files(serial: &str, path: &str) -> Option<Vec<RemoteFileItem>> {
    let cache = FILE_LIST_CACHE.lock().ok()?;
    let key = (serial.to_string(), path.to_string());
    if let Some((timestamp, items)) = cache.get(&key) {
        if timestamp.elapsed() < FILE_CACHE_TTL {
            return Some(items.clone());
        }
    }
    None
}

pub fn set_cached_device_files(serial: &str, path: &str, items: Vec<RemoteFileItem>) {
    if let Ok(mut cache) = FILE_LIST_CACHE.lock() {
        cache.retain(|_, (t, _)| t.elapsed() < Duration::from_secs(30));
        let key = (serial.to_string(), path.to_string());
        cache.insert(key, (Instant::now(), items));
    }
}

pub fn invalidate_device_files_cache(serial: &str, path: Option<&str>) {
    if let Ok(mut cache) = FILE_LIST_CACHE.lock() {
        if let Some(target_path) = path {
            let norm = target_path.trim_end_matches('/').to_string();
            let parent = match norm.rfind('/') {
                Some(0) => "/".to_string(),
                Some(idx) => norm[..idx].to_string(),
                None => "".to_string(),
            };
            cache.retain(|(s, p), _| {
                if s != serial {
                    return true;
                }
                !(p == &norm || (!parent.is_empty() && p == &parent) || p.starts_with(&norm))
            });
        } else {
            cache.retain(|(s, _), _| s != serial);
        }
    }
}


#[cfg(target_os = "windows")]
const ADB_FILE_NAME: &str = "adb.exe";
#[cfg(not(target_os = "windows"))]
const ADB_FILE_NAME: &str = "adb";

// Find ADB binary: user defined path, bundled copy next to the executable, system PATH, Android SDK.
// The current working directory is deliberately never searched: a planted adb.exe in e.g. Downloads
// would otherwise be executed on every launch.
pub fn find_adb_path() -> Result<PathBuf, String> {
    if let Ok(guard) = CUSTOM_ADB_PATH.lock() {
        if let Some(ref path) = *guard {
            if path.is_file() {
                return Ok(path.clone());
            }
        }
    }

    // Bundled copy next to the current executable (installer / portable / tauri dev layouts)
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidates = [
                exe_dir.join("bin").join(ADB_FILE_NAME),
                exe_dir.join("_up_").join("bin").join(ADB_FILE_NAME),
                exe_dir.join("resources").join("bin").join(ADB_FILE_NAME),
                exe_dir.join("resources").join(ADB_FILE_NAME),
                exe_dir.join(ADB_FILE_NAME),
            ];
            for candidate in candidates {
                if candidate.is_file() {
                    return Ok(candidate);
                }
            }
        }
    }

    // Development builds and `cargo test`: repository bin/ folder (absolute, resolved at compile time)
    #[cfg(debug_assertions)]
    {
        let repo_bin = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("bin").join(ADB_FILE_NAME);
        if repo_bin.is_file() {
            return Ok(repo_bin);
        }
    }

    // System PATH (only absolute entries, so "." or empty entries can't point at the working directory)
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            if !dir.is_absolute() {
                continue;
            }
            let candidate = dir.join(ADB_FILE_NAME);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }

    // Check system Android SDK
    #[cfg(target_os = "windows")]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let android_sdk = Path::new(&local_app_data).join("Android").join("Sdk").join("platform-tools").join("adb.exe");
            if android_sdk.exists() {
                return Ok(android_sdk);
            }
        }
    }

    Err("ADB бинарник не найден. Пожалуйста, укажите путь к adb.exe или скачайте platform-tools.".to_string())
}

pub fn quote_posix_path(p: &str) -> String {
    format!("'{}'", p.replace('\'', "'\\''"))
}

pub async fn execute_adb_command_async(args: &[&str], timeout_secs: u64) -> Result<String, String> {
    let adb_path = find_adb_path()?;
    
    let mut cmd = tokio::process::Command::new(&adb_path);
    cmd.args(args);
    
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    cmd.kill_on_drop(true);

    match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output()).await {
        Ok(Ok(output)) => {
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();

            if !output.status.success() {
                let err_text = if !stderr.trim().is_empty() {
                    stderr.trim().to_string()
                } else {
                    stdout.trim().to_string()
                };
                return Err(err_text);
            }
            Ok(stdout)
        }
        Ok(Err(e)) => Err(format!("Ошибка запуска ADB: {}", e)),
        Err(_) => Err("Превышено время ожидания ответа устройства (таймаут). Убедитесь, что экран устройства включен и в настройках активна «Отладка по ADB».".to_string()),
    }
}

#[tauri::command]
pub async fn check_adb_status() -> Result<String, String> {
    let path = find_adb_path()?;
    let version_out = execute_adb_command_async(&["version"], 10).await?;
    let first_line = version_out.lines().next().unwrap_or("Android Debug Bridge").to_string();
    Ok(format!("{} ({})", first_line, path.display()))
}

const CUSTOM_ADB_PATH_FILE: &str = "adb_path.txt";

fn custom_adb_path_file(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join(CUSTOM_ADB_PATH_FILE))
}

/// Restores the user-selected adb path saved by `set_custom_adb_path` (called once at startup).
pub fn load_custom_adb_path(app: &AppHandle) {
    let Some(file) = custom_adb_path_file(app) else { return };
    let Ok(saved) = std::fs::read_to_string(&file) else { return };
    let p = PathBuf::from(saved.trim());
    if p.is_absolute() && p.is_file() {
        if let Ok(mut guard) = CUSTOM_ADB_PATH.lock() {
            *guard = Some(p);
        }
    }
}

#[tauri::command]
pub async fn set_custom_adb_path(app: AppHandle, path: String) -> Result<String, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_absolute() || !p.is_file() {
        return Err("Указанный файл не существует".to_string());
    }
    let is_adb_name = p
        .file_stem()
        .map(|s| s.to_string_lossy().eq_ignore_ascii_case("adb"))
        .unwrap_or(false);
    if !is_adb_name {
        return Err("Выберите исполняемый файл adb (adb.exe)".to_string());
    }

    let previous = CUSTOM_ADB_PATH.lock().map_err(|e| e.to_string())?.replace(p.clone());

    // Make sure the chosen binary really is ADB; otherwise roll back to the previous setting
    let status = match check_adb_status().await {
        Ok(s) if s.contains("Android Debug Bridge") => s,
        other => {
            if let Ok(mut guard) = CUSTOM_ADB_PATH.lock() {
                *guard = previous;
            }
            return Err(match other {
                Err(e) => format!("Файл не является рабочим ADB: {}", e),
                Ok(_) => "Файл не является рабочим ADB".to_string(),
            });
        }
    };

    if let Some(file) = custom_adb_path_file(&app) {
        if let Some(dir) = file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(&file, p.to_string_lossy().as_bytes());
    }

    Ok(status)
}

pub fn get_local_listening_ports_with_pids() -> (HashSet<u16>, HashMap<u16, u32>) {
    let mut ports = HashSet::new();
    let mut port_to_pid = HashMap::new();

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        // Absolute path: a bare "netstat" would also be looked up in the application directory
        let system_root = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let mut cmd = Command::new(system_root.join("System32").join("NETSTAT.EXE"));
        cmd.args(&["-ano", "-p", "tcp"]);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        if let Ok(output) = cmd.output() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            for line in stdout.lines() {
                if line.contains("LISTENING") {
                    let parts: Vec<&str> = line.split_whitespace().collect();
                    if parts.len() >= 4 {
                        let pid_opt = parts.last().and_then(|p| p.parse::<u32>().ok());
                        if let Some(addr) = parts.get(1) {
                            let port_str = if let Some(p) = addr.strip_prefix("127.0.0.1:") {
                                Some(p)
                            } else if let Some(p) = addr.strip_prefix("0.0.0.0:") {
                                Some(p)
                            } else if let Some(p) = addr.strip_prefix("[::]:") {
                                Some(p)
                            } else if let Some(p) = addr.strip_prefix("[::1]:") {
                                Some(p)
                            } else {
                                None
                            };

                            if let Some(ps) = port_str {
                                if let Ok(port) = ps.parse::<u16>() {
                                    ports.insert(port);
                                    if let Some(pid) = pid_opt {
                                        port_to_pid.insert(port, pid);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    (ports, port_to_pid)
}

/// Checks whether a given TCP port matches known Android emulator patterns:
/// - MuMu Player 12 / Pro: base 16384, step 32 (instances 0..128: 16384..=20480)
/// - MuMu legacy port: 7555
/// - Standard Android Studio, LDPlayer, BlueStacks, Genymotion: 5554..=5754
/// - Nox App Player: 62001, 62025..=62099
/// - MEmu App Player: 21503..=21903 (step 10)
pub fn is_known_emulator_port(port: u16) -> bool {
    // 1. MuMu 12 / Pro (base 16384, step 32, up to 128 instances)
    if (16384..=20480).contains(&port) && (port - 16384) % 32 == 0 {
        return true;
    }
    // 2. MuMu legacy
    if port == 7555 {
        return true;
    }
    // 3. Standard Android Studio, LDPlayer, BlueStacks, Genymotion (5554..=5754)
    if (5554..=5754).contains(&port) {
        return true;
    }
    // 4. Nox App Player (62001, 62025..=62099)
    if port == 62001 || (62025..=62099).contains(&port) {
        return true;
    }
    // 5. MEmu App Player (21503..=21903, step 10)
    if (21503..=21903).contains(&port) && (port - 21503) % 10 == 0 {
        return true;
    }
    false
}

pub fn emulator_port_priority(port: u16) -> i32 {
    // 1. MuMu 12 / Pro primary port: 16384, 16416, 16448, 16480, ... (base 16384, step 32)
    if (16384..=20480).contains(&port) && (port - 16384) % 32 == 0 {
        return 100;
    }
    // 2. MEmu main ports
    if (21503..=21903).contains(&port) && (port - 21503) % 10 == 0 {
        return 80;
    }
    // 3. Nox main ports
    if port == 62001 || (62025..=62099).contains(&port) {
        return 80;
    }
    // 4. Standard adb port 5555
    if port == 5555 {
        return 75;
    }
    // 5. Ports in 5554..=5754 (e.g. 5557, 5559, 5561, 5565, 5567 mirror ports)
    if (5554..=5754).contains(&port) {
        return 20;
    }
    // 6. MuMu legacy mirror port 7555
    if port == 7555 {
        return 10;
    }
    30
}

pub fn emulator_priority(serial: &str) -> i32 {
    if let Some(port_str) = serial.strip_prefix("127.0.0.1:").or_else(|| serial.strip_prefix("localhost:")) {
        if let Ok(port) = port_str.parse::<u16>() {
            return emulator_port_priority(port);
        }
    }
    if serial.starts_with("emulator-") {
        // Native Android Studio emulator connection
        return 90;
    }
    40
}

// Auto-detect and connect local emulators running on 127.0.0.1 that are NOT yet connected
pub async fn auto_connect_unconnected_emulators(
    connected_serials: &[String],
    listening_ports: &HashSet<u16>,
    port_to_pid: &HashMap<u16, u32>,
) -> usize {
    let candidate_ports: Vec<u16> = if !listening_ports.is_empty() {
        listening_ports
            .iter()
            .copied()
            .filter(|&p| is_known_emulator_port(p))
            .collect()
    } else {
        // Fallback if netstat is unavailable: check first 32 MuMu instances and standard ports
        let mut fallback = Vec::new();
        for i in 0..32 {
            fallback.push(16384 + i * 32);
        }
        for p in 5554..=5584 {
            fallback.push(p);
        }
        fallback.push(7555);
        fallback.push(62001);
        fallback
    };

    // 1. Identify all PIDs associated with primary MuMu 16xxx ports (listening or already connected)
    let mut mumu_16xxx_pids: HashSet<u32> = HashSet::new();
    for &port in &candidate_ports {
        if (16384..=20480).contains(&port) && (port - 16384) % 32 == 0 {
            if let Some(&pid) = port_to_pid.get(&port) {
                mumu_16xxx_pids.insert(pid);
            }
        }
    }
    for s in connected_serials {
        if let Some(port_str) = s.strip_prefix("127.0.0.1:16") {
            if let Ok(p_num) = format!("16{}", port_str).parse::<u16>() {
                if let Some(&pid) = port_to_pid.get(&p_num) {
                    mumu_16xxx_pids.insert(pid);
                }
            }
        }
    }

    let has_any_mumu_16xxx = !mumu_16xxx_pids.is_empty()
        || listening_ports.iter().any(|&p| (16384..=20480).contains(&p) && (p - 16384) % 32 == 0)
        || connected_serials.iter().any(|s| s.starts_with("127.0.0.1:16"));

    // 2. Group candidate ports by PID where available
    let mut pid_groups: HashMap<u32, Vec<u16>> = HashMap::new();
    let mut no_pid_ports: Vec<u16> = Vec::new();

    for &port in &candidate_ports {
        // If port shares a PID with any MuMu 16xxx instance and is NOT the 16xxx port itself, drop it!
        if let Some(&pid) = port_to_pid.get(&port) {
            let is_mumu_16xxx = (16384..=20480).contains(&port) && (port - 16384) % 32 == 0;
            if mumu_16xxx_pids.contains(&pid) && !is_mumu_16xxx {
                // Discard secondary/mirror port of MuMu!
                continue;
            }
            pid_groups.entry(pid).or_default().push(port);
        } else {
            // Fallback heuristics when PID mapping is unavailable:
            if has_any_mumu_16xxx && (port == 7555 || (5554..=5754).contains(&port)) {
                continue;
            }
            no_pid_ports.push(port);
        }
    }

    // 3. For each PID, select exactly ONE primary port
    let mut selected_ports: Vec<u16> = Vec::new();

    for (_pid, mut ports) in pid_groups {
        ports.sort_by(|a, b| emulator_port_priority(*b).cmp(&emulator_port_priority(*a)));
        if let Some(&best_port) = ports.first() {
            selected_ports.push(best_port);
        }
    }
    selected_ports.extend(no_pid_ports);

    // 4. Filter against already connected devices
    let to_connect: Vec<u16> = selected_ports
        .into_iter()
        .filter(|&port| {
            // If emulator-X is already connected, don't connect its adb port X+1 (e.g. emulator-5554 -> port 5555)
            if port > 0 && connected_serials.iter().any(|s| s == &format!("emulator-{}", port - 1)) {
                return false;
            }
            // Ensure port is actually listening
            if !listening_ports.is_empty() && !listening_ports.contains(&port) {
                return false;
            }
            let addr_str = format!("127.0.0.1:{}", port);
            let emu_str = format!("emulator-{}", port);
            !connected_serials.iter().any(|s| s == &addr_str || s == &emu_str)
        })
        .collect();

    if to_connect.is_empty() {
        return 0;
    }

    let mut set = tokio::task::JoinSet::new();

    for port in to_connect {
        set.spawn(async move {
            let host_arg = format!("127.0.0.1:{}", port);
            let res = execute_adb_command_async(&["connect", &host_arg], 3).await;
            if let Ok(out) = res {
                if out.contains("connected") && !out.contains("unable") && !out.contains("failed") {
                    return true;
                }
            }
            false
        });
    }

    let mut connected_count = 0;
    while let Some(res) = set.join_next().await {
        if let Ok(true) = res {
            connected_count += 1;
        }
    }

    connected_count
}

pub fn is_emulator_serial(serial: &str) -> bool {
    serial.starts_with("127.0.0.1:")
        || serial.starts_with("localhost:")
        || serial.starts_with("emulator-")
}

pub async fn get_device_identity(serial: &str) -> Option<String> {
    // 1. Primary: query android_id (unique per Android instance data partition)
    let res = execute_adb_command_async(
        &["-s", serial, "shell", "settings", "get", "secure", "android_id"],
        3,
    ).await;

    if let Ok(out) = res {
        let trimmed = out.trim();
        if !trimmed.is_empty()
            && trimmed != "null"
            && !trimmed.contains("not found")
            && !trimmed.contains("error")
            && !trimmed.contains("device offline")
            && !trimmed.contains("closed")
        {
            return Some(trimmed.to_string());
        }
    }

    // 2. Fallback: ro.boot.serialno or ro.serialno
    if let Ok(out) = execute_adb_command_async(&["-s", serial, "shell", "getprop", "ro.boot.serialno"], 2).await {
        let trimmed = out.trim();
        if !trimmed.is_empty() && trimmed != "unknown" {
            return Some(trimmed.to_string());
        }
    }
    if let Ok(out) = execute_adb_command_async(&["-s", serial, "shell", "getprop", "ro.serialno"], 2).await {
        let trimmed = out.trim();
        if !trimmed.is_empty() && trimmed != "unknown" {
            return Some(trimmed.to_string());
        }
    }

    // 3. Fallback: eth0 MAC address
    if let Ok(out) = execute_adb_command_async(&["-s", serial, "shell", "cat", "/sys/class/net/eth0/address"], 2).await {
        let trimmed = out.trim();
        if !trimmed.is_empty() && trimmed.contains(':') && !trimmed.contains("No such") {
            return Some(trimmed.to_string());
        }
    }

    None
}

pub fn resolve_emulator_pid(dev: &DeviceInfo, port_to_pid: &HashMap<u16, u32>) -> Option<u32> {
    if let Some(port) = dev.port {
        if let Some(&pid) = port_to_pid.get(&port) {
            return Some(pid);
        }
    }
    if let Some(emu_num) = dev.serial.strip_prefix("emulator-") {
        if let Ok(console_p) = emu_num.parse::<u16>() {
            if let Some(&pid) = port_to_pid.get(&console_p) {
                return Some(pid);
            }
            if let Some(&pid) = port_to_pid.get(&(console_p + 1)) {
                return Some(pid);
            }
        }
    }
    None
}

pub fn deduplicate_emulator_devices(
    emulator_devs: Vec<DeviceInfo>,
    port_to_pid: &HashMap<u16, u32>,
    identities: &HashMap<String, String>,
) -> (Vec<DeviceInfo>, Vec<String>) {
    if emulator_devs.is_empty() {
        return (Vec::new(), Vec::new());
    }
    if emulator_devs.len() == 1 {
        return (emulator_devs, Vec::new());
    }

    let emu_serials: HashSet<String> = emulator_devs.iter().map(|d| d.serial.clone()).collect();
    let mut groups: HashMap<String, Vec<DeviceInfo>> = HashMap::new();

    for dev in emulator_devs {
        let instance_id = if let Some(pid) = resolve_emulator_pid(&dev, port_to_pid) {
            format!("pid-{}", pid)
        } else if let Some(id) = identities.get(&dev.serial) {
            format!("id-{}", id)
        } else {
            // Heuristic fallbacks if adb shell identity query failed:
            let mut resolved = None;

            // a) emulator-P vs 127.0.0.1:(P+1)
            if let Some(port_str) = dev.serial.strip_prefix("127.0.0.1:").or_else(|| dev.serial.strip_prefix("localhost:")) {
                if let Ok(port) = port_str.parse::<u16>() {
                    if port > 0 {
                        let emu_name = format!("emulator-{}", port - 1);
                        if emu_serials.contains(&emu_name) {
                            resolved = Some(format!("instance-emu-{}", port - 1));
                        }
                    }
                }
            } else if let Some(emu_num) = dev.serial.strip_prefix("emulator-") {
                if let Ok(console_p) = emu_num.parse::<u16>() {
                    let tcp_name = format!("127.0.0.1:{}", console_p + 1);
                    if emu_serials.contains(&tcp_name) {
                        resolved = Some(format!("instance-emu-{}", console_p));
                    }
                }
            }

            resolved.unwrap_or_else(|| format!("unique-{}", dev.serial))
        };

        groups.entry(instance_id).or_default().push(dev);
    }

    let mut kept = Vec::new();
    let mut mirrors_to_disconnect = Vec::new();

    for (_id, mut group_devs) in groups {
        // Sort by priority descending: highest priority first
        group_devs.sort_by(|a, b| {
            emulator_priority(&b.serial).cmp(&emulator_priority(&a.serial))
        });

        // The first device is the primary connection
        if let Some(primary) = group_devs.first() {
            kept.push(primary.clone());
        }

        // All other connections are redundant mirror ports
        for mirror in &group_devs[1..] {
            if mirror.serial.contains(':') {
                mirrors_to_disconnect.push(mirror.serial.clone());
            }
        }
    }

    (kept, mirrors_to_disconnect)
}

#[tauri::command]
pub async fn get_connected_devices() -> Result<Vec<DeviceInfo>, String> {
    let (listening_ports, port_to_pid) = get_local_listening_ports_with_pids();

    // 1. Fetch current adb devices -l
    let output = execute_adb_command_async(&["devices", "-l"], 4).await?;
    let mut initial_serials = Vec::new();
    let mut offline_serials = Vec::new();

    for line in output.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("List of devices") || line.starts_with("* daemon") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() >= 2 {
            let serial = parts[0];
            let state = parts[1];
            if state == "device" {
                initial_serials.push(serial.to_string());
            } else if state == "offline" {
                offline_serials.push(serial.to_string());
            }
        }
    }

    // Identify PIDs of MuMu 16xxx ports
    let mut mumu_16xxx_pids: HashSet<u32> = HashSet::new();
    for &port in &listening_ports {
        if (16384..=20480).contains(&port) && (port - 16384) % 32 == 0 {
            if let Some(&pid) = port_to_pid.get(&port) {
                mumu_16xxx_pids.insert(pid);
            }
        }
    }

    // Prune or reconnect offline devices (concurrently, so N offline devices don't add N * 2s to every refresh):
    let mut offline_set = tokio::task::JoinSet::new();
    for offline in offline_serials {
        let action = if let Some(port_str) = offline.strip_prefix("127.0.0.1:") {
            match port_str.parse::<u16>() {
                Ok(port) => {
                    let is_mumu_16xxx = (16384..=20480).contains(&port) && (port - 16384) % 32 == 0;
                    let is_mirror_port = port_to_pid.get(&port).map_or(false, |pid| mumu_16xxx_pids.contains(pid)) && !is_mumu_16xxx;
                    // Port no longer listening or a redundant mirror port: disconnect; otherwise reconnect
                    if !listening_ports.contains(&port) || is_mirror_port { "disconnect" } else { "connect" }
                }
                Err(_) => continue,
            }
        } else if offline.contains(':') {
            // Remote Wi-Fi/LAN device: attempt reconnection so transient disconnects recover
            "connect"
        } else {
            continue;
        };
        offline_set.spawn(async move {
            let _ = execute_adb_command_async(&[action, &offline], 2).await;
        });
    }
    while offline_set.join_next().await.is_some() {}

    // 2. Auto-connect ONLY unconnected local emulators that are listening
    let new_connected = auto_connect_unconnected_emulators(&initial_serials, &listening_ports, &port_to_pid).await;

    // 3. If any new emulator was connected, re-fetch devices list, otherwise reuse current output
    let effective_output = if new_connected > 0 {
        execute_adb_command_async(&["devices", "-l"], 4).await.unwrap_or(output)
    } else {
        output
    };

    let mut raw_devices = Vec::new();
    for line in effective_output.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("List of devices") || line.starts_with("* daemon") {
            continue;
        }

        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 2 {
            continue;
        }

        let serial = parts[0].to_string();
        let state = parts[1].to_string();

        // Accept all valid active states: "device", "unauthorized", "offline", etc.
        if state.is_empty() {
            continue;
        }

        let is_emulator = serial.starts_with("emulator-")
            || serial.starts_with("127.0.0.1:")
            || serial.starts_with("localhost:");

        let is_wifi = serial.contains(':') && !is_emulator;

        let (ip, port) = if serial.contains(':') {
            let segs: Vec<&str> = serial.split(':').collect();
            let ip_part = segs.first().map(|s| s.to_string());
            let port_part = segs.get(1).and_then(|p| p.parse::<u16>().ok());
            (ip_part, port_part)
        } else {
            (None, None)
        };

        let mut model = "Unknown Model".to_string();
        let mut product = "Unknown Product".to_string();

        for part in &parts[2..] {
            if let Some(m) = part.strip_prefix("model:") {
                model = m.replace('_', " ");
            } else if let Some(p) = part.strip_prefix("product:") {
                product = p.replace('_', " ");
            }
        }

        if model == "Unknown Model" && is_wifi {
            model = format!("Android ({})", serial);
        }

        let device_type = if is_emulator {
            "emulator".to_string()
        } else if is_wifi {
            "wifi".to_string()
        } else {
            "usb".to_string()
        };

        raw_devices.push(DeviceInfo {
            serial,
            model,
            product,
            device_type,
            state,
            ip,
            port,
        });
    }

    // 4. Deduplicate emulators:
    let (emulator_devs, non_emulator_devs): (Vec<DeviceInfo>, Vec<DeviceInfo>) =
        raw_devices.into_iter().partition(|d| is_emulator_serial(&d.serial));

    let mut devices = non_emulator_devs;

    if emulator_devs.is_empty() {
        return Ok(devices);
    }

    if emulator_devs.len() == 1 {
        devices.extend(emulator_devs);
        return Ok(devices);
    }

    // For any emulator whose port cannot be resolved via port_to_pid, query get_device_identity fallback:
    let mut fallback_identities: HashMap<String, String> = HashMap::new();
    let mut needs_identity_query = Vec::new();
    for dev in &emulator_devs {
        if resolve_emulator_pid(dev, &port_to_pid).is_none() && dev.state == "device" {
            needs_identity_query.push(dev.serial.clone());
        }
    }

    if !needs_identity_query.is_empty() {
        let mut set = tokio::task::JoinSet::new();
        for serial in needs_identity_query {
            set.spawn(async move {
                let id = get_device_identity(&serial).await;
                (serial, id)
            });
        }
        while let Some(res) = set.join_next().await {
            if let Ok((serial, Some(id))) = res {
                fallback_identities.insert(serial, id);
            }
        }
    }

    let (kept_emulators, mirrors_to_disconnect) =
        deduplicate_emulator_devices(emulator_devs, &port_to_pid, &fallback_identities);

    devices.extend(kept_emulators);

    // Disconnect redundant mirror ports concurrently
    if !mirrors_to_disconnect.is_empty() {
        let mut disconnect_set = tokio::task::JoinSet::new();
        for mirror_serial in mirrors_to_disconnect {
            disconnect_set.spawn(async move {
                let _ = execute_adb_command_async(&["disconnect", &mirror_serial], 2).await;
            });
        }
        while let Some(_) = disconnect_set.join_next().await {}
    }

    Ok(devices)
}

#[tauri::command]
pub async fn connect_device(host: String) -> Result<String, String> {
    let host = host.trim();
    if host.is_empty() {
        return Err("Адрес хоста не может быть пустым".to_string());
    }
    let is_loopback = host.starts_with("127.0.0.1") || host.starts_with("localhost");
    let port = host.split(':').nth(1).and_then(|p| p.parse::<u16>().ok()).unwrap_or(5555);
    let pairing_hint = "Устройство требует первичного сопряжения по коду безопасности (Android 11+ Беспроводная отладка). Нажмите «Сопряжение» и введите 6-значный код.";

    let res = match execute_adb_command_async(&["connect", host], 8).await {
        Ok(out) => out,
        Err(err) => {
            if !is_loopback && port != 5555 {
                let err_lower = err.to_lowercase();
                if err_lower.contains("failed")
                    || err_lower.contains("unable")
                    || err_lower.contains("cannot")
                    || err_lower.contains("refused")
                {
                    return Err(pairing_hint.to_string());
                }
            }
            return Err(err);
        }
    };

    let res_lower = res.to_lowercase();
    let is_connected = (res_lower.contains("connected") || res_lower.contains("already connected"))
        && !res_lower.contains("cannot connect")
        && !res_lower.contains("unable to connect")
        && !res_lower.contains("failed to connect");

    if !is_connected {
        if !is_loopback && port != 5555 {
            return Err(pairing_hint.to_string());
        }
        return Err(res.trim().to_string());
    }

    // Check device state
    if let Ok(state) = execute_adb_command_async(&["-s", host, "get-state"], 3).await {
        let state = state.trim();
        if state.contains("unauthorized") {
            return Ok(format!("Подключено к {}, но устройство ожидает авторизации! Нажмите «Разрешить отладку» на экране телефона.", host));
        }
    }

    Ok(res.trim().to_string())
}

/// Connects to the given LAN hosts in parallel. Invoked only by an explicit user action
/// ("Подключить все"); returns the hosts that are connected afterwards (including already connected ones).
#[tauri::command]
pub async fn connect_lan_devices(hosts: Vec<String>) -> Result<Vec<String>, String> {
    if hosts.is_empty() {
        return Ok(Vec::new());
    }

    // 1. Fetch currently connected device serials to avoid re-connecting existing devices
    let connected_serials: HashSet<String> = match execute_adb_command_async(&["devices"], 2).await {
        Ok(out) => out
            .lines()
            .skip(1)
            .filter_map(|l| {
                let parts: Vec<&str> = l.split_whitespace().collect();
                if parts.len() >= 2 && (parts[1] == "device" || parts[1] == "unauthorized") {
                    Some(parts[0].to_string())
                } else {
                    None
                }
            })
            .collect(),
        Err(_) => HashSet::new(),
    };

    // 2. Filter and normalize candidate hosts
    let mut candidate_hosts = Vec::new();
    let mut already_connected = Vec::new();
    let mut seen = HashSet::new();

    for raw_host in hosts {
        let trimmed = raw_host.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Normalize: append port 5555 if only IP was given
        let host = if trimmed.contains(':') {
            trimmed.to_string()
        } else {
            format!("{}:5555", trimmed)
        };

        // Filter out local loopback (127.0.0.1, localhost, ::1, 0.0.0.0)
        let is_loopback = host.starts_with("127.0.0.1")
            || host.starts_with("localhost")
            || host.starts_with("::1")
            || host.starts_with("0.0.0.0");
        if is_loopback {
            continue;
        }

        if !seen.insert(host.clone()) {
            continue;
        }

        // Hosts already connected need no new connection attempt
        if connected_serials.contains(&host) {
            already_connected.push(host);
        } else {
            candidate_hosts.push(host);
        }
    }

    if candidate_hosts.is_empty() {
        already_connected.sort();
        return Ok(already_connected);
    }

    // 3. Connect candidate hosts concurrently with a concurrency limit of 8
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(8));
    let mut set = tokio::task::JoinSet::new();

    for host in candidate_hosts {
        let sem = semaphore.clone();
        set.spawn(async move {
            let _permit = match sem.acquire().await {
                Ok(p) => p,
                Err(_) => return None,
            };

            // 3-second timeout per connection attempt
            let res = execute_adb_command_async(&["connect", &host], 3).await;
            match res {
                Ok(out) => {
                    let out_lower = out.to_lowercase();
                    let is_connected = (out_lower.contains("connected") || out_lower.contains("already connected"))
                        && !out_lower.contains("cannot connect")
                        && !out_lower.contains("unable to connect")
                        && !out_lower.contains("failed")
                        && !out_lower.contains("refused");
                    if is_connected {
                        Some(host)
                    } else {
                        None
                    }
                }
                Err(_) => None,
            }
        });
    }

    let mut successfully_connected = already_connected;
    while let Some(res) = set.join_next().await {
        if let Ok(Some(host)) = res {
            successfully_connected.push(host);
        }
    }

    successfully_connected.sort();
    Ok(successfully_connected)
}

#[tauri::command]
pub async fn disconnect_device(serial: String) -> Result<String, String> {
    let serial = serial.trim();
    let res = execute_adb_command_async(&["disconnect", serial], 5).await?;
    Ok(res.trim().to_string())
}

#[tauri::command]
pub async fn pair_device(host: String, code: String) -> Result<String, String> {
    let host = host.trim();
    let code = code.trim();
    if host.is_empty() || code.is_empty() {
        return Err("Требуется указать хост (IP:порт) и код сопряжения".to_string());
    }
    let res = execute_adb_command_async(&["pair", host, code], 8).await?;
    if res.contains("Failed:") || res.contains("failed") {
        return Err(res.trim().to_string());
    }
    Ok(res.trim().to_string())
}

#[tauri::command]
pub async fn switch_to_tcpip(serial: String, port: Option<u16>) -> Result<String, String> {
    let p = port.unwrap_or(5555).to_string();
    let res = execute_adb_command_async(&["-s", &serial, "tcpip", &p], 6).await?;
    Ok(res.trim().to_string())
}

pub fn is_directory_item(perms: &str, name: &str, symlink_target: Option<&str>) -> bool {
    if perms.starts_with('d') {
        return true;
    }
    if perms.starts_with('l') {
        let name_lower = name.to_lowercase();
        // Standard Android symlinks to directories
        if name_lower == "sdcard"
            || name_lower == "storage"
            || name_lower == "self"
            || name_lower == "mnt"
            || name_lower == "data"
            || name_lower == "etc"
            || name_lower == "vendor"
            || name_lower == "system"
            || name_lower == "d"
        {
            return true;
        }

        if let Some(target) = symlink_target {
            let t = target.trim();
            if t.ends_with('/') {
                return true;
            }
            let t_lower = t.to_lowercase();
            if t_lower.starts_with("/storage")
                || t_lower.starts_with("/mnt")
                || t_lower.starts_with("/data")
                || t_lower.starts_with("/sys")
                || t_lower.starts_with("/system")
                || t_lower.contains("/sdcard")
                || t_lower.contains("/emulated/")
            {
                let last_segment = t.rsplit('/').next().unwrap_or(t);
                if !last_segment.contains('.') {
                    return true;
                }
            }
        }
    }
    false
}

pub fn parse_ls_output(output: &str, query_path: &str) -> Vec<RemoteFileItem> {
    // The name is everything after the single space that follows the timestamp. It must NOT be trimmed:
    // "Photos " and "Photos" are different directories, and trimming would make actions on the first
    // one (including delete) hit the second.
    static LS_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^([d\-lspcb][rwx\-stST]{9})[.+@]?\s+\d+\s+\S+\s+\S+\s+(\d+)?\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}|\w{3}\s+\d+\s+[\d:]{4,5}) (.+)$").unwrap()
    });
    static PERMS_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(r"^[d\-lspcb][rwx\-stST]{9}[.+@]?$").unwrap()
    });

    let mut items = Vec::new();

    for raw_line in output.lines() {
        // Strip only the CR of CRLF output and indentation; trailing spaces belong to the file name
        let line = raw_line.trim_end_matches('\r').trim_start();
        if line.trim().is_empty() || line.starts_with("total ") {
            continue;
        }

        if let Some(caps) = LS_RE.captures(line) {
            let perms = caps.get(1).map_or("", |m| m.as_str());
            let size: u64 = caps.get(2).and_then(|m| m.as_str().parse().ok()).unwrap_or(0);
            let mtime = caps.get(3).map_or("", |m| m.as_str()).to_string();
            let raw_name = caps.get(4).map_or("", |m| m.as_str()).to_string();

            let is_symlink = perms.starts_with('l');
            let (name, symlink_target) = if is_symlink {
                if let Some(pos) = raw_name.find(" -> ") {
                    let n = raw_name[..pos].to_string();
                    let target = raw_name[pos + 4..].to_string();
                    (n, Some(target))
                } else {
                    (raw_name, None)
                }
            } else {
                (raw_name, None)
            };

            // Names containing '/' can only come from malformed output (e.g. a file name with a newline)
            if name.contains('/') {
                continue;
            }

            let clean_name = name.trim_start_matches('/');
            let clean_query = query_path.trim_start_matches('/');
            if name == "." || name == ".." || name.is_empty() || clean_name == clean_query || name == query_path {
                continue;
            }

            let is_dir = is_directory_item(perms, &name, symlink_target.as_deref());
            let item_path = if query_path == "/" {
                format!("/{}", name)
            } else {
                format!("{}/{}", query_path.trim_end_matches('/'), name)
            };

            items.push(RemoteFileItem {
                name,
                path: item_path,
                is_dir,
                size,
                mtime,
                permissions: perms.to_string(),
            });
        } else {
            // Fallback parser if ls output format slightly differs (e.g. device nodes "1, 3").
            // Only accepted for lines that start with a permissions column, so continuation lines of
            // file names containing a newline can't turn into fake entries.
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() >= 6 && PERMS_RE.is_match(parts[0]) {
                let first = parts[0];
                let is_symlink = first.starts_with('l');
                let name_candidate = if parts.len() >= 8 && parts[parts.len() - 2].contains(':') {
                    parts[parts.len() - 1..].join(" ")
                } else {
                    parts[parts.len() - 1].to_string()
                };

                let (name, symlink_target) = if is_symlink {
                    if let Some(pos) = name_candidate.find(" -> ") {
                        let n = name_candidate[..pos].trim().to_string();
                        let target = name_candidate[pos + 4..].trim().to_string();
                        (n, Some(target))
                    } else {
                        (name_candidate.trim().to_string(), None)
                    }
                } else {
                    (name_candidate.trim().to_string(), None)
                };

                let clean_name = name.trim_start_matches('/');
                let clean_query = query_path.trim_start_matches('/');
                if name == "." || name == ".." || name.is_empty() || clean_name == clean_query || name == query_path {
                    continue;
                }

                let is_dir = is_directory_item(first, &name, symlink_target.as_deref());
                let item_path = if query_path == "/" {
                    format!("/{}", name)
                } else {
                    format!("{}/{}", query_path.trim_end_matches('/'), name)
                };
                items.push(RemoteFileItem {
                    name,
                    path: item_path,
                    is_dir,
                    size: parts.get(4).and_then(|s| s.parse().ok()).unwrap_or(0),
                    mtime: "".to_string(),
                    permissions: first.to_string(),
                });
            }
        }
    }

    // Sort: directories first, then alphabetical
    items.sort_by(|a, b| {
        if a.is_dir && !b.is_dir {
            std::cmp::Ordering::Less
        } else if !a.is_dir && b.is_dir {
            std::cmp::Ordering::Greater
        } else {
            a.name.to_lowercase().cmp(&b.name.to_lowercase())
        }
    });

    items
}

#[tauri::command]
pub async fn list_device_files(serial: String, remote_path: String) -> Result<Vec<RemoteFileItem>, String> {
    let raw = if remote_path.trim().is_empty() { "/sdcard".to_string() } else { remote_path.trim().to_string() };
    let path = raw.trim_end_matches('/').to_string();
    let query_path = if path.is_empty() { "/".to_string() } else { path };

    if let Some(cached) = get_cached_device_files(&serial, &query_path) {
        return Ok(cached);
    }

    let target_cmd_path = if query_path == "/" {
        "/".to_string()
    } else {
        format!("{}/", query_path.trim_end_matches('/'))
    };
    let quoted_path = quote_posix_path(&target_cmd_path);
    
    // Fast direct ls -la with 5s timeout (trailing slash ensures directory contents are listed even if symlink)
    let output = execute_adb_command_async(&["-s", &serial, "shell", "ls", "-la", &quoted_path], 5).await?;

    let items = parse_ls_output(&output, &query_path);

    set_cached_device_files(&serial, &query_path, items.clone());

    Ok(items)
}

#[tauri::command]
pub async fn create_device_folder(serial: String, remote_path: String) -> Result<String, String> {
    let path = remote_path.trim();
    if path.is_empty() {
        return Err("Путь папки не может быть пустым".to_string());
    }
    let quoted = quote_posix_path(path);
    let res = execute_adb_command_async(&["-s", &serial, "shell", "mkdir", "-p", &quoted], 5).await?;
    invalidate_device_files_cache(&serial, Some(path));
    Ok(res)
}

/// Lexically normalizes an absolute device path: collapses duplicate slashes, drops the trailing slash
/// and rejects "." / ".." components (they could make a harmless-looking path resolve to a storage root).
pub fn normalize_device_path(path: &str) -> Result<String, String> {
    if !path.starts_with('/') {
        return Err("Путь на устройстве должен быть абсолютным".to_string());
    }
    let mut parts = Vec::new();
    for comp in path.split('/') {
        match comp {
            "" => continue,
            "." | ".." => return Err("Путь не должен содержать «.» или «..»".to_string()),
            c => parts.push(c),
        }
    }
    Ok(format!("/{}", parts.join("/")))
}

/// Paths whose removal would wipe user storage or break the OS. Expects a normalized absolute path.
/// Comparison is case-insensitive because the emulated storage (/sdcard) is case-insensitive.
pub fn is_protected_device_path(path: &str) -> bool {
    static PROTECTED_RE: std::sync::LazyLock<Regex> = std::sync::LazyLock::new(|| {
        Regex::new(concat!(
            r"^(",
            r"/storage/[^/]+",                       // /storage/emulated, /storage/self, SD cards (/storage/1234-ABCD)
            r"|/storage/emulated/\d+(/android)?",    // user storage roots and their Android/ folder
            r"|/storage/[^/]+/android",              // Android/ folder on SD cards
            r"|/data/[^/]+",                         // /data/data, /data/app, /data/media, /data/local, ...
            r"|/data/(media|user|user_de|misc_ce|misc_de|system_ce|system_de)/\d+",
            r"|/data/local/tmp",
            r"|/mnt(/[^/]+){1,4}",                   // mount points down to /mnt/user/0/emulated/0
            r"|/(system|system_ext|vendor|product|odm|apex|proc|sys|dev|cache|config|metadata|linkerconfig)(/.*)?",
            r")$"
        ))
        .unwrap()
    });
    const PROTECTED: &[&str] = &["/sdcard", "/storage/self/primary", "/storage/emulated/0", "/data/media/0"];

    let p = path.trim_end_matches('/').to_lowercase();
    // Root and every top-level directory (/sdcard, /storage, /data, /mnt, ...)
    if p.matches('/').count() <= 1 {
        return true;
    }
    if PROTECTED_RE.is_match(&p) {
        return true;
    }
    // Ancestors of protected locations
    PROTECTED.iter().any(|prot| *prot == p || prot.starts_with(&format!("{}/", p)))
}

const NOT_FOUND_MARKER: &str = "__TRANSFILE_NOT_FOUND__";

#[tauri::command]
pub async fn delete_device_item(serial: String, remote_path: String) -> Result<String, String> {
    const PROTECTED_MSG: &str = "Нельзя удалить корневую директорию, хранилище или системную папку";

    let norm = normalize_device_path(remote_path.trim())?;
    if is_protected_device_path(&norm) {
        return Err(PROTECTED_MSG.to_string());
    }

    // Resolve symlinks on the device and re-check: both the full path and the location rm will actually
    // act on (resolved parent + name, since rm removes a symlink itself, not its target).
    let (parent, name) = norm.rsplit_once('/').unwrap_or(("", &norm));
    let parent = if parent.is_empty() { "/" } else { parent };
    let q_path = quote_posix_path(&norm);
    let q_parent = quote_posix_path(parent);
    let script = format!(
        "if [ -e {p} ] || [ -L {p} ]; then readlink -f {p}; readlink -f {d}; else echo {nf}; fi",
        p = q_path,
        d = q_parent,
        nf = NOT_FOUND_MARKER
    );
    let resolved = execute_adb_command_async(&["-s", &serial, "shell", &script], 5).await?;
    if resolved.contains(NOT_FOUND_MARKER) {
        return Err("Файл или папка не найдены на устройстве (список устарел?)".to_string());
    }
    let mut lines = resolved.lines().map(|l| l.trim_end_matches('\r')).filter(|l| !l.is_empty());
    let real_path = lines.next().unwrap_or("");
    let real_parent = lines.next().unwrap_or("");
    // Old devices without readlink print nothing useful here; then only the lexical check above applies
    let mut candidates = Vec::new();
    if real_path.starts_with('/') {
        candidates.push(real_path.to_string());
    }
    if real_parent.starts_with('/') {
        candidates.push(format!("{}/{}", real_parent.trim_end_matches('/'), name));
    }
    for candidate in candidates {
        match normalize_device_path(&candidate) {
            Ok(c) if !is_protected_device_path(&c) => {}
            _ => return Err(PROTECTED_MSG.to_string()),
        }
    }

    // Large folders can take a while; 5s used to report a false error while deletion continued
    let res = execute_adb_command_async(&["-s", &serial, "shell", "rm", "-rf", &q_path], 300).await?;
    invalidate_device_files_cache(&serial, Some(&norm));
    Ok(res)
}

// Pull remote file from device to local directory
#[tauri::command]
pub async fn pull_file_from_device(
    app: AppHandle,
    serial: String,
    remote_path: String,
    local_dir: String,
) -> Result<bool, String> {
    let adb_path = find_adb_path()?;
    // Absolute paths only: a value starting with "-" would otherwise be parsed by adb as an option
    let remote_path = normalize_device_path(remote_path.trim())?;
    if !Path::new(&local_dir).is_absolute() || !Path::new(&local_dir).is_dir() {
        return Err("Папка для сохранения не найдена".to_string());
    }
    // Device names are POSIX: split on '/' only ('\' is a valid character in Android file names)
    let file_name = remote_path
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .unwrap_or("downloaded_file")
        .to_string();

    let transfer_id = new_transfer_id("pull");

    let _ = app.emit(
        "transfer-progress",
        TransferProgress {
            transfer_id: transfer_id.clone(),
            file_name: file_name.clone(),
            current_bytes: 0,
            total_bytes: 0,
            percentage: 0.0,
            speed_mb_s: 0.0,
            status: "starting".to_string(),
            error_message: None,
        },
    );

    let start_time = std::time::Instant::now();

    let mut cmd = tokio::process::Command::new(&adb_path);
    cmd.args(&["-s", &serial, "pull", &remote_path, &local_dir]);
    cmd.kill_on_drop(true);

    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let output = cmd.output().await.map_err(|e| e.to_string())?;

    if output.status.success() {
        let local_dest = Path::new(&local_dir).join(&file_name);
        let pulled_size = std::fs::metadata(&local_dest).map(|m| m.len()).unwrap_or(0);
        let elapsed = start_time.elapsed().as_secs_f32().max(0.001);
        let speed_mb_s = (pulled_size as f32 / (1024.0 * 1024.0)) / elapsed;

        let _ = app.emit(
            "transfer-progress",
            TransferProgress {
                transfer_id: transfer_id.clone(),
                file_name: file_name.clone(),
                current_bytes: pulled_size,
                total_bytes: pulled_size,
                percentage: 100.0,
                speed_mb_s,
                status: "completed".to_string(),
                error_message: None,
            },
        );
        Ok(true)
    } else {
        let err_msg = String::from_utf8_lossy(&output.stderr).to_string();
        let _ = app.emit(
            "transfer-progress",
            TransferProgress {
                transfer_id: transfer_id.clone(),
                file_name: file_name.clone(),
                current_bytes: 0,
                total_bytes: 0,
                percentage: 0.0,
                speed_mb_s: 0.0,
                status: "error".to_string(),
                error_message: Some(err_msg.clone()),
            },
        );
        Err(format!("Ошибка скачивания: {}", err_msg))
    }
}

static TRANSFER_SEQ: AtomicU64 = AtomicU64::new(0);

/// Unique transfer id. (`SystemTime::now().elapsed()` is always ~0, so ids used to collide.)
pub fn new_transfer_id(prefix: &str) -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let seq = TRANSFER_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{}-{}-{}", prefix, millis, seq)
}

/// Total size of a file or directory tree. Iterative and does not follow symlinks/junctions,
/// so link loops can't cause infinite recursion (stack overflow -> crash).
fn calculate_path_size(path: &Path) -> u64 {
    let mut total = 0;
    let mut stack = vec![path.to_path_buf()];
    while let Some(p) = stack.pop() {
        let Ok(meta) = std::fs::symlink_metadata(&p) else { continue };
        if meta.is_file() {
            total += meta.len();
        } else if meta.is_dir() {
            if let Ok(entries) = std::fs::read_dir(&p) {
                stack.extend(entries.flatten().map(|e| e.path()));
            }
        }
    }
    total
}

/// Timeout for one `adb push`: generous enough for slow Wi-Fi (assumes at least ~512 KB/s per device,
/// with 6 devices sharing the link), without the old 300s cap that killed multi-GB transfers.
fn push_timeout_secs(size: u64) -> u64 {
    60 + size / (512 * 1024)
}

struct LocalPushItem {
    path: String,
    name: String,
    size: u64,
}

// Push local files/folders to multiple target devices in parallel
#[tauri::command]
pub async fn push_files_to_multiple_devices(
    app: AppHandle,
    targets: Vec<TargetDevice>,
    local_paths: Vec<String>,
    remote_dir: String,
) -> Result<bool, String> {
    if targets.is_empty() {
        return Err("Не выбрано ни одного устройства для отправки".to_string());
    }
    if local_paths.is_empty() {
        return Err("Не выбрано ни одного файла для отправки".to_string());
    }

    let adb_path = find_adb_path()?;
    let remote_dir = normalize_device_path(remote_dir.trim())?;

    // Resolve existing files and their sizes once (not per device), off the async runtime threads.
    // Missing files are dropped up front so per-device progress can actually reach "completed".
    let items: Vec<LocalPushItem> = tokio::task::spawn_blocking(move || {
        local_paths
            .into_iter()
            .filter_map(|p| {
                let path = PathBuf::from(&p);
                // Absolute paths only: a value starting with "-" would be parsed by adb as an option
                if !path.is_absolute() || !path.exists() {
                    return None;
                }
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "file".to_string());
                let size = calculate_path_size(&path);
                Some(LocalPushItem { path: p, name, size })
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?;

    if items.is_empty() {
        return Err("Выбранные файлы не найдены на компьютере".to_string());
    }
    let items = std::sync::Arc::new(items);
    let total_files = items.len();

    let mut set = tokio::task::JoinSet::new();
    let semaphore = std::sync::Arc::new(tokio::sync::Semaphore::new(6));

    for target in targets {
        let app_handle = app.clone();
        let adb_bin = adb_path.clone();
        let paths = items.clone();
        let dest_dir = remote_dir.clone();
        let sem = semaphore.clone();

        set.spawn(async move {
            let device_id = target.id.clone();
            let device_name = target.name.clone();

            // Emit initial status
            let _ = app_handle.emit(
                "multi-transfer-progress",
                MultiTransferDeviceProgress {
                    device_id: device_id.clone(),
                    device_name: device_name.clone(),
                    current_file: if target.is_connected {
                        "Ожидание очереди...".to_string()
                    } else {
                        "Подключение...".to_string()
                    },
                    total_files,
                    completed_files: 0,
                    percentage: 0.0,
                    speed_mb_s: 0.0,
                    status: if target.is_connected {
                        "pushing".to_string()
                    } else {
                        "connecting".to_string()
                    },
                    error_message: None,
                },
            );

            // Limit parallel operations so ADB daemon and Wi-Fi are not overwhelmed
            let _permit = match sem.acquire().await {
                Ok(p) => p,
                Err(_) => return Err("Ошибка очереди задач".to_string()),
            };

            // 1. If not connected, connect first
            if !target.is_connected {
                let _ = app_handle.emit(
                    "multi-transfer-progress",
                    MultiTransferDeviceProgress {
                        device_id: device_id.clone(),
                        device_name: device_name.clone(),
                        current_file: "Подключение по сети...".to_string(),
                        total_files,
                        completed_files: 0,
                        percentage: 0.0,
                        speed_mb_s: 0.0,
                        status: "connecting".to_string(),
                        error_message: None,
                    },
                );

                let conn_res = execute_adb_command_async(&["connect", &device_id], 8).await;
                let conn_ok = match &conn_res {
                    Ok(out) => {
                        (out.contains("connected") || out.contains("already connected"))
                            && !out.contains("cannot connect")
                            && !out.contains("unable to connect")
                            && !out.contains("failed")
                    }
                    Err(_) => false,
                };

                if !conn_ok {
                    let raw_err = match conn_res {
                        Ok(o) => o.trim().to_string(),
                        Err(e) => e.trim().to_string(),
                    };
                    let err_msg = if raw_err.is_empty() {
                        "Порт 5555 не отвечает. Проверьте отладку по Wi-Fi на устройстве.".to_string()
                    } else {
                        format!("Не удалось подключиться: {}", raw_err)
                    };

                    let _ = app_handle.emit(
                        "multi-transfer-progress",
                        MultiTransferDeviceProgress {
                            device_id: device_id.clone(),
                            device_name: device_name.clone(),
                            current_file: "".to_string(),
                            total_files,
                            completed_files: 0,
                            percentage: 0.0,
                            speed_mb_s: 0.0,
                            status: "error".to_string(),
                            error_message: Some(err_msg.clone()),
                        },
                    );
                    return Err(err_msg);
                }
            }

            // 2. Verify device state (check for unauthorized or offline state)
            let state_res = execute_adb_command_async(&["-s", &device_id, "get-state"], 4).await;
            match state_res {
                Ok(ref state) if state.trim() == "device" => {
                    // Device is ready
                }
                Ok(state) => {
                    let trimmed = state.trim();
                    let err_msg = if trimmed.contains("unauthorized") {
                        "Устройство не авторизовано. Разблокируйте экран телефона и нажмите «Разрешить отладку»!".to_string()
                    } else if trimmed.contains("offline") {
                        "Устройство не в сети (offline). Проверьте Wi-Fi соединение.".to_string()
                    } else {
                        format!("Устройство не готово: {}", trimmed)
                    };

                    let _ = app_handle.emit(
                        "multi-transfer-progress",
                        MultiTransferDeviceProgress {
                            device_id: device_id.clone(),
                            device_name: device_name.clone(),
                            current_file: "".to_string(),
                            total_files,
                            completed_files: 0,
                            percentage: 0.0,
                            speed_mb_s: 0.0,
                            status: "error".to_string(),
                            error_message: Some(err_msg.clone()),
                        },
                    );
                    return Err(err_msg);
                }
                Err(e) => {
                    let err_msg = if e.contains("unauthorized") {
                        "Устройство не авторизовано. Разблокируйте экран телефона и нажмите «Разрешить отладку»!".to_string()
                    } else if e.contains("offline") {
                        "Устройство не в сети (offline). Проверьте Wi-Fi соединение.".to_string()
                    } else {
                        format!("Устройство недоступно: {}", e.trim())
                    };

                    let _ = app_handle.emit(
                        "multi-transfer-progress",
                        MultiTransferDeviceProgress {
                            device_id: device_id.clone(),
                            device_name: device_name.clone(),
                            current_file: "".to_string(),
                            total_files,
                            completed_files: 0,
                            percentage: 0.0,
                            speed_mb_s: 0.0,
                            status: "error".to_string(),
                            error_message: Some(err_msg.clone()),
                        },
                    );
                    return Err(err_msg);
                }
            }

            // 3. Ensure remote directory exists
            let quoted_dir = quote_posix_path(&dest_dir);
            let _ = execute_adb_command_async(&["-s", &device_id, "shell", "mkdir", "-p", &quoted_dir], 5).await;

            // 4. Push each file/folder
            let mut completed_files = 0;

            for (idx, item) in paths.iter().enumerate() {
                let local_str = &item.path;
                let file_name = item.name.clone();
                let file_size = item.size;

                let progress_pct = (completed_files as f32 / total_files as f32) * 100.0;
                let _ = app_handle.emit(
                    "multi-transfer-progress",
                    MultiTransferDeviceProgress {
                        device_id: device_id.clone(),
                        device_name: device_name.clone(),
                        current_file: format!("Отправка ({}/{}): {}", idx + 1, total_files, file_name),
                        total_files,
                        completed_files,
                        percentage: progress_pct,
                        speed_mb_s: 0.0,
                        status: "pushing".to_string(),
                        error_message: None,
                    },
                );

                let start_time = std::time::Instant::now();

                let mut cmd = tokio::process::Command::new(&adb_bin);
                cmd.args(&["-s", &device_id, "push", local_str, &dest_dir]);

                #[cfg(target_os = "windows")]
                {
                    cmd.creation_flags(0x08000000);
                }
                cmd.kill_on_drop(true);

                let timeout_secs = push_timeout_secs(file_size);

                let push_result = tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), cmd.output()).await;

                match push_result {
                    Ok(Ok(output)) => {
                        let elapsed = start_time.elapsed().as_secs_f32().max(0.001);
                        let speed_mb_s = (file_size as f32 / (1024.0 * 1024.0)) / elapsed;

                        if output.status.success() {
                            completed_files += 1;
                            let new_pct = (completed_files as f32 / total_files as f32) * 100.0;
                            let _ = app_handle.emit(
                                "multi-transfer-progress",
                                MultiTransferDeviceProgress {
                                    device_id: device_id.clone(),
                                    device_name: device_name.clone(),
                                    current_file: file_name.clone(),
                                    total_files,
                                    completed_files,
                                    percentage: new_pct,
                                    speed_mb_s,
                                    status: if completed_files == total_files {
                                        "completed".to_string()
                                    } else {
                                        "pushing".to_string()
                                    },
                                    error_message: None,
                                },
                            );
                        } else {
                            let stderr_str = String::from_utf8_lossy(&output.stderr).to_string();
                            let stdout_str = String::from_utf8_lossy(&output.stdout).to_string();
                            let raw_err = if !stderr_str.trim().is_empty() {
                                stderr_str.trim().to_string()
                            } else if !stdout_str.trim().is_empty() {
                                stdout_str.trim().to_string()
                            } else {
                                "Ошибка передачи файла".to_string()
                            };

                            let friendly_err = if raw_err.contains("unauthorized") {
                                "Устройство не авторизовано. Подтвердите отладку на телефоне!".to_string()
                            } else if raw_err.contains("offline") {
                                "Устройство потеряло связь (offline).".to_string()
                            } else if raw_err.contains("No space left") {
                                "Недостаточно места в памяти устройства.".to_string()
                            } else if raw_err.contains("Permission denied") {
                                "Отказано в доступе к целевой папке на телефоне.".to_string()
                            } else {
                                raw_err
                            };

                            let _ = app_handle.emit(
                                "multi-transfer-progress",
                                MultiTransferDeviceProgress {
                                    device_id: device_id.clone(),
                                    device_name: device_name.clone(),
                                    current_file: file_name.clone(),
                                    total_files,
                                    completed_files,
                                    percentage: (completed_files as f32 / total_files as f32) * 100.0,
                                    speed_mb_s: 0.0,
                                    status: "error".to_string(),
                                    error_message: Some(format!("{}: {}", file_name, friendly_err)),
                                },
                            );
                            return Err(friendly_err);
                        }
                    }
                    Ok(Err(e)) => {
                        let err_msg = format!("Ошибка запуска процесса ADB: {}", e);
                        let _ = app_handle.emit(
                            "multi-transfer-progress",
                            MultiTransferDeviceProgress {
                                device_id: device_id.clone(),
                                device_name: device_name.clone(),
                                current_file: file_name.clone(),
                                total_files,
                                completed_files,
                                percentage: (completed_files as f32 / total_files as f32) * 100.0,
                                speed_mb_s: 0.0,
                                status: "error".to_string(),
                                error_message: Some(err_msg.clone()),
                            },
                        );
                        return Err(err_msg);
                    }
                    Err(_) => {
                        let err_msg = "Превышен таймаут передачи (устройство не ответило вовремя)".to_string();
                        let _ = app_handle.emit(
                            "multi-transfer-progress",
                            MultiTransferDeviceProgress {
                                device_id: device_id.clone(),
                                device_name: device_name.clone(),
                                current_file: file_name.clone(),
                                total_files,
                                completed_files,
                                percentage: (completed_files as f32 / total_files as f32) * 100.0,
                                speed_mb_s: 0.0,
                                status: "error".to_string(),
                                error_message: Some(err_msg.clone()),
                            },
                        );
                        return Err(err_msg);
                    }
                }
            }

            invalidate_device_files_cache(&device_id, Some(&dest_dir));
            Ok::<(), String>(())
        });
    }

    let mut any_success = false;
    while let Some(res) = set.join_next().await {
        if let Ok(task_res) = res {
            if task_res.is_ok() {
                any_success = true;
            }
        }
    }

    Ok(any_success)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_find_adb_path() {
        let path = find_adb_path();
        assert!(path.is_ok(), "find_adb_path should find bin/adb.exe: {:?}", path);
        let p = path.unwrap();
        assert!(p.exists(), "ADB binary must exist: {:?}", p);
    }

    #[tokio::test]
    async fn test_check_adb_status() {
        let status = check_adb_status().await;
        assert!(status.is_ok(), "check_adb_status should succeed: {:?}", status);
        let s = status.unwrap();
        assert!(s.contains("Android Debug Bridge"), "Status should contain ADB banner: {}", s);
    }

    #[tokio::test]
    #[ignore = "needs a running adb server / network / device"]
    async fn test_get_connected_devices() {
        let devices = get_connected_devices().await;
        assert!(devices.is_ok(), "get_connected_devices should return Ok: {:?}", devices);
        let list = devices.unwrap();
        println!("Connected devices ({}):", list.len());
        for d in &list {
            println!("  Serial: {}, Model: {}, Type: {}, State: {}", d.serial, d.model, d.device_type, d.state);
        }
    }

    #[test]
    fn test_quote_posix_path() {
        assert_eq!(quote_posix_path("/sdcard/Download"), "'/sdcard/Download'");
        assert_eq!(quote_posix_path("/sdcard/My Files"), "'/sdcard/My Files'");
        assert_eq!(quote_posix_path("/sdcard/O'Reilly"), "'/sdcard/O'\\''Reilly'");
        assert_eq!(quote_posix_path("/sdcard/test; rm -rf /"), "'/sdcard/test; rm -rf /'");
    }

    #[tokio::test]
    async fn test_delete_device_item_guards() {
        assert!(delete_device_item("dummy".into(), "/".into()).await.is_err());
        assert!(delete_device_item("dummy".into(), "/sdcard".into()).await.is_err());
        assert!(delete_device_item("dummy".into(), "/sdcard/".into()).await.is_err());
        assert!(delete_device_item("dummy".into(), "/storage".into()).await.is_err());
        assert!(delete_device_item("dummy".into(), "/storage/emulated/0/".into()).await.is_err());
        assert!(delete_device_item("dummy".into(), "/system".into()).await.is_err());
        assert!(delete_device_item("dummy".into(), "/data".into()).await.is_err());
        assert!(delete_device_item("dummy".into(), "".into()).await.is_err());
        // Bypasses of the old string blocklist
        assert!(delete_device_item("dummy".into(), "/storage/emulated/0/../0".into()).await.is_err());
        assert!(delete_device_item("dummy".into(), "/sdcard/Download/..".into()).await.is_err());
        assert!(delete_device_item("dummy".into(), "/storage/self/primary".into()).await.is_err());
        assert!(delete_device_item("dummy".into(), "/data/media/0".into()).await.is_err());
        assert!(delete_device_item("dummy".into(), "/mnt/user/0/emulated/0".into()).await.is_err());
        assert!(delete_device_item("dummy".into(), "//sdcard//".into()).await.is_err());
        assert!(delete_device_item("dummy".into(), "sdcard".into()).await.is_err());
    }

    #[test]
    fn test_normalize_device_path() {
        assert_eq!(normalize_device_path("/sdcard//Download/").unwrap(), "/sdcard/Download");
        assert_eq!(normalize_device_path("/").unwrap(), "/");
        assert!(normalize_device_path("/sdcard/./x").is_err());
        assert!(normalize_device_path("/sdcard/a/../b").is_err());
        assert!(normalize_device_path("relative/path").is_err());
        assert!(normalize_device_path("--sync").is_err());
    }

    #[test]
    fn test_is_protected_device_path() {
        for p in [
            "/", "/sdcard", "/storage", "/storage/emulated", "/storage/emulated/0", "/storage/emulated/10",
            "/storage/self", "/storage/self/primary", "/storage/1234-ABCD", "/storage/emulated/0/Android",
            "/storage/emulated/0/ANDROID", "/data", "/data/data", "/data/media", "/data/media/0", "/data/user/0",
            "/data/local/tmp", "/mnt/user/0/emulated/0", "/mnt/media_rw/1234-ABCD", "/system/app", "/vendor/lib",
        ] {
            assert!(is_protected_device_path(p), "{} must be protected", p);
        }
        for p in [
            "/sdcard/Download", "/sdcard/Download/file.txt", "/storage/emulated/0/DCIM/Camera",
            "/storage/emulated/0/Android/data/com.example", "/storage/1234-ABCD/Movies", "/data/local/tmp/test.apk",
            "/mnt/user/0/emulated/0/Download",
        ] {
            assert!(!is_protected_device_path(p), "{} must be deletable", p);
        }
    }

    #[test]
    fn test_parse_ls_output_keeps_significant_whitespace() {
        let out = "drwxrwx--x 2 u0 media_rw 4096 2026-03-01 12:00 Photos \r\n\
                   drwxrwx--x 2 u0 media_rw 4096 2026-03-01 12:00 Photos\r\n\
                   -rw-rw---- 1 u0 media_rw 10 2026-03-01 12:00  leading.txt\n";
        let items = parse_ls_output(out, "/sdcard");
        let paths: Vec<&str> = items.iter().map(|i| i.path.as_str()).collect();
        assert!(paths.contains(&"/sdcard/Photos "), "{:?}", paths);
        assert!(paths.contains(&"/sdcard/Photos"), "{:?}", paths);
        assert!(paths.contains(&"/sdcard/ leading.txt"), "{:?}", paths);
    }

    #[test]
    fn test_parse_ls_output_ignores_name_continuation_lines() {
        // A file name containing a newline must not produce a fake entry from its second line
        let out = "-rw-rw---- 1 u0 media_rw 10 2026-03-01 12:00 evil\nfoo bar baz qux quux Download\n";
        let items = parse_ls_output(out, "/sdcard");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].name, "evil");
    }

    #[test]
    fn test_new_transfer_id_is_unique() {
        let a = new_transfer_id("pull");
        let b = new_transfer_id("pull");
        assert_ne!(a, b);
        assert!(!a.starts_with("pull-0-"), "timestamp must not be zero: {}", a);
    }

    #[test]
    fn test_push_timeout_has_no_low_cap() {
        // 4 GB must get far more than the old 300s cap
        assert!(push_timeout_secs(4 * 1024 * 1024 * 1024) > 3600);
        assert_eq!(push_timeout_secs(0), 60);
    }

    #[test]
    fn test_calculate_path_size() {
        let dir = std::env::temp_dir().join(format!("transfile_size_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("a.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(dir.join("sub").join("b.bin"), vec![0u8; 50]).unwrap();
        assert_eq!(calculate_path_size(&dir), 150);
        assert_eq!(calculate_path_size(&dir.join("a.bin")), 100);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    #[ignore = "needs a running adb server / network / device"]
    async fn test_list_device_files() {
        let devices = get_connected_devices().await.unwrap();
        if let Some(dev) = devices.first() {
            let files = list_device_files(dev.serial.clone(), "/sdcard".to_string()).await;
            assert!(files.is_ok(), "list_device_files should succeed: {:?}", files);
            let items = files.unwrap();
            println!("Items in /sdcard on {} ({}):", dev.serial, items.len());
            for item in items.iter().take(5) {
                println!("  {} ({}, is_dir: {})", item.name, item.path, item.is_dir);
            }
            assert!(!items.is_empty(), "Items list should not be empty");
        }
    }

    #[test]
    fn test_parse_ls_output() {
        let sample_output = r#"
total 40
drwxrwx--x  3 u0_a123 media_rw 4096 2026-03-01 12:00 Download
-rw-rw----  1 u0_a123 media_rw 12345 2026-03-01 12:00 document.pdf
lrwxrwxrwx  1 root    root       21 2026-03-01 12:00 sdcard -> /storage/emulated/0
lrwxrwxrwx  1 root    root       25 2026-03-01 12:00 link_file -> /sdcard/document.pdf
drwxrws---  2 u0_a50  media_rw 4096 2026-08-12 21:50 Alarms
"#;
        // When querying /sdcard, self-referencing "sdcard" entry must be filtered out
        let items = parse_ls_output(sample_output, "/sdcard");
        assert_eq!(items.len(), 4, "Self-referencing sdcard must be filtered out");
        assert!(items.iter().all(|i| i.name != "sdcard"));

        // Directories and symlinks to directories must come first
        assert!(items[0].is_dir);
        assert!(items[1].is_dir);
        assert!(!items[2].is_dir);
        assert!(!items[3].is_dir);

        // Check link_file recognized as file
        let file_link = items.iter().find(|i| i.name == "link_file").unwrap();
        assert!(!file_link.is_dir);

        // Check regular directory
        let download = items.iter().find(|i| i.name == "Download").unwrap();
        assert!(download.is_dir);
        assert_eq!(download.path, "/sdcard/Download");

        // When querying root "/", "sdcard" is NOT self-referencing and must be kept
        let root_items = parse_ls_output(sample_output, "/");
        assert_eq!(root_items.len(), 5, "Root listing should include sdcard entry");
        let sdcard_item = root_items.iter().find(|i| i.name == "sdcard").unwrap();
        assert!(sdcard_item.is_dir);
        assert_eq!(sdcard_item.path, "/sdcard");
    }

    #[test]
    fn test_target_cmd_path_trailing_slash() {
        let make_target_path = |query_path: &str| {
            if query_path == "/" {
                "/".to_string()
            } else {
                format!("{}/", query_path.trim_end_matches('/'))
            }
        };

        assert_eq!(make_target_path("/"), "/");
        assert_eq!(make_target_path("/sdcard"), "/sdcard/");
        assert_eq!(make_target_path("/sdcard/"), "/sdcard/");
        assert_eq!(make_target_path("/storage/emulated/0"), "/storage/emulated/0/");
        assert_eq!(make_target_path("/storage/emulated/0/Download"), "/storage/emulated/0/Download/");
    }

    #[test]
    fn test_file_list_cache() {
        let serial = "test_device_cache";
        let path = "/sdcard/test";

        let sample_items = vec![
            RemoteFileItem {
                name: "file.txt".to_string(),
                path: "/sdcard/test/file.txt".to_string(),
                is_dir: false,
                size: 100,
                mtime: "2026-01-01".to_string(),
                permissions: "-rw-r--r--".to_string(),
            }
        ];

        // Cache miss initially
        assert!(get_cached_device_files(serial, path).is_none());

        // Cache set
        set_cached_device_files(serial, path, sample_items.clone());

        // Cache hit
        let cached = get_cached_device_files(serial, path);
        assert!(cached.is_some());
        assert_eq!(cached.unwrap().len(), 1);

        // Invalidation by subpath/child
        invalidate_device_files_cache(serial, Some("/sdcard/test/file.txt"));
        // Parent path /sdcard/test is invalidated
        assert!(get_cached_device_files(serial, path).is_none());

        // Reset and invalidate whole device
        set_cached_device_files(serial, path, sample_items);
        assert!(get_cached_device_files(serial, path).is_some());
        invalidate_device_files_cache(serial, None);
        assert!(get_cached_device_files(serial, path).is_none());
    }

    #[test]
    fn test_emulator_priority() {
        // MuMu main port (16480) should beat secondary (5561) and legacy (7555)
        let mumu_main = emulator_priority("127.0.0.1:16480");
        let mumu_secondary = emulator_priority("127.0.0.1:5561");
        let mumu_legacy = emulator_priority("127.0.0.1:7555");
        assert!(mumu_main > mumu_secondary, "16480 should have higher priority than 5561");
        assert!(mumu_secondary > mumu_legacy, "5561 should have higher priority than 7555");

        // Android Studio emulator-5554 should beat 127.0.0.1:5555
        let emu_native = emulator_priority("emulator-5554");
        let emu_tcp = emulator_priority("127.0.0.1:5555");
        assert!(emu_native > emu_tcp, "emulator-5554 should have higher priority than 127.0.0.1:5555");
    }

    #[test]
    fn test_is_directory_item() {
        assert!(is_directory_item("drwxr-xr-x", "Pictures", None));
        assert!(!is_directory_item("-rw-r--r--", "photo.png", None));
        assert!(is_directory_item("lrwxrwxrwx", "sdcard", Some("/storage/emulated/0")));
        assert!(is_directory_item("lrwxrwxrwx", "storage", Some("/storage")));
        assert!(is_directory_item("lrwxrwxrwx", "custom", Some("/storage/emulated/0/DCIM/")));
        assert!(!is_directory_item("lrwxrwxrwx", "prop", Some("/system/etc/build.prop")));
    }

    #[tokio::test]
    async fn test_connect_lan_devices_filters_loopback() {
        let hosts = vec![
            "127.0.0.1:5555".to_string(),
            "localhost:5555".to_string(),
            "::1:5555".to_string(),
            "".to_string(),
            "0.0.0.0".to_string(),
        ];
        let res = connect_lan_devices(hosts).await;
        assert!(res.is_ok(), "connect_lan_devices should succeed");
        // All loopback/invalid entries must be filtered out
        assert_eq!(res.unwrap().len(), 0);
    }

    #[test]
    fn test_resolve_emulator_pid() {
        let mut port_to_pid = HashMap::new();
        port_to_pid.insert(16480, 32568);
        port_to_pid.insert(5561, 32568);
        port_to_pid.insert(5554, 9999);
        port_to_pid.insert(5555, 9999);

        let dev_mumu_primary = DeviceInfo {
            serial: "127.0.0.1:16480".to_string(),
            model: "SM_S926B".to_string(),
            product: "e2s".to_string(),
            device_type: "emulator".to_string(),
            state: "device".to_string(),
            ip: Some("127.0.0.1".to_string()),
            port: Some(16480),
        };
        let dev_mumu_secondary = DeviceInfo {
            serial: "127.0.0.1:5561".to_string(),
            model: "SM_S926B".to_string(),
            product: "e2s".to_string(),
            device_type: "emulator".to_string(),
            state: "device".to_string(),
            ip: Some("127.0.0.1".to_string()),
            port: Some(5561),
        };
        let dev_native = DeviceInfo {
            serial: "emulator-5554".to_string(),
            model: "Pixel 7".to_string(),
            product: "panther".to_string(),
            device_type: "emulator".to_string(),
            state: "device".to_string(),
            ip: None,
            port: None,
        };

        assert_eq!(resolve_emulator_pid(&dev_mumu_primary, &port_to_pid), Some(32568));
        assert_eq!(resolve_emulator_pid(&dev_mumu_secondary, &port_to_pid), Some(32568));
        assert_eq!(resolve_emulator_pid(&dev_native, &port_to_pid), Some(9999));
    }

    #[test]
    fn test_deduplicate_emulator_devices_by_pid_mumu_6_instances() {
        let mut port_to_pid = HashMap::new();
        // 6 instances running on host:
        // Instance 0: PID 31576 -> 16384, 5555, 7555
        port_to_pid.insert(16384, 31576);
        port_to_pid.insert(5555, 31576);
        port_to_pid.insert(7555, 31576);

        // Instance 1: PID 26876 -> 16416, 5557
        port_to_pid.insert(16416, 26876);
        port_to_pid.insert(5557, 26876);

        // Instance 2: PID 52456 -> 16448, 5559
        port_to_pid.insert(16448, 52456);
        port_to_pid.insert(5559, 52456);

        // Instance 3: PID 32568 -> 16480, 5561
        port_to_pid.insert(16480, 32568);
        port_to_pid.insert(5561, 32568);

        // Instance 4: PID 54632 -> 16544, 5565
        port_to_pid.insert(16544, 54632);
        port_to_pid.insert(5565, 54632);

        // Instance 5: PID 43528 -> 16576, 5567
        port_to_pid.insert(16576, 43528);
        port_to_pid.insert(5567, 43528);

        let make_dev = |port: u16| DeviceInfo {
            serial: format!("127.0.0.1:{}", port),
            model: "MuMu".to_string(),
            product: "MuMu".to_string(),
            device_type: "emulator".to_string(),
            state: "device".to_string(),
            ip: Some("127.0.0.1".to_string()),
            port: Some(port),
        };

        // All 13 connected ports passed into deduplicator
        let connected_ports = vec![
            16384, 5555, 7555,
            16416, 5557,
            16448, 5559,
            16480, 5561,
            16544, 5565,
            16576, 5567,
        ];
        let emulator_devs: Vec<DeviceInfo> = connected_ports.into_iter().map(make_dev).collect();

        let (kept, mirrors_to_disconnect) =
            deduplicate_emulator_devices(emulator_devs, &port_to_pid, &HashMap::new());

        // Must return EXACTLY 6 kept emulator devices
        assert_eq!(kept.len(), 6, "Expected exactly 6 unique emulator instances, got {}", kept.len());

        let mut kept_ports: Vec<u16> = kept.iter().filter_map(|d| d.port).collect();
        kept_ports.sort();
        assert_eq!(
            kept_ports,
            vec![16384, 16416, 16448, 16480, 16544, 16576],
            "Kept ports must only be the primary 16xxx ports"
        );

        // 7 mirror ports must be marked for disconnection
        assert_eq!(mirrors_to_disconnect.len(), 7, "Expected exactly 7 mirrors to disconnect");
        assert!(mirrors_to_disconnect.contains(&"127.0.0.1:5555".to_string()));
        assert!(mirrors_to_disconnect.contains(&"127.0.0.1:7555".to_string()));
        assert!(mirrors_to_disconnect.contains(&"127.0.0.1:5557".to_string()));
        assert!(mirrors_to_disconnect.contains(&"127.0.0.1:5559".to_string()));
        assert!(mirrors_to_disconnect.contains(&"127.0.0.1:5561".to_string()));
        assert!(mirrors_to_disconnect.contains(&"127.0.0.1:5565".to_string()));
        assert!(mirrors_to_disconnect.contains(&"127.0.0.1:5567".to_string()));
    }

    #[test]
    fn test_deduplicate_android_studio_emulator() {
        let mut port_to_pid = HashMap::new();
        port_to_pid.insert(5554, 8888);
        port_to_pid.insert(5555, 8888);

        let dev_native = DeviceInfo {
            serial: "emulator-5554".to_string(),
            model: "Pixel 7".to_string(),
            product: "panther".to_string(),
            device_type: "emulator".to_string(),
            state: "device".to_string(),
            ip: None,
            port: None,
        };
        let dev_tcp = DeviceInfo {
            serial: "127.0.0.1:5555".to_string(),
            model: "Pixel 7".to_string(),
            product: "panther".to_string(),
            device_type: "emulator".to_string(),
            state: "device".to_string(),
            ip: Some("127.0.0.1".to_string()),
            port: Some(5555),
        };

        let (kept, mirrors) = deduplicate_emulator_devices(
            vec![dev_tcp, dev_native],
            &port_to_pid,
            &HashMap::new(),
        );

        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].serial, "emulator-5554");
        assert_eq!(mirrors, vec!["127.0.0.1:5555".to_string()]);
    }

    #[tokio::test]
    #[ignore = "needs a running adb server / network / device"]
    async fn test_connect_device_tls_port_failure_returns_pairing_hint() {
        let res = connect_device("192.168.1.1:37851".to_string()).await;
        assert!(res.is_err());
        let err = res.unwrap_err();
        assert!(
            err.contains("Устройство требует первичного сопряжения"),
            "Error should contain pairing hint, got: {}",
            err
        );
    }
}
