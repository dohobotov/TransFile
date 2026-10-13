import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { FolderOpen, CheckCircle2, AlertCircle, Terminal, Info, Cpu, HardDrive } from 'lucide-react';

interface SettingsViewProps {
  adbStatus: string;
  onAdbUpdated: () => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ adbStatus, onAdbUpdated }) => {
  const [statusMsg, setStatusMsg] = useState<{ text: string; isError: boolean } | null>(null);

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
    <div className="flex-1 flex flex-col h-full bg-[#0d0f17] overflow-y-auto p-6 space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold text-[#f1f5f9] tracking-tight">
          Настройки и диагностика ADB
        </h2>
        <p className="text-xs text-[#8a94a6] mt-0.5">
          Конфигурация исполняемого файла Android Debug Bridge и параметры системы
        </p>
      </div>

      <div className="max-w-2xl space-y-5">
        {/* ADB Binary Status Card */}
        <div className="rounded-2xl bg-[#141724] border border-[#212738] p-5 space-y-4">
          <div className="flex items-center gap-2.5 pb-3 border-b border-[#1e2333]">
            <div className="w-8 h-8 rounded-xl bg-indigo-500/15 text-indigo-400 border border-indigo-500/20 flex items-center justify-center">
              <Terminal className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-xs font-semibold text-[#f1f5f9]">Исполняемый файл ADB</h3>
              <p className="text-[11px] text-[#7c879c]">Текущий путь и статус демона</p>
            </div>
          </div>

          <div className="p-3.5 bg-[#0f111a] border border-[#1e2333] rounded-xl space-y-1.5">
            <span className="text-[11px] text-[#64748b] font-medium block">
              Информация о версии и расположении:
            </span>
            <div className="text-xs font-mono text-[#cbd5e1] break-all leading-relaxed">
              {adbStatus || 'Проверка ADB...'}
            </div>
          </div>

          <div className="pt-1">
            <button
              onClick={handlePickAdb}
              className="px-4 py-2.5 bg-[#1b2132] hover:bg-[#252c42] border border-[#2d364f] text-[#f1f5f9] rounded-xl text-xs font-semibold transition flex items-center gap-2"
            >
              <FolderOpen className="w-4 h-4 text-indigo-400" />
              <span>Выбрать другой adb.exe на диске</span>
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

        {/* Tips & Diagnostics */}
        <div className="rounded-2xl bg-[#141724] border border-[#212738] p-5 space-y-3">
          <div className="flex items-center gap-2.5 pb-2 border-b border-[#1e2333]">
            <Info className="w-4 h-4 text-sky-400" />
            <h3 className="text-xs font-semibold text-[#f1f5f9]">Рекомендации по подключению</h3>
          </div>

          <ul className="text-xs text-[#8a94a6] space-y-2 list-disc list-inside leading-relaxed">
            <li>
              Для беспроводной отладки ПК и телефон должны находиться в одной локальной сети (Wi-Fi).
            </li>
            <li>
              Начиная с Android 11, порт отладки меняется при каждом выключении Wi-Fi. Используйте раздел «Поиск и сопряжение» для обнаружения динамического порта через mDNS.
            </li>
            <li>
              Если телефон подключен по USB, нажмите кнопку «Вкл. Wi-Fi» в сайдбаре, чтобы перевести его на порт 5555 без ввода паролей.
            </li>
          </ul>
        </div>

        {/* System Footprint */}
        <div className="grid grid-cols-2 gap-4 text-xs">
          <div className="p-3.5 rounded-xl bg-[#141724] border border-[#212738] flex items-center gap-3">
            <Cpu className="w-5 h-5 text-sky-400" />
            <div>
              <div className="text-[11px] text-[#64748b]">Архитектура</div>
              <div className="font-semibold text-[#f1f5f9]">Rust + Webview2 (x64)</div>
            </div>
          </div>
          <div className="p-3.5 rounded-xl bg-[#141724] border border-[#212738] flex items-center gap-3">
            <HardDrive className="w-5 h-5 text-emerald-400" />
            <div>
              <div className="text-[11px] text-[#64748b]">Потребление ОЗУ</div>
              <div className="font-semibold text-[#f1f5f9]">~35–45 МБ</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
