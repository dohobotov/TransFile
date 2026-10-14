import React, { useState, useEffect, useMemo, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import {
  DeviceInfo,
  DiscoveredHost,
  TargetDevice,
  MultiTransferDeviceProgress,
  TransferProgress,
  ConnectOutcome,
  ConnectProgress,
  formatBytes,
} from '../types';
import {
  UploadCloud,
  FilePlus,
  FolderPlus,
  FolderCheck,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  HardDriveUpload,
  Trash2,
  Image,
  FileText,
  Download,
  Music,
  Usb,
  CheckSquare,
  Square,
  SquareMinus,
  Sparkles,
  Monitor,
  KeyRound,
  Plug,
  Unplug,
  LoaderCircle,
  TriangleAlert,
  X,
} from 'lucide-react';
import { PairingModal } from './PairingModal';

type GroupState = 'all' | 'some' | 'none';

type LanRowStatus =
  | 'connected'
  | 'busy'
  | 'unresponsive'
  | 'unauthorized'
  | 'reconnecting'
  | 'offline'
  | 'disconnected'
  | 'needsPairing';

interface LanRow {
  hostId: string;
  host: DiscoveredHost;
  conn?: DeviceInfo;
  targetId: string | null;
  status: LanRowStatus;
}

interface LanStatus {
  kind: 'success' | 'warning' | 'error';
  text: string;
}

const unique = <T,>(items: T[]): T[] => Array.from(new Set(items));

const LAN_STATUS_STYLES = {
  success: { tone: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300', Icon: CheckCircle2 },
  warning: { tone: 'bg-amber-500/10 border-amber-500/20 text-amber-300', Icon: TriangleAlert },
  error: { tone: 'bg-rose-500/10 border-rose-500/20 text-rose-300', Icon: AlertCircle },
} as const;

const LAN_ROW_VIEW: Record<LanRowStatus, { dot: string; text: string; textClass: string; tooltip: string }> = {
  connected: { dot: 'bg-emerald-400', text: 'Подключено', textClass: 'text-emerald-300', tooltip: 'Подключено по Wi-Fi' },
  busy: {
    dot: 'bg-sky-400 animate-pulse',
    text: 'Ждём ответа',
    textClass: 'text-sky-300',
    tooltip:
      'Подключено, но устройство ещё не отвечает. Эмуляторы MuMu после переподключения недоступны около 2 минут — отправка файлов дождётся их автоматически.',
  },
  unresponsive: {
    dot: 'bg-rose-500',
    text: 'Не отвечает',
    textClass: 'text-rose-300',
    tooltip: 'Подключено, но устройство не отвечает на команды ADB больше 5 минут',
  },
  unauthorized: {
    dot: 'bg-amber-400 animate-pulse',
    text: 'Авторизация',
    textClass: 'text-amber-300',
    tooltip: 'Подтвердите отладку на экране устройства',
  },
  reconnecting: {
    dot: 'bg-sky-400 animate-pulse',
    text: 'Ждём устройство',
    textClass: 'text-sky-300',
    tooltip:
      'Устройство пока не отвечает на подключение (например, MuMu занят после прошлого отключения). adb подключит его сам — нажимать «Подключить» повторно не нужно. Если это длится больше 5–10 минут, перезапустите эмулятор.',
  },
  offline: {
    dot: 'bg-rose-500',
    text: 'Офлайн',
    textClass: 'text-rose-300',
    tooltip: 'ADB-соединение не активно. Нажмите «Подключить», чтобы переподключить устройство.',
  },
  disconnected: { dot: 'bg-[#475569]', text: 'Не подключено', textClass: 'text-[#7c879c]', tooltip: 'Не подключено' },
  needsPairing: {
    dot: 'bg-amber-400/60',
    text: 'Нужен код',
    textClass: 'text-amber-300/80',
    tooltip: 'Android 11+: выполните сопряжение по коду',
  },
};

const ROW_BASE = 'px-2.5 py-2 rounded-lg border transition flex items-center gap-2';
const ROW_CHECKED = 'bg-sky-500/10 border-sky-500/35 cursor-pointer';
const ROW_UNCHECKED = 'bg-[#151926] hover:bg-[#1a2030] border-[#222a3d] cursor-pointer';
const ROW_DISABLED = 'bg-[#151926] border-[#222a3d] cursor-default';

const LAN_BUTTON_BASE =
  'h-7 px-2.5 rounded-lg border text-[11px] font-medium flex items-center gap-1.5 whitespace-nowrap transition disabled:opacity-40 disabled:cursor-not-allowed';

// Tri-state checkbox for a group of recipients: all / some / none selected
const GroupCheckbox: React.FC<{
  state: GroupState;
  disabled: boolean;
  onToggle: () => void;
  selectTitle: string;
  clearTitle: string;
}> = ({ state, disabled, onToggle, selectTitle, clearTitle }) => {
  const Icon = state === 'all' ? CheckSquare : state === 'some' ? SquareMinus : Square;
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      title={state === 'all' ? clearTitle : selectTitle}
      className="p-0.5 -m-0.5 rounded hover:bg-white/5 transition disabled:opacity-40 shrink-0"
    >
      <Icon className={`w-4 h-4 ${state === 'none' ? 'text-[#475569]' : 'text-sky-400'}`} />
    </button>
  );
};

/** Transfer-tab state owned by App so it survives switching tabs (see App.tsx) */
export interface TransferSession {
  selectedTargetIds: Set<string>;
  setSelectedTargetIds: React.Dispatch<React.SetStateAction<Set<string>>>;
  multiProgress: Record<string, MultiTransferDeviceProgress>;
  setMultiProgress: React.Dispatch<React.SetStateAction<Record<string, MultiTransferDeviceProgress>>>;
  isSending: boolean;
  setIsSending: React.Dispatch<React.SetStateAction<boolean>>;
}

interface TransferViewProps {
  transferSession: TransferSession;
  deviceSerial: string | null;
  connectedDevices: DeviceInfo[];
  onRefreshConnectedDevices: () => void;
  isRefreshingConnectedDevices: boolean;
  networkDevices: DiscoveredHost[];
  isScanningNetwork: boolean;
  onScanNetwork: () => void;
  targetRemotePath: string;
  onSetTargetRemotePath: (path: string) => void;
  onNavigateToExplorer: () => void;
  transfers: TransferProgress[];
  onClearTransfers: () => void;
  onTransferTriggered: () => void;
}

export const TransferView: React.FC<TransferViewProps> = ({
  transferSession,
  deviceSerial,
  connectedDevices,
  onRefreshConnectedDevices,
  isRefreshingConnectedDevices,
  networkDevices,
  isScanningNetwork,
  onScanNetwork,
  targetRemotePath,
  onSetTargetRemotePath,
  onNavigateToExplorer,
  transfers,
  onClearTransfers,
  onTransferTriggered,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Recipients selection (serial for connected, "ip:port" for unconnected network), multi-device progress and
  // the «sending» flag live in App: they must survive switching tabs while a transfer is running.
  const { selectedTargetIds, setSelectedTargetIds, multiProgress, setMultiProgress, isSending, setIsSending } =
    transferSession;
  // Track hosts currently connecting
  const [connectingHosts, setConnectingHosts] = useState<Set<string>>(new Set());
  // Track serials currently being disconnected by the toolbar «Отключить» action
  const [disconnectingSerials, setDisconnectingSerials] = useState<Set<string>>(new Set());
  // Bulk LAN action in progress (toolbar «Подключить» / «Отключить»)
  const [lanAction, setLanAction] = useState<'connect' | 'disconnect' | null>(null);
  // Read by startPushing after an awaited file dialog, when the render-time value may be outdated
  const lanActionRef = useRef(lanAction);
  lanActionRef.current = lanAction;
  // Result of the last bulk LAN action, shown under the recipients toolbar
  const [lanStatus, setLanStatus] = useState<LanStatus | null>(null);
  // Track Android 11+ pairing target. connectHost = null: pairing-only endpoint, nothing to connect afterwards
  const [pairingTarget, setPairingTarget] = useState<{ host: string; connectHost: string | null } | null>(null);

  // Deduplicate connected devices list to ensure exact emulator counts and prevent duplicate entries
  const uniqueConnectedDevices = useMemo(() => {
    const seenSerials = new Set<string>();
    const filtered = connectedDevices.filter((d) => {
      if (!d.serial || seenSerials.has(d.serial)) return false;
      seenSerials.add(d.serial);
      return true;
    });

    const getPort = (serial: string): number | null => {
      if (!serial.includes(':')) return null;
      const parts = serial.split(':');
      const port = parseInt(parts[1], 10);
      return isNaN(port) ? null : port;
    };

    // Prune duplicate emulator aliases:
    // a) Drop emulator-XXXX if 127.0.0.1:YYYY with same model exists
    // b) If an emulator has a 16xxx port (e.g. 127.0.0.1:16416) and another has a 55xx port (e.g. 127.0.0.1:5557) or 7555 with same model and product, drop the secondary mirror port (55xx / 7555)
    return filtered.filter((dev) => {
      if (dev.serial.startsWith('emulator-')) {
        const hasIpEquiv = filtered.some(
          (o) => o.serial.startsWith('127.0.0.1:') && o.model === dev.model
        );
        if (hasIpEquiv) return false;
      }

      const isLoopback = dev.serial.startsWith('127.0.0.1:') || dev.serial.startsWith('localhost:');
      if (isLoopback) {
        const devPort = getPort(dev.serial);
        const is55Mirror = devPort !== null && devPort >= 5500 && devPort <= 5700;
        const is7555Mirror = devPort === 7555;

        if (is55Mirror || is7555Mirror) {
          const has16Port = filtered.some((o) => {
            const oIsLoopback = o.serial.startsWith('127.0.0.1:') || o.serial.startsWith('localhost:');
            if (!oIsLoopback) return false;
            const oPort = getPort(o.serial);
            const is16xxx = oPort !== null && oPort >= 16000 && oPort <= 21000;
            if (!is16xxx) return false;
            const modelMatches = !!o.model && !!dev.model && o.model === dev.model;
            const productMatches = !o.product || !dev.product || o.product === dev.product;
            return modelMatches && productMatches;
          });

          if (has16Port) {
            return false;
          }
        }
      }

      return true;
    });
  }, [connectedDevices]);

  // Column 1: Strictly direct PC devices: physical USB devices and local PC emulators
  const directPcDevices = useMemo(() => {
    return uniqueConnectedDevices.filter(
      (d) =>
        (d.device_type === 'usb' || d.device_type === 'emulator') &&
        !d.serial.includes('192.') &&
        !d.serial.includes('10.') &&
        !d.serial.includes('172.')
    );
  }, [uniqueConnectedDevices]);

  // Keep ALL LAN hosts visible, merging networkDevices AND any connected Wi-Fi devices
  const lanHosts = useMemo(() => {
    const seen = new Set<string>();
    const list: DiscoveredHost[] = [];

    // 1. Add discovered network devices (filtering local loopback)
    for (const h of networkDevices) {
      if (h.ip === '127.0.0.1' || h.ip === 'localhost' || h.ip === '0.0.0.0') continue;
      const key = `${h.ip}:${h.port}`;
      if (!seen.has(key)) {
        seen.add(key);
        list.push(h);
      }
    }

    // 2. Merge connected devices that are Wi-Fi or have IP:port serial (e.g. 192.168.1.33:5555)
    for (const d of uniqueConnectedDevices) {
      const isWifi = d.device_type === 'wifi';
      const hasIpSerial =
        d.serial.includes(':') &&
        !d.serial.startsWith('127.0.0.1:') &&
        !d.serial.startsWith('localhost:');
      const hasIpProp = !!d.ip && d.ip !== '127.0.0.1' && d.ip !== 'localhost';

      if (isWifi || hasIpSerial || hasIpProp) {
        let ip = d.ip;
        let port = d.port || 5555;
        if (!ip && d.serial.includes(':')) {
          const parts = d.serial.split(':');
          ip = parts[0];
          port = parseInt(parts[1], 10) || 5555;
        }

        if (ip && ip !== '127.0.0.1' && ip !== 'localhost') {
          const key = `${ip}:${port}`;
          if (!seen.has(key)) {
            seen.add(key);
            list.push({
              ip,
              port,
              name: d.model || `Android (${ip}:${port})`,
              discovery_type: 'mdns',
            });
          }
        }
      }
    }

    return list;
  }, [networkDevices, uniqueConnectedDevices]);

  // Helper to find an active connection for a LAN host
  const findConnectedDeviceForHost = (h: DiscoveredHost): DeviceInfo | undefined => {
    const hostStr = `${h.ip}:${h.port}`;
    return uniqueConnectedDevices.find(
      (c) =>
        c.serial === hostStr ||
        c.serial === `${h.ip}:5555` ||
        (c.ip && c.ip === h.ip) ||
        c.serial.startsWith(`${h.ip}:`)
    );
  };

  // LAN target id: serial of the active connection, otherwise "ip:port".
  // Pairing-only endpoints (Android 11+ "_adb-tls-pairing") can't receive files until paired, so they are
  // excluded from bulk selection/connection unless the device is already connected on another port.
  const getLanTargetId = (h: DiscoveredHost): string | null => {
    const connectedMatch = findConnectedDeviceForHost(h);
    if (connectedMatch) return connectedMatch.serial;
    if (h.discovery_type === 'pairing') return null;
    return `${h.ip}:${h.port}`;
  };

  // One row per LAN host: its active adb connection (if any), selection id and display status
  const lanRows = useMemo<LanRow[]>(
    () =>
      lanHosts.map((h) => {
        const hostId = `${h.ip}:${h.port}`;
        const conn = findConnectedDeviceForHost(h);
        let status: LanRowStatus;
        if (conn) {
          if (conn.state === 'device') {
            // Connected transport that doesn't answer yet (MuMu after a reconnect); a regular phone answers
            // the readiness check within milliseconds, so short checks keep showing «Подключено»
            const busyForLong = conn.readiness === 'checking' && (conn.readiness_ms ?? 0) > 1500;
            status = busyForLong ? 'busy' : conn.readiness === 'unresponsive' ? 'unresponsive' : 'connected';
          } else if (conn.state === 'unauthorized') {
            status = 'unauthorized';
          } else {
            status = conn.reconnecting ? 'reconnecting' : 'offline';
          }
        } else {
          status = h.discovery_type === 'pairing' ? 'needsPairing' : 'disconnected';
        }
        return { hostId, host: h, conn, targetId: getLanTargetId(h), status };
      }),
    [lanHosts, uniqueConnectedDevices]
  );

  const isRowChecked = (r: LanRow) => !!r.targetId && selectedTargetIds.has(r.targetId);

  // Toolbar «Подключить»: checked LAN hosts without a live connection. USB and emulators are never included.
  const connectHosts = unique(
    lanRows
      .filter(
        (r) =>
          isRowChecked(r) &&
          r.host.discovery_type !== 'pairing' &&
          (r.status === 'disconnected' || r.status === 'offline') &&
          !connectingHosts.has(r.hostId)
      )
      .map((r) => r.hostId)
  );

  // Toolbar «Отключить»: checked LAN rows with an adb connection. A pairing endpoint and a connect endpoint
  // on the same IP can map to one serial, hence unique().
  const disconnectSerials = unique(
    lanRows
      .filter(
        (r) => isRowChecked(r) && !!r.conn && r.conn.device_type !== 'usb' && r.conn.device_type !== 'emulator'
      )
      .map((r) => r.conn!.serial)
  );

  const handleConnectSelected = async () => {
    const hosts = connectHosts;
    if (hosts.length === 0 || lanAction !== null || isSending) return;

    setLanStatus(null);
    setLanAction('connect');
    setConnectingHosts((prev) => {
      const next = new Set(prev);
      hosts.forEach((h) => next.add(h));
      return next;
    });

    try {
      const outcomes = await invoke<ConnectOutcome[]>('connect_lan_devices', { hosts });
      const byState = (s: ConnectOutcome['state']) => outcomes.filter((o) => o.state === s).map((o) => o.host);
      const connected = byState('connected');
      const unauthorized = byState('unauthorized');
      const pending = byState('pending');
      const failed = byState('failed');
      const total = outcomes.length;

      const busy = outcomes.filter((o) => o.state === 'connected' && o.busy).map((o) => o.host);
      const parts: string[] = [];
      if (connected.length > 0 || pending.length + unauthorized.length === 0) {
        parts.push(`Подключено: ${connected.length} из ${total}.`);
      }
      if (busy.length > 0) {
        parts.push(
          `Ещё не отвечают: ${busy.length} — эмуляторы MuMu оживают примерно через 2 минуты после переподключения (статус «Ждём ответа»), отправка файлов их дождётся.`
        );
      }
      if (unauthorized.length > 0) {
        parts.push(`Ждут разрешения отладки на экране: ${unauthorized.join(', ')}.`);
      }
      if (pending.length > 0) {
        // Busy devices (MuMu after a reconnect): the adb server keeps connecting them; pressing again
        // would only drop that connection and make the device busy for another ~2 minutes
        parts.push(
          `Ещё подключаются (устройство занято): ${pending.join(', ')} — adb подключит их сам, повторно нажимать не нужно.`
        );
      }
      if (failed.length > 0) {
        const pairingHint = failed.some((h) => !h.endsWith(':5555'))
          ? ' Для Android 11+ может понадобиться сопряжение — кнопка с ключом.'
          : '';
        const reasons = outcomes
          .filter((o) => o.state === 'failed')
          .map((o) => `${o.host} (${o.message})`)
          .join(', ');
        parts.push(`Не удалось: ${reasons}.${pairingHint}`);
      }
      setLanStatus({
        kind: connected.length === total ? 'success' : connected.length + pending.length + unauthorized.length > 0 ? 'warning' : 'error',
        text: parts.join(' '),
      });
    } catch (err: any) {
      setLanStatus({ kind: 'error', text: `Ошибка подключения: ${err}` });
    } finally {
      setConnectingHosts((prev) => {
        const next = new Set(prev);
        hosts.forEach((h) => next.delete(h));
        return next;
      });
      setLanAction(null);
      onRefreshConnectedDevices();
    }
  };

  const handleDisconnectSelected = async () => {
    const serials = disconnectSerials;
    if (serials.length === 0 || lanAction !== null || isSending) return;
    const rowsSnapshot = lanRows;

    setLanStatus(null);
    setLanAction('disconnect');
    setDisconnectingSerials(new Set(serials));

    try {
      const results = await Promise.allSettled(
        serials.map((serial) => invoke<string>('disconnect_device', { serial }))
      );
      const okSerials = serials.filter((_, i) => results[i].status === 'fulfilled');
      const failedSerials = serials.filter((_, i) => results[i].status === 'rejected');

      // Uncheck disconnected devices: an unconnected LAN target would otherwise be silently reconnected
      // by the next transfer. Devices that failed to disconnect stay checked.
      if (okSerials.length > 0) {
        const okSet = new Set(okSerials);
        setSelectedTargetIds((prev) => {
          const next = new Set(prev);
          rowsSnapshot.forEach((r) => {
            if (r.conn && okSet.has(r.conn.serial)) {
              next.delete(r.conn.serial);
              next.delete(r.hostId);
            }
          });
          return next;
        });
      }

      if (failedSerials.length === 0) {
        setLanStatus({
          kind: 'success',
          text: `Отключено: ${okSerials.length}. Эмуляторы MuMu после повторного подключения около 2 минут не отвечают — это нормально.`,
        });
      } else if (okSerials.length > 0) {
        setLanStatus({
          kind: 'warning',
          text: `Отключено: ${okSerials.length} из ${serials.length}. Не удалось: ${failedSerials.join(', ')}.`,
        });
      } else {
        setLanStatus({ kind: 'error', text: `Не удалось отключить: ${failedSerials.join(', ')}.` });
      }
    } finally {
      setDisconnectingSerials(new Set());
      setLanAction(null);
      onRefreshConnectedDevices();
    }
  };

  const handlePairSuccess = async () => {
    if (!pairingTarget) return;
    const targetToConnect = pairingTarget.connectHost;
    setPairingTarget(null);

    // Pairing-only endpoint: the connect port is announced separately, so just refresh and rescan
    if (targetToConnect === null) {
      onRefreshConnectedDevices();
      onScanNetwork();
      return;
    }

    try {
      await invoke('connect_device', { host: targetToConnect });
      onRefreshConnectedDevices();
    } catch (err: any) {
      console.warn(`Автоподключение после сопряжения для ${targetToConnect} не удалось:`, err);
      onRefreshConnectedDevices();
    }
  };

  // Auto-check the sidebar's device only when one appears after there was none. When the active device
  // gets disconnected, App falls back to another device, which must not be checked silently.
  const prevDeviceSerialRef = useRef<string | null>(deviceSerial);
  useEffect(() => {
    const prevSerial = prevDeviceSerialRef.current;
    prevDeviceSerialRef.current = deviceSerial;
    if (deviceSerial && prevSerial === null && selectedTargetIds.size === 0) {
      setSelectedTargetIds(new Set([deviceSerial]));
    }
  }, [deviceSerial]);

  // Success messages hide themselves; warnings and errors stay until dismissed or the next action
  useEffect(() => {
    if (!lanStatus || lanStatus.kind !== 'success') return;
    // Longer messages (with a hint) stay long enough to be read
    const timer = setTimeout(() => setLanStatus(null), lanStatus.text.length > 60 ? 9000 : 4000);
    return () => clearTimeout(timer);
  }, [lanStatus]);

  // Per-host phase of a running «Подключить»: 'waiting' = the device is busy and adb keeps connecting it
  const [waitingHosts, setWaitingHosts] = useState<Set<string>>(new Set());
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen<ConnectProgress>('lan-connect-progress', (event) => {
      const { host, phase } = event.payload;
      setWaitingHosts((prev) => {
        if (phase === 'waiting' ? prev.has(host) : !prev.has(host)) return prev;
        const next = new Set(prev);
        if (phase === 'waiting') next.add(host);
        else next.delete(host);
        return next;
      });
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  // Automatically prune dead/disconnected device IDs from selection
  useEffect(() => {
    setSelectedTargetIds((prev) => {
      const valid = new Set<string>();
      directPcDevices.forEach((d) => {
        if (prev.has(d.serial)) valid.add(d.serial);
      });
      lanHosts.forEach((h) => {
        const hostId = `${h.ip}:${h.port}`;
        const connectedMatch = findConnectedDeviceForHost(h);
        const targetId = connectedMatch ? connectedMatch.serial : hostId;
        if (prev.has(targetId) || prev.has(hostId)) valid.add(targetId);
      });
      return valid;
    });
  }, [directPcDevices, lanHosts]);

  const presets = [
    { label: 'Загрузки', path: '/sdcard/Download', icon: Download },
    { label: 'DCIM / Камера', path: '/sdcard/DCIM/Camera', icon: Image },
    { label: 'Документы', path: '/sdcard/Documents', icon: FileText },
    { label: 'Музыка', path: '/sdcard/Music', icon: Music },
  ];

  // Toggle selection for a device ID
  const toggleDevice = (id: string) => {
    setSelectedTargetIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Tri-state group selection: master checkbox in the toolbar + one per column
  const pcIds = directPcDevices.map((d) => d.serial);
  const lanIds = unique(lanRows.map((r) => r.targetId).filter((id): id is string => id !== null));
  const allIds = unique([...pcIds, ...lanIds]);

  const getGroupState = (ids: string[]): GroupState => {
    if (ids.length === 0) return 'none';
    const checked = ids.filter((id) => selectedTargetIds.has(id)).length;
    if (checked === 0) return 'none';
    return checked === ids.length ? 'all' : 'some';
  };

  // All selected -> clear these ids, otherwise select all of them. Other groups stay untouched.
  const toggleGroup = (ids: string[]) => {
    if (ids.length === 0) return;
    setSelectedTargetIds((prev) => {
      const next = new Set(prev);
      const allChecked = ids.every((id) => prev.has(id));
      ids.forEach((id) => (allChecked ? next.delete(id) : next.add(id)));
      return next;
    });
  };

  // Toolbar «Подключить» / «Отключить» state (network devices only)
  const lanBusy = lanAction !== null || isSending;
  const connectTitle = isSending
    ? 'Дождитесь окончания передачи'
    : connectHosts.length > 0
    ? `Подключить отмеченные устройства в локальной сети: ${connectHosts.length}. USB и эмуляторы не затрагиваются.`
    : 'Отметьте неподключённые устройства в локальной сети';
  const disconnectTitle = isSending
    ? 'Дождитесь окончания передачи'
    : disconnectSerials.length > 0
    ? `Отключить отмеченные устройства в локальной сети: ${disconnectSerials.length}. USB и эмуляторы не затрагиваются. Сопряжённые устройства Android 11+ adb может переподключить автоматически.`
    : 'Нет отмеченных подключённых устройств в локальной сети';
  const lanStatusStyle = lanStatus ? LAN_STATUS_STYLES[lanStatus.kind] : null;

  // Build target list for backend, deduplicating targets
  const buildTargetDevices = (): TargetDevice[] => {
    const targets: TargetDevice[] = [];
    const addedIds = new Set<string>();

    directPcDevices.forEach((d) => {
      if (selectedTargetIds.has(d.serial)) {
        targets.push({
          id: d.serial,
          name: d.model || d.serial,
          is_connected: true,
          device_type: (d.device_type as 'usb' | 'emulator') || 'usb',
        });
        addedIds.add(d.serial);
      }
    });

    lanHosts.forEach((h) => {
      const hostId = `${h.ip}:${h.port}`;
      const connectedMatch = findConnectedDeviceForHost(h);
      const targetId = connectedMatch ? connectedMatch.serial : hostId;

      if (selectedTargetIds.has(targetId) && !addedIds.has(targetId)) {
        if (connectedMatch) {
          targets.push({
            id: connectedMatch.serial,
            name: connectedMatch.model || connectedMatch.serial,
            is_connected: true,
            device_type: 'wifi',
          });
          addedIds.add(connectedMatch.serial);
          addedIds.add(hostId);
        } else if (!addedIds.has(hostId) && h.discovery_type !== 'pairing') {
          targets.push({
            id: hostId,
            name: h.name || hostId,
            is_connected: false,
            device_type: 'lan',
          });
          addedIds.add(hostId);
        }
      }
    });

    return targets;
  };

  // Start sending files to all selected devices
  const startPushing = async (paths: string[]) => {
    // A checked device may be mid-connect/disconnect: pushing now would race the toolbar action
    // (and silently reconnect devices that are being disconnected)
    if (lanActionRef.current !== null) {
      setErrorMsg('Дождитесь окончания подключения или отключения устройств.');
      return;
    }
    const targets = buildTargetDevices();
    if (targets.length === 0) {
      setErrorMsg('Пожалуйста, отметьте хотя бы одно устройство для отправки.');
      return;
    }
    if (paths.length === 0) return;

    setIsSending(true);
    setErrorMsg(null);

    // Reset multiProgress for newly targeted devices
    const initialProgress: Record<string, MultiTransferDeviceProgress> = {};
    targets.forEach((t) => {
      initialProgress[t.id] = {
        device_id: t.id,
        device_name: t.name,
        current_file: 'Подготовка...',
        total_files: paths.length,
        completed_files: 0,
        percentage: 0.0,
        speed_mb_s: 0.0,
        status: t.is_connected ? 'pushing' : 'connecting',
      };
    });
    setMultiProgress(initialProgress);

    try {
      await invoke('push_files_to_multiple_devices', {
        targets,
        localPaths: paths,
        remoteDir: targetRemotePath,
      });
      onTransferTriggered();
    } catch (e: any) {
      setErrorMsg(`Ошибка передачи: ${e}`);
    } finally {
      setIsSending(false);
    }
  };

  const handlePickFiles = async () => {
    try {
      const selected = await invoke<string[]>('pick_local_files');
      if (selected && selected.length > 0) {
        // Current render's function: the selection may have changed while the dialog was open
        startPushingRef.current(selected);
      }
    } catch (e: any) {
      setErrorMsg(`Не удалось выбрать файлы: ${e}`);
    }
  };

  const handlePickFolder = async () => {
    try {
      const selectedFolder = await invoke<string | null>('pick_local_folder');
      if (selectedFolder) {
        startPushingRef.current([selectedFolder]);
      }
    } catch (e: any) {
      setErrorMsg(`Не удалось выбрать папку: ${e}`);
    }
  };

  const selectedTargets = buildTargetDevices();
  const selectedCount = selectedTargets.length;
  const multiProgressList = Object.values(multiProgress);

  // Native drag & drop. Tauri intercepts OS file drops, so the HTML onDrop handler never receives file
  // paths; the webview drag-drop event does. Refs keep the once-registered listener on current state.
  const startPushingRef = useRef(startPushing);
  startPushingRef.current = startPushing;
  const canDropRef = useRef(false);
  canDropRef.current = selectedCount > 0 && !isSending && lanAction === null;
  const isSendingRef = useRef(false);
  isSendingRef.current = isSending;

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;

    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === 'enter' || p.type === 'over') {
          setIsDragOver(true);
        } else if (p.type === 'leave') {
          setIsDragOver(false);
        } else if (p.type === 'drop') {
          setIsDragOver(false);
          if (!canDropRef.current) {
            setErrorMsg(
              isSendingRef.current
                ? 'Дождитесь окончания текущей передачи.'
                : lanActionRef.current !== null
                ? 'Дождитесь окончания подключения или отключения устройств.'
                : 'Отметьте хотя бы одно устройство-получатель перед перетаскиванием файлов.'
            );
            return;
          }
          if (p.paths.length > 0) startPushingRef.current(p.paths);
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });

    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, []);

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0d0f17] overflow-y-auto p-6 space-y-6">
      {/* 1. Target Directory Selector */}
      <div className="p-4 rounded-2xl bg-[#141724] border border-[#212738] shadow-sm space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-sky-500/15 text-sky-400 border border-sky-500/20 flex items-center justify-center">
              <FolderCheck className="w-4 h-4" />
            </div>
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider text-[#7c879c]">
                Папка назначения на устройствах
              </div>
              <div className="text-sm font-mono font-medium text-[#f1f5f9]">
                {targetRemotePath}
              </div>
            </div>
          </div>

          <button
            onClick={onNavigateToExplorer}
            disabled={!deviceSerial}
            className="px-3.5 py-1.5 rounded-xl bg-[#1c2233] hover:bg-sky-500/15 hover:text-sky-300 border border-[#2b334a] hover:border-sky-500/30 text-xs font-medium text-[#cbd5e1] transition flex items-center gap-1.5 disabled:opacity-50"
          >
            <span>Выбрать в проводнике</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Quick Presets */}
        <div className="flex items-center gap-2 pt-1 border-t border-[#1e2333] text-xs">
          <span className="text-[11px] text-[#64748b] mr-1">Быстрый выбор:</span>
          {presets.map((p) => {
            const Icon = p.icon;
            const isActive = targetRemotePath === p.path;
            return (
              <button
                key={p.path}
                onClick={() => onSetTargetRemotePath(p.path)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium transition flex items-center gap-1.5 ${
                  isActive
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                    : 'bg-[#181d2b] hover:bg-[#202638] text-[#94a3b8] hover:text-[#f1f5f9] border border-[#262e44]'
                }`}
              >
                <Icon className="w-3 h-3 text-[#7c879c]" />
                <span>{p.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 2. Recipients: devices connected to the PC and devices in the local network */}
      <div className="p-5 rounded-2xl bg-[#141724] border border-[#212738] shadow-sm space-y-3">
        {/* Toolbar: master checkbox, selection count, bulk connect / disconnect of checked LAN devices */}
        <div className="flex items-center justify-between gap-3 pb-3 border-b border-[#1e2333]">
          <div className="flex items-center gap-2 min-w-0">
            <GroupCheckbox
              state={getGroupState(allIds)}
              disabled={allIds.length === 0}
              onToggle={() => toggleGroup(allIds)}
              selectTitle="Выбрать все"
              clearTitle="Снять выбор"
            />
            <span className="text-xs font-semibold text-[#f1f5f9] truncate">Получатели файлов</span>
            <span className="text-[11px] text-[#7c879c] whitespace-nowrap tabular-nums">выбрано {selectedCount}</span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={handleConnectSelected}
              disabled={connectHosts.length === 0 || lanBusy}
              title={connectTitle}
              className={`${LAN_BUTTON_BASE} bg-emerald-500/10 border-emerald-500/25 text-emerald-300 hover:enabled:bg-emerald-500/20 hover:enabled:border-emerald-500/40`}
            >
              {lanAction === 'connect' ? (
                <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Plug className="w-3.5 h-3.5" />
              )}
              <span>{lanAction === 'connect' ? 'Подключение…' : 'Подключить'}</span>
              {lanAction !== 'connect' && connectHosts.length > 0 && (
                <span className="min-w-4 px-1 rounded bg-emerald-500/20 text-[10px] font-mono tabular-nums text-center">
                  {connectHosts.length}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={handleDisconnectSelected}
              disabled={disconnectSerials.length === 0 || lanBusy}
              title={disconnectTitle}
              className={`${LAN_BUTTON_BASE} bg-[#1a2030] border-[#273047] text-[#cbd5e1] hover:enabled:bg-rose-500/15 hover:enabled:text-rose-300 hover:enabled:border-rose-500/30`}
            >
              {lanAction === 'disconnect' ? (
                <LoaderCircle className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Unplug className="w-3.5 h-3.5" />
              )}
              <span>{lanAction === 'disconnect' ? 'Отключение…' : 'Отключить'}</span>
              {lanAction !== 'disconnect' && disconnectSerials.length > 0 && (
                <span className="min-w-4 px-1 rounded bg-white/10 text-[10px] font-mono tabular-nums text-center">
                  {disconnectSerials.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Result of the last bulk LAN action */}
        {lanStatus && lanStatusStyle && (
          <div
            className={`flex items-start gap-2 px-2.5 py-1.5 rounded-lg border text-[11px] leading-snug ${lanStatusStyle.tone}`}
          >
            <lanStatusStyle.Icon className="w-3.5 h-3.5 shrink-0 mt-px" />
            <span className="flex-1 min-w-0 line-clamp-2 break-words" title={lanStatus.text}>
              {lanStatus.text}
            </span>
            <button
              type="button"
              onClick={() => setLanStatus(null)}
              title="Скрыть"
              className="p-0.5 -m-0.5 rounded opacity-60 hover:opacity-100 hover:bg-white/5 transition"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* SECTION A: Connected directly to PC (USB + Emulators only) */}
          <div className="p-3.5 bg-[#0f111a] rounded-xl border border-[#1e2333] space-y-2.5 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <GroupCheckbox
                  state={getGroupState(pcIds)}
                  disabled={pcIds.length === 0}
                  onToggle={() => toggleGroup(pcIds)}
                  selectTitle="Выбрать все в колонке"
                  clearTitle="Снять выбор в колонке"
                />
                <span className="text-xs font-semibold text-[#f1f5f9] truncate">
                  Подключённые к ПК ({directPcDevices.length})
                </span>
              </div>
              <button
                type="button"
                onClick={onRefreshConnectedDevices}
                disabled={isRefreshingConnectedDevices}
                title="Обновить устройства, подключённые к ПК"
                className="p-1 rounded-md text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 transition disabled:opacity-50 shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingConnectedDevices ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {directPcDevices.length === 0 ? (
              <div className="py-4 text-center text-xs text-[#64748b]">Нет USB-устройств и запущенных эмуляторов.</div>
            ) : (
              <div className="@container space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {directPcDevices.map((d) => {
                  const isChecked = selectedTargetIds.has(d.serial);
                  const isEmulator = d.device_type === 'emulator';
                  const TypeIcon = isEmulator ? Monitor : Usb;
                  const typeLabel = isEmulator ? 'Эмулятор' : 'USB';
                  return (
                    <div
                      key={d.serial}
                      onClick={() => toggleDevice(d.serial)}
                      className={`${ROW_BASE} ${isChecked ? ROW_CHECKED : ROW_UNCHECKED}`}
                    >
                      {isChecked ? (
                        <CheckSquare className="w-4 h-4 text-sky-400 shrink-0" />
                      ) : (
                        <Square className="w-4 h-4 text-[#475569] shrink-0" />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-[#f1f5f9] truncate">{d.model || d.serial}</div>
                        <div className="text-[10px] text-[#64748b] font-mono truncate">{d.serial}</div>
                      </div>
                      <span className="flex items-center gap-1 text-[10px] text-[#7c879c] shrink-0" title={typeLabel}>
                        <TypeIcon className="w-3 h-3" />
                        <span className="hidden @[19rem]:inline">{typeLabel}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* SECTION B: Discovered in LAN (keeps connected devices, with a status dot) */}
          <div className="p-3.5 bg-[#0f111a] rounded-xl border border-[#1e2333] space-y-2.5 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <GroupCheckbox
                  state={getGroupState(lanIds)}
                  disabled={lanIds.length === 0}
                  onToggle={() => toggleGroup(lanIds)}
                  selectTitle="Выбрать все в колонке"
                  clearTitle="Снять выбор в колонке"
                />
                <span className="text-xs font-semibold text-[#f1f5f9] truncate">
                  Локальная сеть ({lanHosts.length})
                </span>
              </div>
              <button
                type="button"
                onClick={onScanNetwork}
                disabled={isScanningNetwork}
                title="Сканировать локальную сеть"
                className="p-1 rounded-md text-sky-400 hover:text-sky-300 hover:bg-sky-500/10 transition disabled:opacity-50 shrink-0"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isScanningNetwork ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {lanRows.length === 0 ? (
              <div className="py-4 text-center text-xs text-[#64748b]">
                {isScanningNetwork ? (
                  'Сканирование локальной сети…'
                ) : (
                  <>
                    Устройства в сети не найдены.{' '}
                    <button type="button" onClick={onScanNetwork} className="text-sky-400 hover:text-sky-300">
                      Сканировать снова
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="@container space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {lanRows.map((r) => {
                  const { host: h, hostId, conn, targetId } = r;
                  const isSelectable = targetId !== null;
                  const isChecked = isRowChecked(r);
                  const isConnecting = connectingHosts.has(hostId);
                  const isDisconnecting = !!conn && disconnectingSerials.has(conn.serial);
                  const isPairingOnly = r.status === 'needsPairing';
                  const view = LAN_ROW_VIEW[r.status];
                  const showPairingButton = (!conn || conn.state === 'offline') && !isConnecting;

                  return (
                    <div
                      key={hostId}
                      onClick={targetId !== null ? () => toggleDevice(targetId) : undefined}
                      title={isSelectable ? undefined : 'Сначала выполните сопряжение — кнопка с ключом'}
                      className={`${ROW_BASE} ${
                        !isSelectable ? ROW_DISABLED : isChecked ? ROW_CHECKED : ROW_UNCHECKED
                      }`}
                    >
                      {isChecked ? (
                        <CheckSquare className="w-4 h-4 text-sky-400 shrink-0" />
                      ) : (
                        <Square className={`w-4 h-4 shrink-0 ${isSelectable ? 'text-[#475569]' : 'text-[#2b3347]'}`} />
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium text-[#f1f5f9] truncate">
                          {conn ? conn.model || conn.serial : h.name || hostId}
                        </div>
                        <div className="text-[10px] text-[#64748b] font-mono truncate">{hostId}</div>
                      </div>

                      {isConnecting ? (
                        waitingHosts.has(hostId) ? (
                          <span
                            className="flex items-center gap-1.5 shrink-0 text-[10px]"
                            title="Устройство занято (например, MuMu после прошлого отключения). adb подключит его сам, как только оно ответит."
                          >
                            <LoaderCircle className="w-3 h-3 animate-spin text-sky-400" />
                            <span className="hidden @[19rem]:inline text-sky-300">Ждём устройство…</span>
                          </span>
                        ) : (
                          <span className="flex items-center gap-1.5 shrink-0 text-[10px]" title="Подключение…">
                            <LoaderCircle className="w-3 h-3 animate-spin text-amber-400" />
                            <span className="hidden @[19rem]:inline text-amber-300">Подключение…</span>
                          </span>
                        )
                      ) : isDisconnecting ? (
                        <span className="flex items-center gap-1.5 shrink-0 text-[10px]" title="Отключение…">
                          <LoaderCircle className="w-3 h-3 animate-spin text-[#94a3b8]" />
                          <span className="hidden @[19rem]:inline text-[#94a3b8]">Отключение…</span>
                        </span>
                      ) : (
                        <span className="flex items-center gap-1.5 shrink-0 text-[10px]" title={view.tooltip}>
                          <span className={`w-1.5 h-1.5 rounded-full ${view.dot}`} />
                          <span className={`hidden @[19rem]:inline ${view.textClass}`}>{view.text}</span>
                        </span>
                      )}

                      {showPairingButton && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            // Pairing endpoint: pair on its own port; the connect port is found by a rescan
                            setPairingTarget(
                              h.discovery_type === 'pairing'
                                ? { host: hostId, connectHost: null }
                                : { host: `${h.ip}:`, connectHost: hostId }
                            );
                          }}
                          title="Сопряжение по коду (Android 11+)"
                          className={`p-1 rounded-md border shrink-0 transition ${
                            isPairingOnly
                              ? 'bg-amber-500/10 border-amber-500/25 text-amber-300 hover:bg-amber-500/20'
                              : 'border-transparent text-amber-400/70 hover:text-amber-300 hover:bg-amber-500/15 hover:border-amber-500/30'
                          }`}
                        >
                          <KeyRound className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 3. Main Drag & Drop / Transfer Action Card */}
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
        }}
        className={`border-2 border-dashed rounded-3xl p-8 flex flex-col items-center justify-center text-center transition ${
          isDragOver
            ? 'border-sky-400 bg-sky-500/10 scale-[0.99] shadow-xl shadow-sky-500/10'
            : 'border-[#262e44] hover:border-[#384360] bg-[#131622]/60'
        } ${selectedCount === 0 ? 'opacity-60' : ''}`}
      >
        <div className="w-14 h-14 rounded-2xl bg-[#1b2030] border border-[#2c354d] flex items-center justify-center text-sky-400 mb-4 shadow-inner">
          <UploadCloud className="w-7 h-7" />
        </div>

        <h3 className="text-base font-semibold text-[#f1f5f9] mb-1.5">
          {selectedCount > 1
            ? `Массовая отправка на ${selectedCount} устройств`
            : selectedCount === 1
            ? 'Отправка файлов на выбранное устройство'
            : 'Выберите устройства выше'}
        </h3>

        <p className="text-xs text-[#8a94a6] mb-6 max-w-sm">
          {selectedCount > 1
            ? 'Файлы будут отправлены параллельно на все отмеченные телефоны через независимые потоки ADB'
            : 'Перетащите файлы сюда или используйте кнопки диалога для быстрой передачи'}
        </p>

        <div className="flex items-center gap-3">
          <button
            onClick={handlePickFiles}
            disabled={selectedCount === 0 || isSending || lanAction !== null}
            className="px-5 py-2.5 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-white rounded-xl text-xs font-semibold transition flex items-center gap-2 shadow-lg shadow-sky-500/20 active:scale-95"
          >
            <FilePlus className="w-4 h-4" />
            Выбрать файлы для отправки
          </button>
          <button
            onClick={handlePickFolder}
            disabled={selectedCount === 0 || isSending || lanAction !== null}
            className="px-5 py-2.5 bg-[#1b2132] hover:bg-[#252c42] disabled:opacity-50 text-[#cbd5e1] rounded-xl text-xs font-semibold transition flex items-center gap-2 border border-[#2d364f] active:scale-95"
          >
            <FolderPlus className="w-4 h-4" />
            Выбрать целую папку
          </button>
        </div>

        {selectedCount === 0 && (
          <div className="mt-4 text-xs text-amber-400 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded-lg">
            Отметьте чекбоксом хотя бы одно устройство в блоке «Получатели файлов» выше
          </div>
        )}
      </div>

      {errorMsg && (
        <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2.5">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* 4. Multi-Device Progress Grid (Active when parallel transfers happen) */}
      {multiProgressList.length > 0 && (
        <div className="rounded-2xl bg-[#141724] border border-[#212738] p-5 space-y-3">
          <div className="flex items-center justify-between pb-2 border-b border-[#1e2333]">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-sky-400" />
              <span className="text-xs font-semibold text-[#f1f5f9]">
                Статус массовой передачи ({multiProgressList.length} устройств)
              </span>
            </div>

            <button
              onClick={() => setMultiProgress({})}
              className="text-[11px] text-[#7c879c] hover:text-[#f1f5f9] flex items-center gap-1 transition"
            >
              <Trash2 className="w-3 h-3" />
              Очистить
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {multiProgressList.map((p) => {
              const isConnecting = p.status === 'connecting';
              const isCompleted = p.status === 'completed';
              const isError = p.status === 'error';

              return (
                <div
                  key={p.device_id}
                  className="p-3.5 bg-[#0f111a] border border-[#1e2333] rounded-xl space-y-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <div className="min-w-0 pr-2">
                      <div className="font-semibold text-[#f1f5f9] truncate">
                        {p.device_name}
                      </div>
                      <div className="text-[10px] text-[#64748b] font-mono truncate">
                        {p.device_id}
                      </div>
                    </div>

                    <div className="shrink-0 text-[11px] font-mono">
                      {isCompleted ? (
                        <span className="text-emerald-400 flex items-center gap-1 font-medium bg-emerald-500/10 px-2 py-0.5 rounded-md border border-emerald-500/20">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Завершено
                        </span>
                      ) : isError ? (
                        <span className="text-rose-400 flex items-center gap-1 font-medium bg-rose-500/10 px-2 py-0.5 rounded-md border border-rose-500/20">
                          <AlertCircle className="w-3.5 h-3.5" />
                          Ошибка
                        </span>
                      ) : isConnecting ? (
                        <span className="text-amber-400 flex items-center gap-1.5 bg-amber-500/10 px-2 py-0.5 rounded-md border border-amber-500/20">
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          Подключение
                        </span>
                      ) : (
                        <span className="text-sky-400 flex items-center gap-1.5 bg-sky-500/10 px-2 py-0.5 rounded-md border border-sky-500/20">
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          {p.percentage.toFixed(0)}%
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full h-1.5 bg-[#1b2030] rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 rounded-full ${
                        isCompleted
                          ? 'bg-emerald-500'
                          : isError
                          ? 'bg-rose-500'
                          : isConnecting
                          ? 'bg-amber-500'
                          : 'bg-gradient-to-r from-sky-500 to-indigo-500'
                      }`}
                      style={{ width: `${isConnecting ? 15 : p.percentage}%` }}
                    />
                  </div>

                  {/* Details & speed */}
                  <div className="flex items-center justify-between text-[11px] text-[#7c879c] font-mono gap-2">
                    <span className="truncate flex-1" title={p.current_file}>
                      {p.current_file || `${p.completed_files}/${p.total_files} файлов`}
                    </span>
                    {p.speed_mb_s > 0 && (
                      <span className="text-sky-400 font-semibold shrink-0">{p.speed_mb_s.toFixed(1)} МБ/с</span>
                    )}
                  </div>

                  {p.error_message && (
                    <div className="text-[11px] text-rose-300 bg-rose-500/10 p-2 rounded-lg border border-rose-500/20 break-words flex items-start gap-1.5 leading-relaxed">
                      <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                      <span>{p.error_message}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 5. General Transfers Queue & History */}
      <div className="rounded-2xl bg-[#141724] border border-[#212738] p-5 space-y-3">
        <div className="flex items-center justify-between pb-2 border-b border-[#1e2333]">
          <div className="flex items-center gap-2">
            <HardDriveUpload className="w-4 h-4 text-sky-400" />
            <span className="text-xs font-semibold text-[#f1f5f9]">
              История передачи файлов ({transfers.length})
            </span>
          </div>

          {transfers.length > 0 && (
            <button
              onClick={onClearTransfers}
              className="text-[11px] text-[#7c879c] hover:text-[#f1f5f9] flex items-center gap-1 transition"
            >
              <Trash2 className="w-3 h-3" />
              Очистить список
            </button>
          )}
        </div>

        {transfers.length === 0 ? (
          <div className="py-6 text-center text-[#64748b] text-xs">
            Передач пока не было. Выберите файлы выше, чтобы начать отправку.
          </div>
        ) : (
          <div className="space-y-2">
            {transfers.map((t) => {
              const isCompleted = t.status === 'completed';
              const isError = t.status === 'error';

              return (
                <div
                  key={t.transfer_id}
                  className="p-3.5 bg-[#0f111a] border border-[#1e2333] rounded-xl space-y-2 text-xs"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-[#f1f5f9] truncate max-w-md" title={t.file_name}>
                      {t.file_name}
                    </span>
                    <span className="text-[11px] font-mono">
                      {isCompleted ? (
                        <span className="text-emerald-400 flex items-center gap-1 font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Передано
                        </span>
                      ) : isError ? (
                        <span className="text-rose-400 flex items-center gap-1 font-medium">
                          <AlertCircle className="w-3.5 h-3.5" />
                          Ошибка
                        </span>
                      ) : (
                        <span className="text-sky-400 flex items-center gap-1.5">
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          {t.percentage.toFixed(0)}%
                        </span>
                      )}
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full h-1.5 bg-[#1b2030] rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 rounded-full ${
                        isCompleted
                          ? 'bg-emerald-500'
                          : isError
                          ? 'bg-rose-500'
                          : 'bg-gradient-to-r from-sky-500 to-indigo-500'
                      }`}
                      style={{ width: `${t.percentage}%` }}
                    />
                  </div>

                  {/* Stats */}
                  <div className="flex items-center justify-between text-[11px] text-[#7c879c] font-mono">
                    <span>
                      {t.total_bytes > 0 ? `${formatBytes(t.total_bytes)}` : 'Обработка...'}
                    </span>
                    {t.speed_mb_s > 0 && (
                      <span className="text-sky-400 font-semibold">{t.speed_mb_s.toFixed(1)} МБ/с</span>
                    )}
                  </div>

                  {t.error_message && (
                    <div className="text-[11px] text-rose-300 bg-rose-500/10 p-2 rounded-lg border border-rose-500/20 break-all">
                      {t.error_message}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Android 11+ Wireless Pairing Modal */}
      <PairingModal
        isOpen={!!pairingTarget}
        initialHost={pairingTarget?.host}
        onClose={() => setPairingTarget(null)}
        onSuccess={handlePairSuccess}
      />
    </div>
  );
};
