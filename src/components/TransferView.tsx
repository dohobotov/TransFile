import React, { useState, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  DeviceInfo,
  DiscoveredHost,
  TargetDevice,
  MultiTransferDeviceProgress,
  TransferProgress,
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
  Radio,
  CheckSquare,
  Square,
  Layers,
  Sparkles,
  Smartphone,
  Monitor,
  KeyRound,
} from 'lucide-react';
import { PairingModal } from './PairingModal';

interface TransferViewProps {
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
  const [isSending, setIsSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Set of selected target IDs (serial for connected, "ip:port" for unconnected network)
  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (deviceSerial) {
      initial.add(deviceSerial);
    } else if (connectedDevices.length > 0) {
      initial.add(connectedDevices[0].serial);
    }
    return initial;
  });

  // Track progress for multi-device parallel transfers
  const [multiProgress, setMultiProgress] = useState<Record<string, MultiTransferDeviceProgress>>({});
  // Track hosts currently connecting
  const [connectingHosts, setConnectingHosts] = useState<Set<string>>(new Set());
  // Track Android 11+ pairing target
  const [pairingTarget, setPairingTarget] = useState<{ host: string; connectHost: string } | null>(null);

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

  const handleConnectHost = async (hostId: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    if (connectingHosts.has(hostId)) return;
    setConnectingHosts((prev) => new Set(prev).add(hostId));
    setErrorMsg(null);
    try {
      await invoke('connect_device', { host: hostId });
      onRefreshConnectedDevices();
    } catch (err: any) {
      const errStr = String(err || '');
      setErrorMsg(`Не удалось подключить ${hostId}: ${errStr}`);
      const lower = errStr.toLowerCase();
      // If connection fails due to authentication or pairing needed, automatically trigger PairingModal
      if (
        lower.includes('сопряжен') ||
        lower.includes('failed to connect') ||
        lower.includes('unable to connect') ||
        lower.includes('cannot connect')
      ) {
        const ip = hostId.split(':')[0];
        setPairingTarget({ host: `${ip}:`, connectHost: hostId });
      }
    } finally {
      setConnectingHosts((prev) => {
        const next = new Set(prev);
        next.delete(hostId);
        return next;
      });
    }
  };

  const handlePairSuccess = async () => {
    if (!pairingTarget) return;
    const targetToConnect = pairingTarget.connectHost;
    setPairingTarget(null);

    try {
      await invoke('connect_device', { host: targetToConnect });
      onRefreshConnectedDevices();
    } catch (err: any) {
      console.warn(`Автоподключение после сопряжения для ${targetToConnect} не удалось:`, err);
      onRefreshConnectedDevices();
    }
  };

  // Sync selected target if deviceSerial changes from outside and nothing was selected
  useEffect(() => {
    if (deviceSerial && selectedTargetIds.size === 0) {
      setSelectedTargetIds(new Set([deviceSerial]));
    }
  }, [deviceSerial]);

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

  // Listen to multi-transfer-progress events from Rust backend
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

    listen<MultiTransferDeviceProgress>('multi-transfer-progress', (event) => {
      const p = event.payload;
      setMultiProgress((prev) => ({
        ...prev,
        [p.device_id]: p,
      }));

      if (p.status === 'completed') {
        onTransferTriggered();
      }
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, [onTransferTriggered]);

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

  const selectAll = () => {
    const next = new Set<string>();
    directPcDevices.forEach((d) => next.add(d.serial));
    lanHosts.forEach((h) => {
      const connectedMatch = findConnectedDeviceForHost(h);
      next.add(connectedMatch ? connectedMatch.serial : `${h.ip}:${h.port}`);
    });
    setSelectedTargetIds(next);
  };

  const selectDirectPcOnly = () => {
    const next = new Set<string>();
    directPcDevices.forEach((d) => next.add(d.serial));
    setSelectedTargetIds(next);
  };

  const selectLanOnly = () => {
    const next = new Set<string>();
    lanHosts.forEach((h) => {
      const connectedMatch = findConnectedDeviceForHost(h);
      next.add(connectedMatch ? connectedMatch.serial : `${h.ip}:${h.port}`);
    });
    setSelectedTargetIds(next);
  };

  const deselectAll = () => {
    setSelectedTargetIds(new Set());
  };

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
        } else if (!addedIds.has(hostId)) {
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
        startPushing(selected);
      }
    } catch (e: any) {
      setErrorMsg(`Не удалось выбрать файлы: ${e}`);
    }
  };

  const handlePickFolder = async () => {
    try {
      const selectedFolder = await invoke<string | null>('pick_local_folder');
      if (selectedFolder) {
        startPushing([selectedFolder]);
      }
    } catch (e: any) {
      setErrorMsg(`Не удалось выбрать папку: ${e}`);
    }
  };

  const selectedTargets = buildTargetDevices();
  const selectedCount = selectedTargets.length;
  const multiProgressList = Object.values(multiProgress);

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

      {/* 2. Target Device Selection (Divided by Connected vs Local Network) */}
      <div className="p-5 rounded-2xl bg-[#141724] border border-[#212738] shadow-sm space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-[#1e2333]">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-sky-400" />
            <span className="text-xs font-semibold text-[#f1f5f9]">
              Получатели файлов ({selectedCount} выбрано)
            </span>
          </div>

          <div className="flex items-center gap-1.5 text-xs">
            <button
              onClick={selectAll}
              className="px-2.5 py-1 rounded-lg bg-[#1a2030] hover:bg-sky-500/20 hover:text-sky-300 border border-[#273047] text-[11px] text-[#cbd5e1] transition"
            >
              Все
            </button>
            <button
              onClick={selectDirectPcOnly}
              className="px-2.5 py-1 rounded-lg bg-[#1a2030] hover:bg-sky-500/20 hover:text-sky-300 border border-[#273047] text-[11px] text-[#cbd5e1] transition"
            >
              На компьютере
            </button>
            <button
              onClick={selectLanOnly}
              className="px-2.5 py-1 rounded-lg bg-[#1a2030] hover:bg-sky-500/20 hover:text-sky-300 border border-[#273047] text-[11px] text-[#cbd5e1] transition"
            >
              В сети LAN
            </button>
            <button
              onClick={deselectAll}
              className="px-2.5 py-1 rounded-lg bg-[#1a2030] hover:bg-rose-500/20 hover:text-rose-300 border border-[#273047] text-[11px] text-[#7c879c] transition"
            >
              Снять выбор
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* SECTION A: Connected directly to PC (USB + Emulators only) */}
          <div className="p-3.5 bg-[#0f111a] rounded-xl border border-[#1e2333] space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Smartphone className="w-3.5 h-3.5 text-sky-400" />
                <span className="text-xs font-semibold text-[#f1f5f9]">
                  Подключенные к компьютеру ({directPcDevices.length})
                </span>
              </div>
              <button
                onClick={onRefreshConnectedDevices}
                disabled={isRefreshingConnectedDevices}
                className="text-[11px] text-sky-400 hover:text-sky-300 flex items-center gap-1 transition disabled:opacity-50"
                title="Сканировать и обновить устройства, подключенные к ПК"
              >
                <RefreshCw className={`w-3 h-3 ${isRefreshingConnectedDevices ? 'animate-spin' : ''}`} />
                <span>Сканировать</span>
              </button>
            </div>

            {directPcDevices.length === 0 ? (
              <div className="py-4 text-center text-xs text-[#64748b]">
                Нет физических подключений (USB) или запущенных эмуляторов.
              </div>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {directPcDevices.map((d) => {
                  const isChecked = selectedTargetIds.has(d.serial);
                  const isEmulator = d.device_type === 'emulator';
                  return (
                    <div
                      key={d.serial}
                      onClick={() => toggleDevice(d.serial)}
                      className={`p-2.5 rounded-lg border cursor-pointer transition flex items-center justify-between ${
                        isChecked
                          ? isEmulator
                            ? 'bg-indigo-500/15 border-indigo-500/40 text-[#f1f5f9]'
                            : 'bg-sky-500/15 border-sky-500/40 text-[#f1f5f9]'
                          : 'bg-[#151926] hover:bg-[#1a2030] border-[#222a3d] text-[#94a3b8]'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {isChecked ? (
                          <CheckSquare className={`w-4 h-4 shrink-0 ${isEmulator ? 'text-indigo-400' : 'text-sky-400'}`} />
                        ) : (
                          <Square className="w-4 h-4 text-[#475569] shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="text-xs font-medium truncate text-[#f1f5f9]">
                            {d.model || d.serial}
                          </div>
                          <div className="text-[10px] text-[#64748b] font-mono truncate">
                            {d.serial}
                          </div>
                        </div>
                      </div>

                      <span
                        className={`text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 flex items-center gap-1 ${
                          isEmulator
                            ? 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30'
                            : 'bg-sky-500/15 text-sky-300 border border-sky-500/30'
                        }`}
                      >
                        {isEmulator ? (
                          <Monitor className="w-2.5 h-2.5" />
                        ) : (
                          <Usb className="w-2.5 h-2.5" />
                        )}
                        {isEmulator ? 'Эмулятор' : 'USB'}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* SECTION B: Discovered in LAN (Retains connected devices with status badge) */}
          <div className="p-3.5 bg-[#0f111a] rounded-xl border border-[#1e2333] space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Radio className="w-3.5 h-3.5 text-indigo-400" />
                <span className="text-xs font-semibold text-[#f1f5f9]">
                  Обнаруженные в локальной сети ({lanHosts.length})
                </span>
              </div>
              <button
                onClick={onScanNetwork}
                disabled={isScanningNetwork}
                className="text-[11px] text-sky-400 hover:text-sky-300 flex items-center gap-1 transition disabled:opacity-50"
              >
                <RefreshCw className={`w-3 h-3 ${isScanningNetwork ? 'animate-spin' : ''}`} />
                <span>Сканировать</span>
              </button>
            </div>

            {lanHosts.length === 0 ? (
              <div className="py-4 text-center text-xs text-[#64748b]">
                {isScanningNetwork
                  ? 'Сканирование локальной сети...'
                  : 'Устройства в сети не обнаружены. Нажмите «Сканировать».'}
              </div>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                {lanHosts.map((h) => {
                  const hostId = `${h.ip}:${h.port}`;
                  const connectedDevice = findConnectedDeviceForHost(h);
                  const isConnected = !!connectedDevice && connectedDevice.state === 'device';
                  const isUnauthorized = !!connectedDevice && connectedDevice.state === 'unauthorized';
                  const isOffline = !!connectedDevice && connectedDevice.state === 'offline';
                  const isConnecting = connectingHosts.has(hostId);

                  const targetId = connectedDevice ? connectedDevice.serial : hostId;
                  const isChecked = selectedTargetIds.has(targetId);

                  return (
                    <div
                      key={hostId}
                      onClick={() => toggleDevice(targetId)}
                      className={`p-2.5 rounded-lg border cursor-pointer transition flex items-center justify-between ${
                        isChecked
                          ? isConnected
                            ? 'bg-emerald-500/15 border-emerald-500/40 text-[#f1f5f9]'
                            : 'bg-indigo-500/15 border-indigo-500/40 text-[#f1f5f9]'
                          : 'bg-[#151926] hover:bg-[#1a2030] border-[#222a3d] text-[#94a3b8]'
                      }`}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {isChecked ? (
                          <CheckSquare
                            className={`w-4 h-4 shrink-0 ${isConnected ? 'text-emerald-400' : 'text-indigo-400'}`}
                          />
                        ) : (
                          <Square className="w-4 h-4 text-[#475569] shrink-0" />
                        )}
                        <div className="min-w-0">
                          <div className="text-xs font-medium truncate text-[#f1f5f9]">
                            {connectedDevice ? (connectedDevice.model || connectedDevice.serial) : (h.name || hostId)}
                          </div>
                          <div className="text-[10px] text-[#64748b] font-mono truncate">
                            {hostId}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {/* Traffic light status indicator */}
                        {isConnecting ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 bg-amber-500/15 text-amber-300 border border-amber-500/30 flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-sm shadow-amber-400/50" />
                            <span>Подключение...</span>
                          </span>
                        ) : isConnected ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-emerald-400 shadow-sm shadow-emerald-400/50" />
                            <span>Подключено</span>
                          </span>
                        ) : isUnauthorized ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 bg-amber-500/15 text-amber-300 border border-amber-500/30 flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse shadow-sm shadow-amber-400/50" />
                            <span>Ожидает авторизации</span>
                          </span>
                        ) : isOffline ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 bg-rose-500/15 text-rose-300 border border-rose-500/30 flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-rose-500 shadow-sm shadow-rose-500/50" />
                            <span>Офлайн</span>
                          </span>
                        ) : (
                          <span className="text-[10px] px-2 py-0.5 rounded-full font-medium shrink-0 bg-rose-500/15 text-rose-300 border border-rose-500/30 flex items-center gap-1.5">
                            <span className="w-2 h-2 rounded-full bg-rose-500 shadow-sm shadow-rose-500/50" />
                            <span>Не подключено</span>
                          </span>
                        )}

                        {!connectedDevice && !isConnecting && (
                          <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                setPairingTarget({ host: `${h.ip}:`, connectHost: hostId });
                              }}
                              className="px-2 py-0.5 rounded-md bg-[#1c2233] hover:bg-amber-500/20 hover:text-amber-300 border border-[#2d364f] hover:border-amber-500/40 text-[10px] font-medium text-[#cbd5e1] transition flex items-center gap-1"
                              title="Сопряжение по коду безопасности Android 11+"
                            >
                              <KeyRound className="w-3 h-3 text-amber-400" />
                              <span>Сопряжение</span>
                            </button>
                            <button
                              onClick={(e) => handleConnectHost(hostId, e)}
                              className="px-2 py-0.5 rounded-md bg-[#1c2233] hover:bg-sky-500 hover:text-white border border-[#2d364f] hover:border-sky-500 text-[10px] font-medium text-[#cbd5e1] transition"
                              title="Подключить устройство по Wi-Fi прямо сейчас"
                            >
                              Подключить
                            </button>
                          </div>
                        )}
                      </div>
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
            disabled={selectedCount === 0 || isSending}
            className="px-5 py-2.5 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-white rounded-xl text-xs font-semibold transition flex items-center gap-2 shadow-lg shadow-sky-500/20 active:scale-95"
          >
            <FilePlus className="w-4 h-4" />
            Выбрать файлы для отправки
          </button>
          <button
            onClick={handlePickFolder}
            disabled={selectedCount === 0 || isSending}
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
