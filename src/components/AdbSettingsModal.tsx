import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Settings, FolderOpen, CheckCircle2, AlertCircle, X, Terminal } from 'lucide-react';

interface AdbSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  adbStatus: string;
  onAdbUpdated: () => void;
}

export const AdbSettingsModal: React.FC<AdbSettingsModalProps> = ({
  isOpen,
  onClose,
  adbStatus,
  onAdbUpdated,
}) => {
  const [statusMsg, setStatusMsg] = useState<{ text: string; isError: boolean } | null>(null);

  if (!isOpen) return null;

  const handlePickAdb = async () => {
    setStatusMsg(null);
    try {
      const selectedPath = await invoke<string | null>('pick_adb_executable');
      if (selectedPath) {
        const res = await invoke<string>('set_custom_adb_path', { path: selectedPath });
        setStatusMsg({ text: `Путь успешно установлен: ${res}`, isError: false });
        onAdbUpdated();
      }
    } catch (e: any) {
      setStatusMsg({ text: `Ошибка выбора: ${e}`, isError: true });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-zinc-900 border border-zinc-800 text-zinc-100 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800/80 bg-zinc-900/50">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-violet-500/10 text-violet-400 border border-violet-500/20">
              <Settings className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-semibold text-zinc-100">Настройки ADB</h3>
              <p className="text-xs text-zinc-400">Управление бинарником Android Debug Bridge</p>
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
        <div className="p-6 space-y-4">
          <div className="p-3 bg-zinc-950/80 border border-zinc-800 rounded-xl space-y-1.5">
            <div className="flex items-center gap-2 text-xs font-medium text-zinc-400">
              <Terminal className="w-4 h-4 text-violet-400" />
              Текущий статус ADB:
            </div>
            <div className="text-xs font-mono text-zinc-200 break-all bg-zinc-900/80 p-2 rounded-lg border border-zinc-800/60">
              {adbStatus || 'Проверка ADB...'}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium text-zinc-400 block">
              Указать другой бинарник adb.exe:
            </label>
            <button
              onClick={handlePickAdb}
              className="w-full px-4 py-2.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 rounded-xl text-xs font-medium transition flex items-center justify-center gap-2 border border-zinc-700/60"
            >
              <FolderOpen className="w-4 h-4 text-violet-400" />
              Обзор на диске (выбрать adb.exe)
            </button>
          </div>

          {statusMsg && (
            <div
              className={`p-3 rounded-xl text-xs flex items-center gap-2 border ${
                statusMsg.isError
                  ? 'bg-rose-500/10 border-rose-500/20 text-rose-300'
                  : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
              }`}
            >
              {statusMsg.isError ? (
                <AlertCircle className="w-4 h-4 shrink-0" />
              ) : (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              )}
              <span>{statusMsg.text}</span>
            </div>
          )}
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
