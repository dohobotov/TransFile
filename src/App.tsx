import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { DeviceInfo, DiscoveredHost, MultiTransferDeviceProgress, TransferProgress } from './types';
import { Sidebar, TabType } from './components/Sidebar';
import { TransferSession, TransferView } from './components/TransferView';
import { ExplorerView } from './components/ExplorerView';
import { NetworkView } from './components/NetworkView';
import { SettingsView } from './components/SettingsView';
import { markAllDirectoriesStale, prefetchDevice } from './explorerCache';

export function App() {
  const [currentTab, setCurrentTab] = useState<TabType>('transfer');
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<DeviceInfo | null>(null);
  const [adbStatus, setAdbStatus] = useState<string>('');
  const [isRefreshingDevices, setIsRefreshingDevices] = useState<boolean>(false);
  const [targetRemotePath, setTargetRemotePath] = useState<string>('/sdcard/Download');
  const [explorerCurrentPath, setExplorerCurrentPath] = useState<string>('/sdcard/Download');
  const [transfers, setTransfers] = useState<TransferProgress[]>([]);
  const [explorerRefreshTrigger, setExplorerRefreshTrigger] = useState<number>(0);
  const [networkHosts, setNetworkHosts] = useState<DiscoveredHost[]>([]);
  const [isScanningNetwork, setIsScanningNetwork] = useState<boolean>(false);

  // Transfer tab state kept here so that switching to Explorer and back keeps the checked recipients, the
  // per-device progress of a running mass transfer and the «sending» lock (TransferView unmounts on switch).
  const [selectedTargetIds, setSelectedTargetIds] = useState<Set<string>>(() => new Set());
  const [multiProgress, setMultiProgress] = useState<Record<string, MultiTransferDeviceProgress>>({});
  const [isSending, setIsSending] = useState(false);
  const transferSession: TransferSession = {
    selectedTargetIds,
    setSelectedTargetIds,
    multiProgress,
    setMultiProgress,
    isSending,
    setIsSending,
  };

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let disposed = false;
    listen<MultiTransferDeviceProgress>('multi-transfer-progress', (event) => {
      const p = event.payload;
      setMultiProgress((prev) => ({ ...prev, [p.device_id]: p }));
      if (p.status === 'completed') {
        // Prefetched listings must not hide the new files when Explorer is opened right after a transfer
        markAllDirectoriesStale();
        setExplorerRefreshTrigger((c) => c + 1);
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlistenFn = unlisten;
    });
    return () => {
      disposed = true;
      if (unlistenFn) unlistenFn();
    };
  }, []);

  // Check ADB status and load devices
  const checkAdb = async () => {
    try {
      const status = await invoke<string>('check_adb_status');
      setAdbStatus(status);
    } catch (e: any) {
      setAdbStatus(`Ошибка: ${e}`);
    }
  };

  const isRefreshingDevicesRef = useRef(false);
  // A refresh requested while one is running must not be lost (the device list may have changed meanwhile)
  const refreshAgainRef = useRef(false);

  const loadDevices = async () => {
    if (isRefreshingDevicesRef.current) {
      refreshAgainRef.current = true;
      return;
    }
    isRefreshingDevicesRef.current = true;
    setIsRefreshingDevices(true);
    try {
      const fetchedAt = Date.now();
      const list = (await invoke<DeviceInfo[]>('get_connected_devices')).map((d) => ({
        ...d,
        // Absolute start of the readiness check, so «waiting» timers don't restart on every refresh
        readiness_since: d.readiness === 'checking' && d.readiness_ms != null ? fetchedAt - d.readiness_ms : null,
      }));
      const seenSerials = new Set<string>();
      const deduped = list
        .filter((d) => {
          if (!d.serial || seenSerials.has(d.serial)) return false;
          seenSerials.add(d.serial);
          return true;
        })
        .filter((dev, _, arr) => {
          if (dev.serial.startsWith('emulator-')) {
            const hasIpEquiv = arr.some(
              (o) => o.serial.startsWith('127.0.0.1:') && o.model === dev.model
            );
            if (hasIpEquiv) return false;
          }
          const isLoopback = dev.serial.startsWith('127.0.0.1:') || dev.serial.startsWith('localhost:');
          if (isLoopback) {
            const parts = dev.serial.split(':');
            const port = parseInt(parts[1], 10);
            const is55Mirror = !isNaN(port) && port >= 5500 && port <= 5700;
            const is7555Mirror = port === 7555;
            if (is55Mirror || is7555Mirror) {
              const has16Port = arr.some((o) => {
                const oIsLoopback = o.serial.startsWith('127.0.0.1:') || o.serial.startsWith('localhost:');
                if (!oIsLoopback) return false;
                const oPort = parseInt(o.serial.split(':')[1], 10);
                return !isNaN(oPort) && oPort >= 16000 && oPort <= 21000 && o.model === dev.model;
              });
              if (has16Port) return false;
            }
          }
          return true;
        });
      setDevices(deduped);

      // Preserve active device selection without resetting to list[0]
      setSelectedDevice((prev) => {
        if (!prev) return deduped[0] || null;
        const match = deduped.find((d) => d.serial === prev.serial);
        return match || deduped[0] || null;
      });
    } catch (e) {
      console.error('Failed to load devices:', e);
    } finally {
      setIsRefreshingDevices(false);
      isRefreshingDevicesRef.current = false;
      if (refreshAgainRef.current) {
        refreshAgainRef.current = false;
        loadDevicesRef.current();
      }
    }
  };
  const loadDevicesRef = useRef(loadDevices);
  loadDevicesRef.current = loadDevices;

  // The backend follows `adb track-devices` and readiness probes: refresh on every change, so a device that
  // comes back from "offline" (or starts answering after a reconnect) is shown without manual refresh.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    listen('adb-devices-changed', () => {
      clearTimeout(timer);
      timer = setTimeout(() => loadDevicesRef.current(), 300);
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      clearTimeout(timer);
      if (unlisten) unlisten();
    };
  }, []);

  // Discovery only: hosts are listed but never connected automatically. Connecting to every host
  // with an open :5555 would let a rogue "device" in the LAN abuse this PC's ADB key and receive files.
  // Connection happens only on explicit user action (the «Подключить» button for checked devices).
  const scanNetwork = async () => {
    setIsScanningNetwork(true);
    try {
      const results = await invoke<DiscoveredHost[]>('discover_network_devices');
      setNetworkHosts(results);
    } catch (e) {
      console.error('Failed to discover network devices:', e);
    } finally {
      setIsScanningNetwork(false);
    }
  };

  useEffect(() => {
    checkAdb();
    loadDevices();
    scanNetwork();
  }, []);

  // Warm the Explorer cache as soon as a usable device is selected, so opening «Файлы устройства»
  // renders from cache instead of waiting for adb (which also absorbs the Wi-Fi wake-up delay of an idle
  // phone). Keyed on serial/state only: device list refreshes create new objects for the same device.
  const explorerPathRef = useRef(explorerCurrentPath);
  useEffect(() => {
    explorerPathRef.current = explorerCurrentPath;
  }, [explorerCurrentPath]);

  const selectedSerial = selectedDevice?.serial;
  const selectedState = selectedDevice?.state;
  const selectedReadiness = selectedDevice?.readiness;
  useEffect(() => {
    // A device that is connected but not answering yet (MuMu right after a reconnect) would only make the
    // prefetch time out; it runs as soon as the readiness probe reports 'ready'.
    if (!selectedSerial || selectedState !== 'device' || selectedReadiness === 'checking') return;
    prefetchDevice(selectedSerial, explorerPathRef.current);
  }, [selectedSerial, selectedState, selectedReadiness]);

  // Listen to file transfer progress from Rust
  useEffect(() => {
    let unlistenFn: (() => void) | undefined;

    listen<TransferProgress>('transfer-progress', (event) => {
      const data = event.payload;
      setTransfers((prev) => {
        const existingIdx = prev.findIndex((t) => t.transfer_id === data.transfer_id);
        if (existingIdx >= 0) {
          const next = [...prev];
          next[existingIdx] = data;
          return next;
        } else {
          return [data, ...prev];
        }
      });

      if (data.status === 'completed') {
        // Prefetched listings must not hide the new files when Explorer is opened right after a transfer
        markAllDirectoriesStale();
        setExplorerRefreshTrigger((c) => c + 1);
      }
    }).then((unlisten) => {
      unlistenFn = unlisten;
    });

    return () => {
      if (unlistenFn) unlistenFn();
    };
  }, []);

  const handleSwitchToTcpip = async () => {
    if (!selectedDevice) return;
    try {
      await invoke('switch_to_tcpip', {
        serial: selectedDevice.serial,
        port: 5555,
      });
      alert('Устройство переведено в режим Wi-Fi (порт 5555). Теперь можно отсоединить USB кабель и подключиться в разделе «Поиск и сопряжение»!');
      loadDevices();
    } catch (e: any) {
      alert(`Ошибка переключения: ${e}`);
    }
  };

  const handleDisconnect = async () => {
    if (!selectedDevice) return;
    try {
      await invoke('disconnect_device', { serial: selectedDevice.serial });
      loadDevices();
    } catch (e: any) {
      alert(`Ошибка отключения: ${e}`);
    }
  };

  const handleSetTargetRemotePath = (path: string) => {
    setTargetRemotePath(path);
    setExplorerCurrentPath(path);
  };

  return (
    <div className="h-screen w-screen flex bg-[#0d0f17] text-[#f1f5f9] antialiased overflow-hidden select-none">
      {/* Sidebar Navigation */}
      <Sidebar
        currentTab={currentTab}
        onSelectTab={setCurrentTab}
        devices={devices}
        selectedDevice={selectedDevice}
        onSelectDevice={setSelectedDevice}
        onRefreshDevices={loadDevices}
        isRefreshingDevices={isRefreshingDevices}
        onSwitchToTcpip={handleSwitchToTcpip}
        onDisconnectDevice={handleDisconnect}
        adbStatus={adbStatus}
      />

      {/* Main Content Area */}
      <main className="flex-1 flex min-h-0 min-w-0 overflow-hidden bg-[#0d0f17]">
        {currentTab === 'transfer' && (
          <TransferView
            transferSession={transferSession}
            deviceSerial={selectedDevice?.serial || null}
            connectedDevices={devices}
            onRefreshConnectedDevices={loadDevices}
            isRefreshingConnectedDevices={isRefreshingDevices}
            networkDevices={networkHosts}
            isScanningNetwork={isScanningNetwork}
            onScanNetwork={scanNetwork}
            targetRemotePath={targetRemotePath}
            onSetTargetRemotePath={handleSetTargetRemotePath}
            onNavigateToExplorer={() => setCurrentTab('explorer')}
            transfers={transfers}
            onClearTransfers={() => setTransfers([])}
            onTransferTriggered={() => {
              markAllDirectoriesStale();
              setExplorerRefreshTrigger((c) => c + 1);
            }}
          />
        )}

        {currentTab === 'explorer' && (
          <ExplorerView
            deviceSerial={selectedDevice?.serial || null}
            deviceState={selectedDevice?.state ?? null}
            deviceReadiness={selectedDevice?.readiness ?? null}
            deviceCheckingSince={selectedDevice?.readiness_since ?? null}
            currentPath={explorerCurrentPath}
            onPathChange={setExplorerCurrentPath}
            targetRemotePath={targetRemotePath}
            onSetAsTargetDestination={handleSetTargetRemotePath}
            onNavigateToTransfer={() => setCurrentTab('transfer')}
            refreshTrigger={explorerRefreshTrigger}
          />
        )}

        {currentTab === 'network' && (
          <NetworkView
            onDeviceConnected={() => {
              loadDevices();
            }}
          />
        )}

        {currentTab === 'settings' && (
          <SettingsView
            adbStatus={adbStatus}
            onAdbUpdated={() => {
              checkAdb();
              loadDevices();
            }}
          />
        )}
      </main>
    </div>
  );
}

export default App;
