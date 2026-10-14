import React from 'react';
import { DeviceInfo } from '../types';
import {
  UploadCloud,
  FolderTree,
  Radio,
  Settings,
  Smartphone,
  Wifi,
  Usb,
  Monitor,
  RefreshCw,
  Power,
  ChevronDown,
} from 'lucide-react';

export type TabType = 'transfer' | 'explorer' | 'network' | 'settings';

interface SidebarProps {
  currentTab: TabType;
  onSelectTab: (tab: TabType) => void;
  devices: DeviceInfo[];
  selectedDevice: DeviceInfo | null;
  onSelectDevice: (device: DeviceInfo) => void;
  onRefreshDevices: () => void;
  isRefreshingDevices: boolean;
  onSwitchToTcpip: () => void;
  onDisconnectDevice: () => void;
  adbStatus: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onSelectTab,
  devices,
  selectedDevice,
  onSelectDevice,
  onRefreshDevices,
  isRefreshingDevices,
  onSwitchToTcpip,
  onDisconnectDevice,
  adbStatus,
}) => {
  const isAdbOk = adbStatus && !adbStatus.includes('не найден');

  const navItems = [
    {
      id: 'transfer' as TabType,
      label: 'Отправка файлов',
      icon: UploadCloud,
      badge: null,
    },
    {
      id: 'explorer' as TabType,
      label: 'Файлы устройства',
      icon: FolderTree,
      badge: selectedDevice ? 'Онлайн' : null,
    },
    {
      id: 'network' as TabType,
      label: 'Поиск и сопряжение',
      icon: Radio,
      badge: null,
    },
    {
      id: 'settings' as TabType,
      label: 'Настройки ADB',
      icon: Settings,
      badge: null,
    },
  ];

  return (
    <aside className="w-64 bg-[#11141e] border-r border-[#1e2333] flex flex-col h-full select-none shrink-0">
      {/* Brand & ADB Status */}
      <div className="p-4 border-b border-[#1e2333]">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-sky-500 to-indigo-600 flex items-center justify-center text-white shadow-md shadow-sky-500/20 font-bold text-sm tracking-wider">
            TF
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-sm text-[#f1f5f9] tracking-tight">TransFile</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">
                v1.1
              </span>
            </div>
            <div
              onClick={() => onSelectTab('settings')}
              className="flex items-center gap-1.5 text-[11px] text-[#8a94a6] hover:text-[#cbd5e1] cursor-pointer transition mt-0.5"
              title={adbStatus}
            >
              <div
                className={`w-1.5 h-1.5 rounded-full ${
                  isAdbOk ? 'bg-emerald-400 shadow-sm shadow-emerald-400/50' : 'bg-rose-400'
                }`}
              />
              <span className="truncate">{isAdbOk ? 'ADB подключен' : 'ADB не найден'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Device Selector Card */}
      <div className="p-3 border-b border-[#1e2333] bg-[#0e1017]">
        <div className="flex items-center justify-between text-[11px] font-medium text-[#7c879c] mb-1.5 px-1">
          <span>АКТИВНОЕ УСТРОЙСТВО</span>
          <button
            onClick={onRefreshDevices}
            className="p-1 hover:text-[#f1f5f9] transition rounded"
            title="Обновить устройства"
          >
            <RefreshCw className={`w-3 h-3 ${isRefreshingDevices ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {devices.length === 0 ? (
          <div
            onClick={() => onSelectTab('network')}
            className="p-2.5 rounded-xl bg-[#161a26] border border-[#242b3d] hover:border-sky-500/40 text-xs text-[#94a3b8] cursor-pointer transition group"
          >
            <div className="flex items-center gap-2 text-[#cbd5e1] font-medium mb-1">
              <Smartphone className="w-3.5 h-3.5 text-[#64748b]" />
              <span>Устройства не найдены</span>
            </div>
            <p className="text-[11px] text-[#64748b] group-hover:text-sky-400 transition">
              Нажмите для поиска в сети →
            </p>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="relative">
              <div className="flex items-center gap-2 p-2 rounded-xl bg-[#161a26] border border-[#242b3d] text-xs text-[#f1f5f9]">
                {selectedDevice?.device_type === 'emulator' ? (
                  <Monitor className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
                ) : selectedDevice?.device_type === 'wifi' ? (
                  <Wifi className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                ) : (
                  <Usb className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                )}
                <select
                  value={selectedDevice?.serial || ''}
                  onChange={(e) => {
                    const dev = devices.find((d) => d.serial === e.target.value);
                    if (dev) onSelectDevice(dev);
                  }}
                  className="bg-transparent border-none text-[#f1f5f9] focus:outline-none cursor-pointer text-xs font-medium w-full pr-4 truncate"
                >
                  {devices.map((d) => (
                    <option key={d.serial} value={d.serial} className="bg-[#11141e] text-[#f1f5f9]">
                      {d.model} ({d.device_type === 'emulator' ? 'Эмулятор' : d.device_type === 'wifi' ? 'Wi-Fi' : 'USB'})
                    </option>
                  ))}
                </select>
                <ChevronDown className="w-3 h-3 text-[#64748b] absolute right-2 pointer-events-none" />
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px] px-1 font-mono text-[#7c879c]">
              <span className="truncate max-w-[130px]">{selectedDevice?.serial}</span>
              {selectedDevice?.device_type === 'usb' ? (
                <button
                  onClick={onSwitchToTcpip}
                  className="text-sky-400 hover:text-sky-300 transition text-[10px]"
                  title="Перевести в режим Wi-Fi (порт 5555)"
                >
                  Вкл. Wi-Fi
                </button>
              ) : selectedDevice?.device_type === 'wifi' ? (
                <button
                  onClick={onDisconnectDevice}
                  className="text-rose-400 hover:text-rose-300 transition flex items-center gap-1 text-[10px]"
                  title="Отключить устройство"
                >
                  <Power className="w-2.5 h-2.5" />
                  Отключить
                </button>
              ) : (
                <span className="text-[10px] text-indigo-400 font-sans">Эмулятор ПК</span>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Navigation Menu */}
      <nav className="p-3 space-y-1 flex-1 overflow-y-auto">
        <div className="px-2 py-1 text-[10px] font-semibold tracking-wider text-[#64748b] uppercase">
          Разделы
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;

          return (
            <button
              key={item.id}
              onClick={() => onSelectTab(item.id)}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-xs font-medium transition ${
                isActive
                  ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30 font-semibold shadow-sm shadow-sky-500/10'
                  : 'text-[#94a3b8] hover:text-[#f1f5f9] hover:bg-[#161a26] border border-transparent'
              }`}
            >
              <div className="flex items-center gap-2.5">
                <Icon
                  className={`w-4 h-4 transition ${isActive ? 'text-sky-400' : 'text-[#64748b]'}`}
                />
                <span>{item.label}</span>
              </div>
              {item.badge && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-mono">
                  {item.badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Footer Info */}
      <div className="p-3 border-t border-[#1e2333] bg-[#0e1017] text-[11px] text-[#64748b] flex items-center justify-between">
        <span>TransFile Core</span>
        <span className="font-mono text-[#94a3b8]">Rust 1.98</span>
      </div>
    </aside>
  );
};
