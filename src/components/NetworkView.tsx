import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { DiscoveredHost } from '../types';
import {
  Radio,
  Wifi,
  RefreshCw,
  ArrowRight,
  KeyRound,
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
} from 'lucide-react';

interface NetworkViewProps {
  onDeviceConnected: () => void;
}

export const NetworkView: React.FC<NetworkViewProps> = ({ onDeviceConnected }) => {
  // Discovery State
  const [hosts, setHosts] = useState<DiscoveredHost[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const [manualHost, setManualHost] = useState('');
  const [connectingIp, setConnectingIp] = useState<string | null>(null);
  const [discoveryMsg, setDiscoveryMsg] = useState<{ text: string; isError: boolean } | null>(null);

  // Pairing State (Android 11+)
  const [pairHost, setPairHost] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [isPairing, setIsPairing] = useState(false);
  const [pairMsg, setPairMsg] = useState<{ text: string; isError: boolean } | null>(null);

  const startScan = async () => {
    setIsScanning(true);
    setDiscoveryMsg(null);
    try {
      const results = await invoke<DiscoveredHost[]>('discover_network_devices');
      setHosts(results);
      if (results.length === 0) {
        setDiscoveryMsg({
          text: 'Устройств с открытым портом 5555 или активным mDNS не обнаружено.',
          isError: false,
        });
      }
    } catch (e: any) {
      setDiscoveryMsg({ text: `Ошибка сканирования: ${e}`, isError: true });
    } finally {
      setIsScanning(false);
    }
  };

  useEffect(() => {
    startScan();
  }, []);

  const handleConnect = async (hostStr: string) => {
    setConnectingIp(hostStr);
    setDiscoveryMsg(null);
    try {
      const res = await invoke<string>('connect_device', { host: hostStr });
      setDiscoveryMsg({ text: res, isError: false });
      onDeviceConnected();
    } catch (e: any) {
      setDiscoveryMsg({ text: `Не удалось подключиться: ${e}`, isError: true });
    } finally {
      setConnectingIp(null);
    }
  };

  const handlePair = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pairHost.trim() || !pairCode.trim()) return;

    setIsPairing(true);
    setPairMsg(null);

    try {
      const res = await invoke<string>('pair_device', {
        host: pairHost.trim(),
        code: pairCode.trim(),
      });
      setPairMsg({ text: res, isError: false });
      onDeviceConnected();
    } catch (err: any) {
      setPairMsg({ text: `Ошибка сопряжения: ${err}`, isError: true });
    } finally {
      setIsPairing(false);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0d0f17] overflow-y-auto p-6 space-y-6">
      {/* Page Header */}
      <div>
        <h2 className="text-base font-semibold text-[#f1f5f9] tracking-tight">
          Поиск и беспроводное подключение
        </h2>
        <p className="text-xs text-[#8a94a6] mt-0.5">
          Автоматическое обнаружение устройств в локальной сети и сопряжение по коду безопасности
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Card 1: Network Scanner & Direct Connect */}
        <div className="rounded-2xl bg-[#141724] border border-[#212738] p-5 flex flex-col space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-[#1e2333]">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-sky-500/15 text-sky-400 border border-sky-500/20 flex items-center justify-center">
                <Radio className={`w-4 h-4 ${isScanning ? 'animate-pulse' : ''}`} />
              </div>
              <div>
                <h3 className="text-xs font-semibold text-[#f1f5f9]">Обнаружение в сети</h3>
                <p className="text-[11px] text-[#7c879c]">Сканирование подсети :5555 и mDNS</p>
              </div>
            </div>

            <button
              onClick={startScan}
              disabled={isScanning}
              className="px-3 py-1.5 rounded-xl bg-[#1b2132] hover:bg-[#252c42] disabled:opacity-50 border border-[#2d364f] text-xs font-medium text-[#cbd5e1] transition flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isScanning ? 'animate-spin' : ''}`} />
              {isScanning ? 'Поиск...' : 'Сканировать'}
            </button>
          </div>

          {/* Direct Connect Form */}
          <div>
            <label className="text-[11px] font-medium text-[#8a94a6] mb-1.5 block">
              Прямое подключение по IP-адресу
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder="192.168.1.xxx:5555"
                value={manualHost}
                onChange={(e) => setManualHost(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && manualHost.trim() && handleConnect(manualHost.trim())}
                className="flex-1 px-3.5 py-2 bg-[#0f111a] border border-[#212738] rounded-xl text-xs text-[#f1f5f9] placeholder-[#64748b] focus:outline-none focus:border-sky-500 font-mono"
              />
              <button
                onClick={() => manualHost.trim() && handleConnect(manualHost.trim())}
                disabled={!manualHost.trim() || connectingIp === manualHost.trim()}
                className="px-4 py-2 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-white rounded-xl text-xs font-semibold transition flex items-center gap-1.5 shadow-md shadow-sky-500/20"
              >
                {connectingIp === manualHost.trim() ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <ArrowRight className="w-3.5 h-3.5" />
                )}
                Подключить
              </button>
            </div>
          </div>

          {discoveryMsg && (
            <div
              className={`p-3 rounded-xl text-xs flex items-center gap-2 border ${
                discoveryMsg.isError
                  ? 'bg-rose-500/10 border-rose-500/20 text-rose-300'
                  : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
              }`}
            >
              {discoveryMsg.isError ? (
                <AlertCircle className="w-4 h-4 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              )}
              <span>{discoveryMsg.text}</span>
            </div>
          )}

          {/* Discovered List */}
          <div className="flex-1 space-y-2 pt-1">
            <div className="text-[11px] font-semibold uppercase tracking-wider text-[#64748b]">
              Найдено в локальной сети ({hosts.length})
            </div>

            {isScanning && hosts.length === 0 ? (
              <div className="py-12 flex flex-col items-center justify-center text-center space-y-3 bg-[#0f111a] rounded-xl border border-[#1e2333]">
                <div className="w-8 h-8 rounded-full border-2 border-sky-500/20 border-t-sky-400 animate-spin" />
                <p className="text-xs text-[#8a94a6]">Опрашиваем диапазон подсети и mDNS...</p>
              </div>
            ) : hosts.length === 0 ? (
              <div className="py-10 text-center bg-[#0f111a] rounded-xl border border-[#1e2333] px-4 space-y-1">
                <Wifi className="w-6 h-6 text-[#64748b] mx-auto opacity-50" />
                <p className="text-xs text-[#8a94a6]">Устройств пока не найдено</p>
                <p className="text-[11px] text-[#64748b]">
                  Включите «Беспроводная отладка» в настройках разработчика на телефоне
                </p>
              </div>
            ) : (
              <div className="space-y-2 max-h-56 overflow-y-auto">
                {hosts.map((host, idx) => {
                  const targetStr = `${host.ip}:${host.port}`;
                  const isConnecting = connectingIp === targetStr;

                  return (
                    <div
                      key={idx}
                      className="flex items-center justify-between p-3 bg-[#0f111a] border border-[#1e2333] hover:border-[#2d364f] rounded-xl transition"
                    >
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-[#181d2b] flex items-center justify-center text-sky-400">
                          <Wifi className="w-4 h-4" />
                        </div>
                        <div>
                          <div className="text-xs font-semibold text-[#f1f5f9]">{host.name}</div>
                          <div className="text-[11px] font-mono text-[#7c879c] flex items-center gap-2">
                            <span>{targetStr}</span>
                            <span className="text-[10px] px-1.5 py-0.2 rounded bg-[#1c2233] text-[#8a94a6]">
                              {host.discovery_type === 'mdns'
                                ? 'mDNS'
                                : host.discovery_type === 'pairing'
                                ? 'Сопряжение'
                                : 'Port 5555'}
                            </span>
                          </div>
                        </div>
                      </div>

                      <button
                        onClick={() =>
                          // A pairing endpoint can't be connected to; prefill the pairing form instead
                          host.discovery_type === 'pairing' ? setPairHost(targetStr) : handleConnect(targetStr)
                        }
                        disabled={isConnecting}
                        className="px-3 py-1.5 bg-[#1b2132] hover:bg-sky-500 hover:text-white text-[#cbd5e1] text-xs font-semibold rounded-lg transition flex items-center gap-1.5 border border-[#2b334a]"
                      >
                        {isConnecting ? (
                          <>
                            <RefreshCw className="w-3 h-3 animate-spin" />
                            Подключение...
                          </>
                        ) : host.discovery_type === 'pairing' ? (
                          'К сопряжению'
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

        {/* Card 2: Android 11+ Pairing */}
        <div className="rounded-2xl bg-[#141724] border border-[#212738] p-5 flex flex-col space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-[#1e2333]">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-amber-500/15 text-amber-400 border border-amber-500/20 flex items-center justify-center">
                <KeyRound className="w-4 h-4" />
              </div>
              <div>
                <h3 className="text-xs font-semibold text-[#f1f5f9]">Сопряжение Android 11+</h3>
                <p className="text-[11px] text-[#7c879c]">Первичное подключение с 6-значным кодом</p>
              </div>
            </div>

            <div className="flex items-center gap-1 text-[11px] text-[#7c879c]">
              <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
              <span>TLS Security</span>
            </div>
          </div>

          {/* Guide Steps */}
          <div className="p-3 bg-[#0f111a] border border-[#1e2333] rounded-xl text-xs text-[#8a94a6] space-y-1.5">
            <div className="font-semibold text-[#cbd5e1] flex items-center gap-1.5">
              <HelpCircle className="w-3.5 h-3.5 text-amber-400" />
              Шаги на смартфоне:
            </div>
            <p>1. Откройте <span className="text-[#f1f5f9]">Настройки → Для разработчиков → Беспроводная отладка</span>.</p>
            <p>2. Нажмите <span className="text-[#f1f5f9]">«Подключить с помощью кода сопряжения»</span>.</p>
            <p>3. Введите появившийся IP:порт и 6-значный код в поля ниже:</p>
          </div>

          <form onSubmit={handlePair} className="space-y-3">
            <div>
              <label className="text-[11px] font-medium text-[#8a94a6] mb-1 block">
                IP-адрес и порт сопряжения
              </label>
              <input
                type="text"
                required
                placeholder="192.168.1.45:38421"
                value={pairHost}
                onChange={(e) => setPairHost(e.target.value)}
                className="w-full px-3.5 py-2 bg-[#0f111a] border border-[#212738] rounded-xl text-xs text-[#f1f5f9] placeholder-[#64748b] focus:outline-none focus:border-amber-500 font-mono"
              />
            </div>

            <div>
              <label className="text-[11px] font-medium text-[#8a94a6] mb-1 block">
                Код сопряжения (6 цифр)
              </label>
              <input
                type="text"
                required
                maxLength={8}
                placeholder="123456"
                value={pairCode}
                onChange={(e) => setPairCode(e.target.value)}
                className="w-full px-3.5 py-2 bg-[#0f111a] border border-[#212738] rounded-xl text-sm text-[#f1f5f9] placeholder-[#64748b] focus:outline-none focus:border-amber-500 font-mono tracking-widest text-center"
              />
            </div>

            {pairMsg && (
              <div
                className={`p-3 rounded-xl text-xs flex items-center gap-2 border ${
                  pairMsg.isError
                    ? 'bg-rose-500/10 border-rose-500/20 text-rose-300'
                    : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
                }`}
              >
                {pairMsg.isError ? (
                  <AlertCircle className="w-4 h-4 shrink-0" />
                ) : (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                )}
                <span>{pairMsg.text}</span>
              </div>
            )}

            <button
              type="submit"
              disabled={isPairing || !pairHost.trim() || !pairCode.trim()}
              className="w-full py-2.5 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl text-xs font-semibold transition flex items-center justify-center gap-2 shadow-lg shadow-amber-900/20"
            >
              {isPairing && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              Привязать устройство
            </button>
          </form>
        </div>
      </div>
    </div>
  );
};
