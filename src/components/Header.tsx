import React from 'react';
import { DeviceInfo } from '../types';
import {
  Smartphone,
  Wifi,
  Usb,
  Radio,
  KeyRound,
  Settings,
  Sun,
  Moon,
  Zap,
  Power,
  ChevronDown,
  RefreshCw,
} from 'lucide-react';

interface HeaderProps {
  devices: DeviceInfo[];
  selectedDevice: DeviceInfo | null;
  onSelectDevice: (device: DeviceInfo) => void;
  onRefreshDevices: () => void;
  isRefreshingDevices: boolean;
  onOpenDiscovery: () => void;
  onOpenPairing: () => void;
  onOpenAdbSettings: () => void;
  onSwitchToTcpip: () => void;
  onDisconnectDevice: () => void;
  adbStatus: string;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  devices,
  selectedDevice,
  onSelectDevice,
  onRefreshDevices,
  isRefreshingDevices,
  onOpenDiscovery,
  onOpenPairing,
  onOpenAdbSettings,
  onSwitchToTcpip,
  onDisconnectDevice,
  adbStatus,
  theme,
  onToggleTheme,
}) => {
  const isAdbOk = adbStatus && !adbStatus.includes('не найден');

  return (
    <header className="h-16 px-5 border-b border-zinc-800 bg-zinc-950/80 backdrop-blur-md flex items-center justify-between select-none">
      {/* Brand & ADB Status */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-cyan-500 to-blue-600 flex items-center justify-center text-white shadow-lg shadow-cyan-500/20">
            <Zap className="w-4 h-4 fill-white text-white" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="font-semibold text-sm tracking-tight text-zinc-100">TransFile</span>
              <span className="text-[10px] font-medium px-1.5 py-0.2 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
                ADB
              </span>
            </div>
            <div
              onClick={onOpenAdbSettings}
              className="flex items-center gap-1.5 text-[11px] text-zinc-400 hover:text-zinc-300 cursor-pointer transition group"
              title={adbStatus}
            >
              <div
                className={`w-2 h-2 rounded-full ${
                  isAdbOk ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50' : 'bg-rose-400'
                }`}
              />
              <span className="truncate max-w-[140px]">
                {isAdbOk ? 'ADB активен' : 'ADB не найден'}
              </span>
              <Settings className="w-2.5 h-2.5 opacity-0 group-hover:opacity-100 transition" />
            </div>
          </div>
        </div>

        {/* Device Selector */}
        <div className="h-7 w-[1px] bg-zinc-800 mx-1 hidden sm:block" />

        <div className="flex items-center gap-2">
          {devices.length === 0 ? (
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800/80 text-xs text-zinc-400">
              <Smartphone className="w-3.5 h-3.5 text-zinc-500" />
              <span>Нет подключенных устройств</span>
              <button
                onClick={onRefreshDevices}
                className="p-1 hover:text-zinc-200 transition"
                title="Обновить список"
              >
                <RefreshCw className={`w-3 h-3 ${isRefreshingDevices ? 'animate-spin' : ''}`} />
              </button>
            </div>
          ) : (
            <div className="relative flex items-center gap-1.5">
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 shadow-sm">
                {selectedDevice?.device_type === 'wifi' ? (
                  <Wifi className="w-3.5 h-3.5 text-cyan-400" />
                ) : (
                  <Usb className="w-3.5 h-3.5 text-amber-400" />
                )}
                <select
                  value={selectedDevice?.serial || ''}
                  onChange={(e) => {
                    const dev = devices.find((d) => d.serial === e.target.value);
                    if (dev) onSelectDevice(dev);
                  }}
                  className="bg-transparent border-none text-zinc-200 focus:outline-none cursor-pointer text-xs font-medium pr-1"
                >
                  {devices.map((d) => (
                    <option key={d.serial} value={d.serial} className="bg-zinc-900 text-zinc-200">
                      {d.model} ({d.serial}) {d.device_type === 'wifi' ? '• Wi-Fi' : '• USB'}
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-3 h-3 text-zinc-500 pointer-events-none" />
              </div>

              <button
                onClick={onRefreshDevices}
                className="p-1.5 rounded-lg bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-zinc-200 transition"
                title="Обновить устройства"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isRefreshingDevices ? 'animate-spin' : ''}`} />
              </button>

              {/* USB to Wi-Fi quick switch button */}
              {selectedDevice && selectedDevice.device_type === 'usb' && (
                <button
                  onClick={onSwitchToTcpip}
                  className="px-2.5 py-1.5 rounded-lg bg-cyan-500/10 hover:bg-cyan-500/20 text-cyan-400 border border-cyan-500/20 text-[11px] font-medium transition flex items-center gap-1"
                  title="Перевести в режим беспроводного ADB (порт 5555)"
                >
                  <Wifi className="w-3 h-3" />
                  <span>Включить Wi-Fi ADB</span>
                </button>
              )}

              {/* Disconnect wireless button */}
              {selectedDevice && selectedDevice.device_type === 'wifi' && (
                <button
                  onClick={onDisconnectDevice}
                  className="p-1.5 rounded-lg bg-zinc-900 hover:bg-rose-500/20 border border-zinc-800 hover:border-rose-500/30 text-zinc-400 hover:text-rose-400 transition"
                  title="Отключить Wi-Fi устройство"
                >
                  <Power className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Right Controls */}
      <div className="flex items-center gap-2">
        <button
          onClick={onOpenDiscovery}
          className="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 hover:text-white text-xs font-medium transition flex items-center gap-1.5 shadow-sm"
        >
          <Radio className="w-3.5 h-3.5 text-cyan-400" />
          <span>Поиск в сети</span>
        </button>

        <button
          onClick={onOpenPairing}
          className="px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-200 hover:text-white text-xs font-medium transition flex items-center gap-1.5 shadow-sm"
        >
          <KeyRound className="w-3.5 h-3.5 text-amber-400" />
          <span>Сопряжение</span>
        </button>

        <button
          onClick={onOpenAdbSettings}
          className="p-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-zinc-200 transition"
          title="Настройки ADB"
        >
          <Settings className="w-4 h-4" />
        </button>

        <button
          onClick={onToggleTheme}
          className="p-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-zinc-400 hover:text-zinc-200 transition"
          title={theme === 'dark' ? 'Включить светлую тему' : 'Включить тёмную тему'}
        >
          {theme === 'dark' ? <Sun className="w-4 h-4 text-amber-300" /> : <Moon className="w-4 h-4 text-zinc-200" />}
        </button>
      </div>
    </header>
  );
};
