export interface DeviceInfo {
  serial: string;
  model: string;
  product: string;
  device_type: 'wifi' | 'usb' | 'emulator' | string;
  state: 'device' | 'unauthorized' | 'offline' | string;
  ip?: string;
  port?: number;
  /**
   * Whether the connected transport answers commands. A MuMu emulator stays 'checking' for ~2 min after a
   * reconnect: the connection is up, but adbd processes nothing until it has released the old one.
   */
  readiness: 'ready' | 'checking' | 'unresponsive' | 'unknown' | string;
  /** Milliseconds since the readiness check started (only while 'checking') */
  readiness_ms?: number | null;
  /** Frontend-computed: Date.now() timestamp when the readiness check started (only while 'checking') */
  readiness_since?: number | null;
  /** Offline network device the adb server is still re-connecting by itself (it comes back on its own) */
  reconnecting?: boolean;
}

/** Result of `connect_lan_devices` / `connect_host` for one host */
export interface ConnectOutcome {
  host: string;
  /** 'pending': the device is busy; the adb server keeps connecting it by itself */
  state: 'connected' | 'unauthorized' | 'pending' | 'failed';
  message: string;
  /** Connected, but not answering commands yet (MuMu needs ~2 min after a reconnect) */
  busy: boolean;
}

export interface ConnectProgress {
  host: string;
  phase: 'connecting' | 'waiting' | 'done';
}

export interface DiscoveredHost {
  ip: string;
  port: number;
  name: string;
  discovery_type: 'mdns' | 'port_scan' | 'pairing';
}

export interface RemoteFileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: string;
  permissions: string;
}

/** One directory of a batched `list_device_dirs` call; `path` echoes the requested path. */
export interface DirListing {
  path: string;
  items: RemoteFileItem[] | null;
  error: string | null;
}

export interface TransferProgress {
  transfer_id: string;
  file_name: string;
  current_bytes: number;
  total_bytes: number;
  percentage: number;
  speed_mb_s: number;
  status: 'starting' | 'transferring' | 'completed' | 'error';
  error_message?: string;
}

export interface TargetDevice {
  id: string; // serial or ip:port
  name: string; // model or display name
  is_connected: boolean;
  device_type: 'usb' | 'wifi' | 'lan' | 'emulator';
}

export interface MultiTransferDeviceProgress {
  device_id: string;
  device_name: string;
  current_file: string;
  total_files: number;
  completed_files: number;
  percentage: number;
  speed_mb_s: number;
  status: 'connecting' | 'pushing' | 'completed' | 'error';
  error_message?: string;
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}
