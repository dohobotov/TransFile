export interface DeviceInfo {
  serial: string;
  model: string;
  product: string;
  device_type: 'wifi' | 'usb' | 'emulator' | string;
  state: 'device' | 'unauthorized' | 'offline' | string;
  ip?: string;
  port?: number;
}

export interface DiscoveredHost {
  ip: string;
  port: number;
  name: string;
  discovery_type: 'mdns' | 'port_scan';
}

export interface RemoteFileItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: string;
  permissions: string;
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
