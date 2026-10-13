import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TransferProgress, formatBytes } from '../types';
import {
  UploadCloud,
  FilePlus,
  FolderPlus,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  FolderDown,
  Trash2,
  HardDriveUpload,
} from 'lucide-react';

interface FileTransferZoneProps {
  deviceSerial: string | null;
  targetRemotePath: string;
  transfers: TransferProgress[];
  onClearTransfers: () => void;
  onTransferTriggered: () => void;
}

export const FileTransferZone: React.FC<FileTransferZoneProps> = ({
  deviceSerial,
  targetRemotePath,
  transfers,
  onClearTransfers,
  onTransferTriggered,
}) => {
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);

  const startPushing = async (paths: string[]) => {
    if (!deviceSerial || paths.length === 0) return;
    setIsSending(true);
    setGeneralError(null);

    try {
      await invoke('push_files_to_device', {
        serial: deviceSerial,
        localPaths: paths,
        remoteDir: targetRemotePath,
      });
      onTransferTriggered();
    } catch (e: any) {
      setGeneralError(`Ошибка отправки: ${e}`);
    } finally {
      setIsSending(false);
    }
  };

  const handlePickFiles = async () => {
    if (!deviceSerial) return;
    try {
      const selected = await invoke<string[]>('pick_local_files');
      if (selected && selected.length > 0) {
        startPushing(selected);
      }
    } catch (e: any) {
      setGeneralError(`Не удалось выбрать файлы: ${e}`);
    }
  };

  const handlePickFolder = async () => {
    if (!deviceSerial) return;
    try {
      const selectedFolder = await invoke<string | null>('pick_local_folder');
      if (selectedFolder) {
        startPushing([selectedFolder]);
      }
    } catch (e: any) {
      setGeneralError(`Не удалось выбрать папку: ${e}`);
    }
  };

  return (
    <div className="w-[380px] lg:w-[420px] flex flex-col h-full bg-zinc-950 p-4 space-y-4 select-none overflow-hidden shrink-0">
      {/* Target Destination Card */}
      <div className="p-3 bg-zinc-900/60 border border-zinc-800/80 rounded-2xl flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-cyan-500/10 text-cyan-400 flex items-center justify-center shrink-0 border border-cyan-500/20">
            <FolderDown className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <div className="text-[11px] font-medium text-zinc-400">Назначение на Android</div>
            <div className="text-xs font-mono font-medium text-zinc-200 truncate" title={targetRemotePath}>
              {targetRemotePath}
            </div>
          </div>
        </div>
      </div>

      {/* Drag & Drop Card */}
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
        className={`relative border-2 border-dashed rounded-2xl p-6 flex flex-col items-center justify-center text-center transition ${
          isDragOver
            ? 'border-cyan-400 bg-cyan-500/10 shadow-lg shadow-cyan-500/10 scale-[0.99]'
            : 'border-zinc-800 hover:border-zinc-700 bg-zinc-900/30'
        } ${!deviceSerial ? 'opacity-50 pointer-events-none' : ''}`}
      >
        <div className="w-12 h-12 rounded-2xl bg-zinc-800/80 border border-zinc-700/60 flex items-center justify-center text-cyan-400 mb-3 shadow-inner">
          <UploadCloud className="w-6 h-6" />
        </div>

        <h4 className="text-sm font-semibold text-zinc-200 mb-1">
          Отправка файлов на телефон
        </h4>
        <p className="text-xs text-zinc-400 mb-4 max-w-[240px]">
          Выберите отдельные файлы или целую директорию для передачи через ADB
        </p>

        {/* Buttons */}
        <div className="flex items-center gap-2">
          <button
            onClick={handlePickFiles}
            disabled={!deviceSerial || isSending}
            className="px-3.5 py-2 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-xl text-xs font-medium transition flex items-center gap-1.5 shadow-md shadow-cyan-900/20"
          >
            <FilePlus className="w-3.5 h-3.5" />
            Выбрать файлы
          </button>
          <button
            onClick={handlePickFolder}
            disabled={!deviceSerial || isSending}
            className="px-3.5 py-2 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 rounded-xl text-xs font-medium transition flex items-center gap-1.5 border border-zinc-700/60"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            Выбрать папку
          </button>
        </div>
      </div>

      {generalError && (
        <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{generalError}</span>
        </div>
      )}

      {/* Transfers Queue & Progress */}
      <div className="flex-1 flex flex-col min-h-0 bg-zinc-900/40 border border-zinc-800/80 rounded-2xl p-3.5 overflow-hidden">
        <div className="flex items-center justify-between pb-2 border-b border-zinc-800/60 mb-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-zinc-300">
            <HardDriveUpload className="w-4 h-4 text-cyan-400" />
            <span>Очередь и статус передачи</span>
          </div>

          {transfers.length > 0 && (
            <button
              onClick={onClearTransfers}
              className="p-1 rounded-md text-zinc-500 hover:text-zinc-300 transition"
              title="Очистить список"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Transfer list */}
        <div className="flex-1 overflow-y-auto space-y-2 pr-1">
          {transfers.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center text-zinc-500 text-xs py-8">
              <span>Здесь будет отображаться прогресс передачи файлов</span>
            </div>
          ) : (
            transfers.map((t) => {
              const isCompleted = t.status === 'completed';
              const isError = t.status === 'error';

              return (
                <div
                  key={t.transfer_id}
                  className="p-3 bg-zinc-950/80 border border-zinc-800/80 rounded-xl space-y-2 text-xs animate-in fade-in"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-zinc-200 truncate max-w-[180px]" title={t.file_name}>
                      {t.file_name}
                    </span>
                    <span className="text-[10px] font-mono text-zinc-400">
                      {isCompleted ? (
                        <span className="text-emerald-400 flex items-center gap-1 font-medium">
                          <CheckCircle2 className="w-3 h-3" />
                          Готово
                        </span>
                      ) : isError ? (
                        <span className="text-rose-400 flex items-center gap-1 font-medium">
                          <AlertCircle className="w-3 h-3" />
                          Ошибка
                        </span>
                      ) : (
                        <span className="text-cyan-400 flex items-center gap-1">
                          <RefreshCw className="w-3 h-3 animate-spin" />
                          {t.percentage.toFixed(0)}%
                        </span>
                      )}
                    </span>
                  </div>

                  {/* Progress Bar */}
                  <div className="w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full transition-all duration-300 rounded-full ${
                        isCompleted
                          ? 'bg-emerald-500'
                          : isError
                          ? 'bg-rose-500'
                          : 'bg-gradient-to-r from-cyan-500 to-blue-500'
                      }`}
                      style={{ width: `${t.percentage}%` }}
                    />
                  </div>

                  {/* Stats (Speed / Size) */}
                  <div className="flex items-center justify-between text-[10px] text-zinc-400 font-mono">
                    <span>
                      {t.total_bytes > 0 ? `${formatBytes(t.total_bytes)}` : 'Передача...'}
                    </span>
                    {t.speed_mb_s > 0 && (
                      <span className="text-cyan-400">{t.speed_mb_s.toFixed(1)} МБ/с</span>
                    )}
                  </div>

                  {t.error_message && (
                    <div className="text-[10px] text-rose-400 bg-rose-500/10 p-1.5 rounded-lg border border-rose-500/20 break-all">
                      {t.error_message}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
