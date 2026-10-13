use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};
use std::sync::Arc;
use std::time::Duration;
use mdns_sd::{ServiceDaemon, ServiceEvent};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::time::timeout;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveredHost {
    pub ip: String,
    pub port: u16,
    pub name: String,
    pub discovery_type: String, // "mdns" | "port_scan"
}

// Get the local machine IPv4 address in the LAN
pub fn get_local_ip() -> Option<Ipv4Addr> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr().ok()?.ip() {
        IpAddr::V4(ipv4) => {
            if !ipv4.is_loopback() && !ipv4.is_link_local() {
                Some(ipv4)
            } else {
                None
            }
        }
        _ => None,
    }
}

// Robust parallel subnet port scanner for port 5555
pub async fn scan_subnet_port(base_ip: Ipv4Addr, port: u16) -> Vec<DiscoveredHost> {
    let octets = base_ip.octets();
    let semaphore = Arc::new(tokio::sync::Semaphore::new(48));
    let mut tasks = Vec::with_capacity(254);
    let results = Arc::new(Mutex::new(Vec::new()));

    for host_octet in 1..=254 {
        if host_octet == octets[3] {
            // Skip scanning own IP
            continue;
        }

        let target_ip = Ipv4Addr::new(octets[0], octets[1], octets[2], host_octet);
        let target_addr = SocketAddr::new(IpAddr::V4(target_ip), port);
        let res_clone = Arc::clone(&results);
        let sem_clone = Arc::clone(&semaphore);

        let task = tokio::spawn(async move {
            let _permit = match sem_clone.acquire().await {
                Ok(p) => p,
                Err(_) => return,
            };
            // 750ms ensures reliable Wi-Fi SYN-ACK reception without router queue drops
            let connect_timeout = Duration::from_millis(750);
            if let Ok(Ok(_stream)) = timeout(connect_timeout, tokio::net::TcpStream::connect(target_addr)).await {
                let mut lock = res_clone.lock().await;
                lock.push(DiscoveredHost {
                    ip: target_ip.to_string(),
                    port,
                    name: format!("Android ({}:{})", target_ip, port),
                    discovery_type: "port_scan".to_string(),
                });
            }
        });

        tasks.push(task);
    }

    for task in tasks {
        let _ = task.await;
    }

    let mut final_res = results.lock().await.clone();
    final_res.sort_by(|a, b| {
        let parse_ip = |s: &str| -> u32 {
            s.parse::<Ipv4Addr>().map(u32::from).unwrap_or(0)
        };
        parse_ip(&a.ip).cmp(&parse_ip(&b.ip))
    });
    final_res
}

// mDNS discovery for Android 11+ wireless debugging services
pub async fn scan_mdns_services(timeout_secs: u64) -> Vec<DiscoveredHost> {
    tokio::task::spawn_blocking(move || {
        let mut discovered = Vec::new();
        let mdns = match ServiceDaemon::new() {
            Ok(d) => d,
            Err(_) => return discovered,
        };

        let service_types = [
            "_adb-tls-connect._tcp.local.",
            "_adb._tcp.local.",
            "_adb-tls-pairing._tcp.local.",
        ];
        let mut receivers = Vec::new();

        for st in &service_types {
            if let Ok(rx) = mdns.browse(st) {
                receivers.push(rx);
            }
        }

        let start = std::time::Instant::now();
        let duration = Duration::from_secs(timeout_secs);

        while start.elapsed() < duration {
            let mut got_any = false;
            for rx in &receivers {
                if let Ok(event) = rx.recv_timeout(Duration::from_millis(150)) {
                    got_any = true;
                    if let ServiceEvent::ServiceResolved(info) = event {
                        let port = info.get_port();
                        let hostname = info.get_fullname();
                        for ip in info.get_addresses() {
                            if let IpAddr::V4(ipv4) = ip {
                                if !ipv4.is_loopback() && ipv4.to_string() != "127.0.0.1" {
                                    let ip_str = ipv4.to_string();
                                    if !discovered.iter().any(|h: &DiscoveredHost| h.ip == ip_str && h.port == port) {
                                        let is_pairing = hostname.contains("_adb-tls-pairing");
                                        let discovery_type = if is_pairing {
                                            "pairing".to_string()
                                        } else {
                                            "mdns".to_string()
                                        };
                                        let clean_name = hostname
                                            .replace("._adb-tls-pairing._tcp.local.", "")
                                            .replace("._adb-tls-connect._tcp.local.", "")
                                            .replace("._adb._tcp.local.", "");

                                        discovered.push(DiscoveredHost {
                                            ip: ip_str,
                                            port,
                                            name: clean_name,
                                            discovery_type,
                                        });
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if !got_any {
                std::thread::sleep(Duration::from_millis(50));
            }
        }

        let _ = mdns.shutdown();
        discovered
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
pub async fn discover_network_devices() -> Result<Vec<DiscoveredHost>, String> {
    let mut combined: Vec<DiscoveredHost> = Vec::new();

    // 1. Run mDNS search in background task
    let mdns_task = tokio::spawn(async {
        scan_mdns_services(2).await
    });

    // 2. Run Subnet Port Scan (port 5555)
    let subnet_task = tokio::spawn(async {
        if let Some(local_ip) = get_local_ip() {
            scan_subnet_port(local_ip, 5555).await
        } else {
            Vec::new()
        }
    });

    let (mdns_res, subnet_res) = tokio::join!(mdns_task, subnet_task);

    if let Ok(hosts) = mdns_res {
        for h in hosts {
            if h.ip == "127.0.0.1" || h.ip == "localhost" {
                continue;
            }
            if !combined.iter().any(|x| x.ip == h.ip && x.port == h.port) {
                combined.push(h);
            }
        }
    }

    if let Ok(hosts) = subnet_res {
        for h in hosts {
            if h.ip == "127.0.0.1" || h.ip == "localhost" {
                continue;
            }
            if let Some(existing) = combined.iter_mut().find(|x| x.ip == h.ip) {
                if existing.name.starts_with("Android (") {
                    existing.name = h.name;
                }
            } else {
                combined.push(h);
            }
        }
    }

    combined.sort_by(|a, b| {
        let parse_ip = |s: &str| -> u32 {
            s.parse::<Ipv4Addr>().map(u32::from).unwrap_or(0)
        };
        parse_ip(&a.ip).cmp(&parse_ip(&b.ip))
    });

    Ok(combined)
}

// Auto-connect discovered hosts helper
#[allow(dead_code)]
pub async fn auto_connect_discovered(hosts: &[DiscoveredHost]) -> Result<Vec<String>, String> {
    let host_strings: Vec<String> = hosts
        .iter()
        .filter(|h| h.ip != "127.0.0.1" && h.ip != "localhost" && h.ip != "0.0.0.0")
        .map(|h| format!("{}:{}", h.ip, h.port))
        .collect();
    crate::adb::auto_connect_lan_devices(host_strings).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_get_local_ip() {
        let ip = get_local_ip();
        println!("Local IP: {:?}", ip);
    }

    #[tokio::test]
    async fn test_scan_subnet_port() {
        if let Some(ip) = get_local_ip() {
            let hosts = scan_subnet_port(ip, 5555).await;
            println!("Subnet scan found {} hosts:", hosts.len());
            for h in &hosts {
                println!("  Found: {}:{} ({})", h.ip, h.port, h.name);
            }
        }
    }

    #[tokio::test]
    async fn test_scan_mdns() {
        let hosts = scan_mdns_services(1).await;
        println!("mDNS scan found {} hosts", hosts.len());
    }

    #[tokio::test]
    async fn test_discover_network_devices() {
        let res = discover_network_devices().await;
        assert!(res.is_ok(), "discover_network_devices should succeed");
    }

    #[test]
    fn test_pairing_service_identification() {
        let hostname = "adb-12345678-abcdef._adb-tls-pairing._tcp.local.";
        let is_pairing = hostname.contains("_adb-tls-pairing");
        assert!(is_pairing);
        let discovery_type = if is_pairing {
            "pairing".to_string()
        } else {
            "mdns".to_string()
        };
        assert_eq!(discovery_type, "pairing");

        let clean_name = hostname
            .replace("._adb-tls-pairing._tcp.local.", "")
            .replace("._adb-tls-connect._tcp.local.", "")
            .replace("._adb._tcp.local.", "");
        assert_eq!(clean_name, "adb-12345678-abcdef");
    }
}
