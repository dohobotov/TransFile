import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DiscoveredHost } from '../types';
import { Wifi, RefreshCw, X, Radio, ArrowRight, CheckCircle2, AlertCircle } from 'lucide-react';

interface DiscoveryModalProps {
  isOpen: boolean;
  onClose: () => void;
  onDeviceConnected: () => void;
}

export const DiscoveryModal: React.FC<DiscoveryModalProps> = ({
  isOpen,
  onClose,
  onDeviceConnected,
}) => {
  const [hosts, setHosts] = useState<DiscoveredHost[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [manualHost, setManualHost] = useState('');
  const [connectingIp, setConnectingIp] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError: boolean } | null>(null);

  const startScan = async () => {
    setIsScanning(true);
    setStatusMessage(null);
    try {
      const results = await invoke<DiscoveredHost[]>('discover_network_devices');
      setHosts(results);
      if (results.length === 0) {
        setStatusMessage({ text: 'Устройств с открытым ADB в локальной сети не обнаружено.', isError: false });
      }
    } catch (e: any) {
      setStatusMessage({ text: `Ошибка сканирования: ${e}`, isError: true });
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      startScan();
    }
  }, [isOpen]);

  const handleConnect = async (hostStr: string) => {
    setConnectingIp(hostStr);
    setStatusMessage(null);
    try {
      const res = await invoke<string>('connect_device', { host: hostStr });
      setStatusMessage({ text: res, isError: false });
      onDeviceConnected();
    } catch (e: any) {
      setStatusMessage({ text: `Не удалось подключиться: ${e}`, isError: true });
    } finally {
      setConnectingIp(null);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/50">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              <Radio className="w-5 h-5 animate-pulse" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-zinc-100">Поиск устройств в сети</h3>
              <p className="text-xs text-zinc-400">mDNS (Android 11+) и сканирование подсети :5555</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 max-h-[65vh] overflow-y-auto">
          {/* Manual Connect Row */}
          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1.5 block">
              Быстрое прямое подключение (IP:порт)
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="192.168.1.xxx:5555"
                value={manualHost}
                onChange={(e) => setManualHost(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && manualHost.trim() && handleConnect(manualHost.trim())}
                className="flex-1 px-3.5 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50 transition font-mono"
              />
              <button
                onClick={() => manualHost.trim() && handleConnect(manualHost.trim())}
                disabled={!manualHost.trim() || connectingIp === manualHost.trim()}
                className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-xl text-sm font-medium transition flex items-center gap-1.5 shadow-lg shadow-cyan-900/20"
              >
                {connectingIp === manualHost.trim() ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <ArrowRight className="w-4 h-4" />
                )}
                Подключить
              </button>
            </div>
          </div>

          {/* Status Message */}
          {statusMessage && (
            <div
              className={`p-3 rounded-xl text-xs flex items-center gap-2 border ${
                statusMessage.isError
                  ? 'bg-rose-500/10 border-rose-500/20 text-rose-300'
                  : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
              }`}
            >
              {statusMessage.isError ? (
                <AlertCircle className="w-4 h-4 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              )}
              <span>{statusMessage.text}</span>
            </div>
          )}

          {/* Discovered List */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Обнаружено в сети ({hosts.length})
              </span>
              <button
                onClick={startScan}
                disabled={isScanning}
                className="text-xs text-cyan-400 hover:text-cyan-300 flex items-center gap-1.5 transition disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
                {isScanning ? 'Сканирование...' : 'Обновить поиск'}
              </button>
            </div>

            {isScanning && hosts.length === 0 ? (
              <div className="py-10 flex flex-col items-center justify-center text-center space-y-3 bg-zinc-950/40 rounded-xl border border-zinc-800/50">
                <div className="relative">
                  <div className="w-10 h-10 rounded-full border-2 border-cyan-500/20 border-t-cyan-400 animate-spin" />
                  <Radio className="w-5 h-5 text-cyan-400 absolute inset-0 m-auto" />
                </div>
                <p className="text-xs text-zinc-400">
                  Опрашиваем локальную сеть и слушаем mDNS анонсы...
                </p>
              </div>
            ) : hosts.length === 0 ? (
              <div className="py-8 text-center bg-zinc-950/30 rounded-xl border border-zinc-800/40 px-4">
                <Wifi className="w-8 h-8 text-zinc-600 mx-auto mb-2 opacity-50" />
                <p className="text-xs text-zinc-400">Устройств не найдено</p>
                <p className="text-[11px] text-zinc-500 mt-1">
                  Убедитесь, что на телефоне включена «Беспроводная отладка» и телефон подключен к тому же Wi-Fi.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {hosts.map((host, idx) => {
                  const targetStr = `${host.ip}:${host.port}`;
                  const isConnecting = connectingIp === targetStr;

                  return (
                    <div
                      key={idx}
                      className="flex items-center justify-between p-3 bg-zinc-950/70 border border-zinc-800 hover:border-zinc-700/80 rounded-xl transition group"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-lg bg-zinc-800 flex items-center justify-center text-cyan-400 group-hover:bg-cyan-500/10 transition">
                          <Wifi className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="text-sm font-medium text-zinc-200">{host.name}</div>
                          <div className="text-xs font-mono text-zinc-400 flex items-center gap-2">
                            <span>{targetStr}</span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                              {host.discovery_type === 'mdns' ? 'mDNS' : 'Port 5555'}
                            </span>
                          </div>
                        </div>
                      </div>

                      <button
                        onClick={() => handleConnect(targetStr)}
                        disabled={isConnecting}
                        className="px-3 py-1.5 bg-zinc-800 hover:bg-cyan-600 hover:text-white text-zinc-300 text-xs font-medium rounded-lg transition flex items-center gap-1.5"
                      >
                        {isConnecting ? (
                          <>
                            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                            Подключение...
                          </>
                        ) : (
                          'Подключить'
                        )}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 bg-zinc-950/80 border-t border-zinc-800/80 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-medium rounded-xl transition"
          >
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
};
