import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RemoteFileItem, formatBytes } from '../types';
import {
  Folder,
  File,
  FolderPlus,
  RefreshCw,
  ChevronRight,
  Download,
  Trash2,
  Search,
  ArrowUp,
  Image,
  Film,
  Music,
  FileText,
  Archive,
  HardDrive,
  FolderCheck,
} from 'lucide-react';

interface DeviceBrowserProps {
  deviceSerial: string | null;
  currentPath: string;
  onPathChange: (newPath: string) => void;
  onRefreshTrigger?: number;
}

export const DeviceBrowser: React.FC<DeviceBrowserProps> = ({
  deviceSerial,
  currentPath,
  onPathChange,
  onRefreshTrigger = 0,
}) => {
  const [items, setItems] = useState<RemoteFileItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const presets = [
    { label: 'Загрузки', path: '/sdcard/Download', icon: Download },
    { label: 'DCIM / Камера', path: '/sdcard/DCIM/Camera', icon: Image },
    { label: 'Документы', path: '/sdcard/Documents', icon: FileText },
    { label: 'Картинки', path: '/sdcard/Pictures', icon: Image },
    { label: 'Музыка', path: '/sdcard/Music', icon: Music },
  ];

  const loadDirectory = async (path: string) => {
    if (!deviceSerial) return;
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const files = await invoke<RemoteFileItem[]>('list_device_files', {
        serial: deviceSerial,
        remotePath: path,
      });
      setItems(files);
    } catch (e: any) {
      setErrorMsg(`Ошибка загрузки директории: ${e}`);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (deviceSerial) {
      loadDirectory(currentPath);
    } else {
      setItems([]);
    }
  }, [deviceSerial, currentPath, onRefreshTrigger]);

  const handleNavigate = (path: string) => {
    onPathChange(path);
  };

  const handleNavigateUp = () => {
    if (currentPath === '/' || currentPath === '/sdcard') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    const parentPath = '/' + parts.join('/');
    handleNavigate(parentPath || '/');
  };

  const handleCreateFolder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deviceSerial || !newFolderName.trim()) return;

    const fullPath = `${currentPath.replace(/\/+$/, '')}/${newFolderName.trim()}`;
    try {
      await invoke('create_device_folder', {
        serial: deviceSerial,
        remotePath: fullPath,
      });
      setNewFolderName('');
      setIsCreatingFolder(false);
      loadDirectory(currentPath);
    } catch (e: any) {
      setErrorMsg(`Не удалось создать папку: ${e}`);
    }
  };

  const handleDeleteItem = async (item: RemoteFileItem) => {
    if (!deviceSerial) return;
    const confirmDelete = window.confirm(`Удалить ${item.is_dir ? 'папку' : 'файл'} "${item.name}"?`);
    if (!confirmDelete) return;

    try {
      await invoke('delete_device_item', {
        serial: deviceSerial,
        remotePath: item.path,
      });
      loadDirectory(currentPath);
    } catch (e: any) {
      setErrorMsg(`Ошибка удаления: ${e}`);
    }
  };

  const handlePullFile = async (item: RemoteFileItem) => {
    if (!deviceSerial) return;
    try {
      const localSaveDir = await invoke<string | null>('pick_save_folder');
      if (!localSaveDir) return;

      await invoke('pull_file_from_device', {
        serial: deviceSerial,
        remotePath: item.path,
        localDir: localSaveDir,
      });
    } catch (e: any) {
      setErrorMsg(`Ошибка скачивания: ${e}`);
    }
  };

  // Breadcrumbs calculation
  const pathSegments = currentPath.split('/').filter(Boolean);

  const getFileIcon = (name: string, isDir: boolean) => {
    if (isDir) return <Folder className="w-4 h-4 text-amber-400 shrink-0 fill-amber-400/20" />;
    const ext = name.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'jpg':
      case 'jpeg':
      case 'png':
      case 'webp':
      case 'gif':
        return <Image className="w-4 h-4 text-emerald-400 shrink-0" />;
      case 'mp4':
      case 'mkv':
      case 'mov':
        return <Film className="w-4 h-4 text-purple-400 shrink-0" />;
      case 'mp3':
      case 'flac':
      case 'wav':
        return <Music className="w-4 h-4 text-pink-400 shrink-0" />;
      case 'pdf':
      case 'doc':
      case 'docx':
      case 'txt':
        return <FileText className="w-4 h-4 text-blue-400 shrink-0" />;
      case 'zip':
      case 'rar':
      case 'tar':
      case '7z':
      case 'apk':
        return <Archive className="w-4 h-4 text-amber-500 shrink-0" />;
      default:
        return <File className="w-4 h-4 text-zinc-400 shrink-0" />;
    }
  };

  const filteredItems = items.filter((it) =>
    it.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col h-full bg-zinc-950 border-l border-zinc-800/80 overflow-hidden">
      {/* Top Header / Presets Bar */}
      <div className="p-3 border-b border-zinc-800/80 bg-zinc-900/40 space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FolderCheck className="w-4 h-4 text-cyan-400" />
            <span className="text-xs font-semibold text-zinc-200">
              Проводник устройства (куда сохранять)
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setIsCreatingFolder(!isCreatingFolder)}
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition"
              title="Создать папку"
            >
              <FolderPlus className="w-3.5 h-3.5 text-cyan-400" />
            </button>
            <button
              onClick={() => loadDirectory(currentPath)}
              disabled={isLoading || !deviceSerial}
              className="p-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition disabled:opacity-50"
              title="Обновить список"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Quick Presets */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-[11px] scrollbar-none">
          {presets.map((preset) => {
            const Icon = preset.icon;
            const isActive = currentPath === preset.path;
            return (
              <button
                key={preset.path}
                onClick={() => handleNavigate(preset.path)}
                disabled={!deviceSerial}
                className={`px-2.5 py-1 rounded-lg shrink-0 flex items-center gap-1.5 transition ${
                  isActive
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/30 font-medium'
                    : 'bg-zinc-800/60 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-800/60'
                }`}
              >
                <Icon className="w-3 h-3" />
                <span>{preset.label}</span>
              </button>
            );
          })}
        </div>

        {/* Create Folder input inline */}
        {isCreatingFolder && (
          <form onSubmit={handleCreateFolder} className="flex gap-2 pt-1 animate-in slide-in-from-top-1">
            <input
              type="text"
              autoFocus
              placeholder="Имя новой папки..."
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              className="flex-1 px-3 py-1 bg-zinc-950 border border-zinc-700 rounded-lg text-xs text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-cyan-500"
            />
            <button
              type="submit"
              disabled={!newFolderName.trim()}
              className="px-3 py-1 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition"
            >
              Создать
            </button>
            <button
              type="button"
              onClick={() => setIsCreatingFolder(false)}
              className="px-2 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-300 rounded-lg text-xs"
            >
              Отмена
            </button>
          </form>
        )}
      </div>

      {/* Breadcrumbs Navigation & Search Bar */}
      <div className="px-3 py-2 border-b border-zinc-800/80 bg-zinc-900/20 flex items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none font-mono text-[11px] text-zinc-400">
          <button
            onClick={() => handleNavigate('/')}
            className="hover:text-zinc-200 px-1 py-0.5 rounded hover:bg-zinc-800 transition flex items-center gap-1"
          >
            <HardDrive className="w-3 h-3 text-zinc-500" />
            <span>root</span>
          </button>

          {pathSegments.map((seg, idx) => {
            const fullSubPath = '/' + pathSegments.slice(0, idx + 1).join('/');
            const isLast = idx === pathSegments.length - 1;

            return (
              <React.Fragment key={fullSubPath}>
                <ChevronRight className="w-3 h-3 text-zinc-600 shrink-0" />
                <button
                  onClick={() => handleNavigate(fullSubPath)}
                  className={`px-1 py-0.5 rounded transition truncate max-w-[120px] ${
                    isLast
                      ? 'text-cyan-400 font-semibold bg-cyan-500/10'
                      : 'hover:text-zinc-200 hover:bg-zinc-800'
                  }`}
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Filter input */}
        <div className="relative w-36 shrink-0">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Фильтр..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-2 py-1 bg-zinc-900/80 border border-zinc-800 rounded-lg text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-cyan-500"
          />
        </div>
      </div>

      {/* Files List Table */}
      <div className="flex-1 overflow-y-auto p-2">
        {errorMsg && (
          <div className="p-3 mb-2 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
            {errorMsg}
          </div>
        )}

        {!deviceSerial ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 text-zinc-500">
            <HardDrive className="w-12 h-12 mb-3 stroke-1 opacity-40" />
            <p className="text-sm font-medium text-zinc-400">Устройство не выбрано</p>
            <p className="text-xs text-zinc-500 mt-1 max-w-xs">
              Подключите Android по Wi-Fi или USB в верхней панели для просмотра папок
            </p>
          </div>
        ) : isLoading && items.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <RefreshCw className="w-6 h-6 animate-spin text-cyan-400" />
          </div>
        ) : (
          <div className="space-y-0.5">
            {/* Go Up button */}
            {currentPath !== '/' && currentPath !== '/sdcard' && (
              <div
                onClick={handleNavigateUp}
                className="flex items-center gap-2.5 px-3 py-2 rounded-lg hover:bg-zinc-800/70 text-zinc-400 hover:text-zinc-200 cursor-pointer transition text-xs select-none"
              >
                <ArrowUp className="w-4 h-4 text-zinc-500" />
                <span className="font-mono">.. (на уровень вверх)</span>
              </div>
            )}

            {filteredItems.map((item) => (
              <div
                key={item.path}
                onDoubleClick={() => item.is_dir && handleNavigate(item.path)}
                className="flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-zinc-900 border border-transparent hover:border-zinc-800/80 transition group text-xs select-none"
              >
                <div
                  onClick={() => item.is_dir && handleNavigate(item.path)}
                  className={`flex items-center gap-2.5 flex-1 min-w-0 ${
                    item.is_dir ? 'cursor-pointer text-zinc-200 font-medium' : 'text-zinc-300'
                  }`}
                >
                  {getFileIcon(item.name, item.is_dir)}
                  <span className="truncate">{item.name}</span>
                </div>

                <div className="flex items-center gap-3 text-zinc-500 text-[11px] shrink-0 font-mono">
                  <span>{item.is_dir ? 'папка' : formatBytes(item.size)}</span>
                  <span className="hidden md:inline text-zinc-600">{item.mtime}</span>

                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition">
                    {!item.is_dir && (
                      <button
                        onClick={() => handlePullFile(item)}
                        className="p-1 rounded hover:bg-zinc-800 hover:text-cyan-400 text-zinc-400 transition"
                        title="Скачать на ПК"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteItem(item)}
                      className="p-1 rounded hover:bg-zinc-800 hover:text-rose-400 text-zinc-400 transition"
                      title="Удалить"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {filteredItems.length === 0 && (
              <div className="py-12 text-center text-zinc-500 text-xs">
                В этой папке нет файлов или поиск не дал результатов
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bottom Path Bar */}
      <div className="px-3 py-2 border-t border-zinc-800/80 bg-zinc-900/60 text-[11px] text-zinc-400 flex items-center justify-between">
        <div className="flex items-center gap-1.5 truncate">
          <span className="text-zinc-500">Текущий путь:</span>
          <span className="font-mono text-zinc-300 truncate">{currentPath}</span>
        </div>
        <span className="shrink-0 text-zinc-500">{items.length} объектов</span>
      </div>
    </div>
  );
};
