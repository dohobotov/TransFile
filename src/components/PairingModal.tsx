import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { KeyRound, X, CheckCircle2, AlertCircle, RefreshCw, ShieldCheck } from 'lucide-react';

interface PairingModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (pairedHost?: string) => void;
  initialHost?: string;
}

export const PairingModal: React.FC<PairingModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  initialHost,
}) => {
  const [host, setHost] = useState(initialHost || '');
  const [code, setCode] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<{ text: string; isError: boolean } | null>(null);

  useEffect(() => {
    if (isOpen) {
      setHost(initialHost || '');
      setCode('');
      setStatus(null);
    }
  }, [isOpen, initialHost]);

  if (!isOpen) return null;

  const handlePair = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!host.trim() || !code.trim()) return;

    setIsLoading(true);
    setStatus(null);

    try {
      const res = await invoke<string>('pair_device', {
        host: host.trim(),
        code: code.trim(),
      });
      setStatus({ text: res, isError: false });
      setTimeout(() => {
        onSuccess(host.trim());
        onClose();
      }, 1000);
    } catch (err: any) {
      setStatus({ text: `Ошибка сопряжения: ${err}`, isError: true });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/50">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-500/10 text-amber-400 border border-amber-500/20">
              <KeyRound className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-zinc-100">Сопряжение Android 11+</h3>
              <p className="text-xs text-zinc-400">Первичное подключение по коду безопасности</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handlePair} className="p-6 space-y-4">
          <div className="p-3 bg-zinc-950/60 border border-zinc-800/60 rounded-xl text-xs text-zinc-400 space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-zinc-300">
              <ShieldCheck className="w-4 h-4 text-amber-400" />
              Инструкция на телефоне:
            </div>
            <p>
              1. Откройте <span className="text-zinc-200">Настройки → Для разработчиков → Беспроводная отладка</span>.
            </p>
            <p>
              2. Нажмите <span className="text-zinc-200">«Подключить с помощью кода сопряжения»</span>.
            </p>
            <p>3. Введите IP-адрес с динамическим портом и 6-значный код ниже.</p>
          </div>

          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">
              IP-адрес и порт сопряжения
            </label>
            <input
              type="text"
              required
              placeholder="192.168.1.45:38421"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              className="w-full px-3.5 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/50 transition font-mono"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-zinc-400 mb-1 block">
              Код сопряжения Wi-Fi (6 цифр)
            </label>
            <input
              type="text"
              required
              maxLength={8}
              placeholder="123456"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              className="w-full px-3.5 py-2 bg-zinc-950 border border-zinc-800 rounded-xl text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/50 transition font-mono tracking-widest text-lg text-center"
            />
          </div>

          {status && (
            <div
              className={`p-3 rounded-xl text-xs flex items-center gap-2 border ${
                status.isError
                  ? 'bg-rose-500/10 border-rose-500/20 text-rose-300'
                  : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
              }`}
            >
              {status.isError ? (
                <AlertCircle className="w-4 h-4 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              )}
              <span>{status.text}</span>
            </div>
          )}

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-medium rounded-xl transition"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={isLoading || !host.trim() || !code.trim()}
              className="px-5 py-2 bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white rounded-xl text-xs font-medium transition flex items-center gap-1.5 shadow-lg shadow-amber-900/20"
            >
              {isLoading && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
              Привязать устройство
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
