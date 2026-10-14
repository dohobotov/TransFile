import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { DeviceInfo, DiscoveredHost, TransferProgress } from './types';
import { Sidebar, TabType } from './components/Sidebar';
import { TransferView } from './components/TransferView';
import { ExplorerView } from './components/ExplorerView';
import { NetworkView } from './components/NetworkView';
import { SettingsView } from './components/SettingsView';

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

  const loadDevices = async () => {
    if (isRefreshingDevicesRef.current) return;
    isRefreshingDevicesRef.current = true;
    setIsRefreshingDevices(true);
    try {
      const list = await invoke<DeviceInfo[]>('get_connected_devices');
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
    }
  };

  // Discovery only: hosts are listed but never connected automatically. Connecting to every host
  // with an open :5555 would let a rogue "device" in the LAN abuse this PC's ADB key and receive files.
  // Connection happens only on explicit user action ("Подключить все" or per-host buttons).
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
            onTransferTriggered={() => setExplorerRefreshTrigger((c) => c + 1)}
          />
        )}

        {currentTab === 'explorer' && (
          <ExplorerView
            deviceSerial={selectedDevice?.serial || null}
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
