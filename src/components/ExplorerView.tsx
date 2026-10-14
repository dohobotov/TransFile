import React, { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RemoteFileItem, formatBytes } from '../types';
import {
  BOOKMARK_PRESETS,
  fetchDirectory,
  getCachedDirectory,
  invalidateDirectory,
  isFresh,
  prefetchBookmarks,
} from '../explorerCache';
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
  Check,
  SendHorizontal,
} from 'lucide-react';

interface ExplorerViewProps {
  deviceSerial: string | null;
  currentPath: string;
  onPathChange: (newPath: string) => void;
  targetRemotePath: string;
  onSetAsTargetDestination: (path: string) => void;
  onNavigateToTransfer: () => void;
  refreshTrigger?: number;
}

export const ExplorerView: React.FC<ExplorerViewProps> = ({
  deviceSerial,
  currentPath,
  onPathChange,
  targetRemotePath,
  onSetAsTargetDestination,
  onNavigateToTransfer,
  refreshTrigger = 0,
}) => {
  // Synchronously initialize from cache if available for instant 0ms first paint
  const [items, setItems] = useState<RemoteFileItem[]>(() => {
    if (deviceSerial) {
      const cached = getCachedDirectory(deviceSerial, currentPath);
      if (cached) return cached.items;
    }
    return [];
  });

  const [isLoading, setIsLoading] = useState<boolean>(() => {
    if (!deviceSerial) return false;
    return !getCachedDirectory(deviceSerial, currentPath);
  });

  const [isValidating, setIsValidating] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [isCreatingFolder, setIsCreatingFolder] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // References to prevent race conditions during rapid folder navigation
  const activePathRef = useRef(currentPath);
  const activeSerialRef = useRef(deviceSerial);
  const prevTriggerRef = useRef(refreshTrigger);
  // Only the latest loadDirectory call may update the view: an older request for the same path (e.g. a
  // revalidation or prefetch started before a delete/refresh) can finish after a newer forced one.
  const loadSeqRef = useRef(0);

  useEffect(() => {
    activePathRef.current = currentPath;
    activeSerialRef.current = deviceSerial;
  }, [currentPath, deviceSerial]);

  const presets = BOOKMARK_PRESETS;

  // SWR: Instantly show cached directory contents, revalidate in background without blocking spinners
  const loadDirectory = async (path: string, forceRefresh = false) => {
    const seq = ++loadSeqRef.current;
    const isCurrent = () =>
      loadSeqRef.current === seq && activePathRef.current === path && activeSerialRef.current === deviceSerial;

    if (!deviceSerial) {
      setItems([]);
      setIsLoading(false);
      setIsValidating(false);
      return;
    }

    // If force refresh, drop the cache entry to avoid displaying stale or erroneous listings
    if (forceRefresh) {
      invalidateDirectory(deviceSerial, path);
    }

    const cached = getCachedDirectory(deviceSerial, path);

    if (cached && !forceRefresh) {
      setItems(cached.items);
      setIsLoading(false);
      setErrorMsg(null);
      // Just fetched (e.g. by the prefetch on device selection): no need to ask the device again
      if (isFresh(cached)) {
        setIsValidating(false);
        return;
      }
      setIsValidating(true);
    } else {
      setItems([]);
      setIsLoading(true);
      setIsValidating(false);
    }

    setErrorMsg(null);

    try {
      // Joins a prefetch of the same path that is still in flight instead of starting a second adb call
      const files = await fetchDirectory(deviceSerial, path, forceRefresh);

      // Only update state if user is still viewing this path and device and no newer load started
      if (isCurrent()) {
        setItems(files);
        setErrorMsg(null);
      }
    } catch (e: any) {
      if (isCurrent()) {
        if (!cached) {
          setErrorMsg(`Ошибка загрузки директории: ${e}`);
        } else {
          console.warn(`Фоновое обновление директории не удалось: ${e}`);
        }
      }
    } finally {
      if (isCurrent()) {
        setIsLoading(false);
        setIsValidating(false);
      }
    }
  };

  // Main directory loading effect with SWR handling
  useEffect(() => {
    if (!deviceSerial) {
      setItems([]);
      setIsLoading(false);
      setIsValidating(false);
      return;
    }

    const isTrigger = refreshTrigger !== prevTriggerRef.current;
    prevTriggerRef.current = refreshTrigger;

    if (isTrigger) {
      // Invalidate affected directories upon file transfer event
      invalidateDirectory(deviceSerial, currentPath);
      invalidateDirectory(deviceSerial, targetRemotePath);
      loadDirectory(currentPath, true);
    } else {
      loadDirectory(currentPath, false);
    }
  }, [deviceSerial, currentPath, refreshTrigger]);

  // Background bookmark prefetching for instantaneous folder opening. Normally App has already warmed
  // them on device selection; this only refreshes bookmarks that are missing or older than a minute,
  // with one batched adb call. A bookmark clicked meanwhile joins that request in loadDirectory.
  useEffect(() => {
    if (!deviceSerial) return;
    prefetchBookmarks(deviceSerial);
  }, [deviceSerial]);

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
      // Invalidate current path cache and refresh
      invalidateDirectory(deviceSerial, currentPath);
      loadDirectory(currentPath, true);
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
      invalidateDirectory(deviceSerial, currentPath);
      if (item.is_dir) {
        invalidateDirectory(deviceSerial, item.path);
      }
      loadDirectory(currentPath, true);
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

  const isCurrentFolderTarget = currentPath === targetRemotePath;
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
        return <FileText className="w-4 h-4 text-sky-400 shrink-0" />;
      case 'zip':
      case 'rar':
      case 'tar':
      case '7z':
      case 'apk':
        return <Archive className="w-4 h-4 text-amber-500 shrink-0" />;
      default:
        return <File className="w-4 h-4 text-[#8a94a6] shrink-0" />;
    }
  };

  const currentBaseName = currentPath.split('/').filter(Boolean).pop() || '';
  const normCurrent = currentPath.replace(/\/+$/, '') || '/';

  // Filter out accidental self-referencing entries where item points to currentPath itself
  const cleanItems = items.filter((it) => {
    if (!it.name || it.name === '.' || it.name === '..') return false;
    const normItemPath = it.path.replace(/\/+$/, '') || '/';
    const isSelfPath = normItemPath === normCurrent;
    const isSelfNameExact = it.name === currentPath || it.name === normCurrent;
    const isSelfBaseName = Boolean(currentBaseName && it.name === currentBaseName && isSelfPath);

    if (isSelfPath || isSelfNameExact || isSelfBaseName) {
      return false;
    }
    return true;
  });

  const filteredItems = cleanItems.filter((it) =>
    it.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex-1 flex flex-col h-full bg-[#0d0f17] overflow-hidden">
      {/* Top Presets & Action Toolbar */}
      <div className="p-4 border-b border-[#1e2333] bg-[#11141e] space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-[#f1f5f9]">
              Файловая система Android
            </span>
            <span className="text-[11px] text-[#64748b]">({cleanItems.length} объектов)</span>
            {isValidating && (
              <span className="flex items-center gap-1 text-[10px] text-sky-400 bg-sky-500/10 px-2 py-0.5 rounded-full border border-sky-500/20 font-mono">
                <RefreshCw className="w-2.5 h-2.5 animate-spin" />
                Синхронизация...
              </span>
            )}
          </div>

          {/* Action Buttons */}
          <div className="flex items-center gap-2">
            {isCurrentFolderTarget ? (
              <span className="px-3 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-300 text-xs font-medium flex items-center gap-1.5">
                <Check className="w-3.5 h-3.5" />
                Папка назначения для отправки
              </span>
            ) : (
              <button
                onClick={() => onSetAsTargetDestination(currentPath)}
                className="px-3 py-1.5 rounded-xl bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-sky-300 text-xs font-medium transition flex items-center gap-1.5"
                title="Установить эту папку как цель отправки файлов"
              >
                <SendHorizontal className="w-3.5 h-3.5" />
                Использовать для отправки
              </button>
            )}

            <button
              onClick={onNavigateToTransfer}
              className="px-3 py-1.5 rounded-xl bg-[#1b2132] hover:bg-[#252c42] border border-[#2d364f] text-[#cbd5e1] text-xs font-medium transition"
            >
              К отправке файлов →
            </button>

            <button
              onClick={() => setIsCreatingFolder(!isCreatingFolder)}
              className="p-2 rounded-xl bg-[#1b2132] hover:bg-[#252c42] border border-[#2d364f] text-[#cbd5e1] transition"
              title="Создать новую папку"
            >
              <FolderPlus className="w-4 h-4 text-sky-400" />
            </button>

            <button
              onClick={() => loadDirectory(currentPath, true)}
              disabled={isLoading || !deviceSerial}
              className="p-2 rounded-xl bg-[#1b2132] hover:bg-[#252c42] border border-[#2d364f] text-[#cbd5e1] transition disabled:opacity-50"
              title="Обновить список файлов"
            >
              <RefreshCw className={`w-4 h-4 ${(isLoading || isValidating) ? 'animate-spin text-sky-400' : ''}`} />
            </button>
          </div>
        </div>

        {/* Presets Row */}
        <div className="flex items-center gap-1.5 overflow-x-auto text-xs pb-0.5">
          <span className="text-[11px] text-[#64748b] mr-1 shrink-0">Закладки:</span>
          {presets.map((preset) => {
            const isActive = currentPath === preset.path;
            return (
              <button
                key={preset.path}
                onClick={() => handleNavigate(preset.path)}
                disabled={!deviceSerial}
                className={`px-2.5 py-1 rounded-lg shrink-0 transition text-xs font-medium ${
                  isActive
                    ? 'bg-sky-500/20 text-sky-300 border border-sky-500/30'
                    : 'bg-[#181d2b] hover:bg-[#202638] text-[#94a3b8] hover:text-[#f1f5f9] border border-[#262e44]'
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>

        {/* Inline Create Folder Input */}
        {isCreatingFolder && (
          <form onSubmit={handleCreateFolder} className="flex gap-2 pt-1 animate-in fade-in">
            <input
              type="text"
              autoFocus
              placeholder="Название новой папки..."
              value={newFolderName}
              onChange={(e) => setNewFolderName(e.target.value)}
              className="flex-1 px-3 py-1.5 bg-[#0d0f17] border border-[#2d364f] rounded-xl text-xs text-[#f1f5f9] placeholder-[#64748b] focus:outline-none focus:border-sky-500"
            />
            <button
              type="submit"
              disabled={!newFolderName.trim()}
              className="px-4 py-1.5 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-white rounded-xl text-xs font-semibold"
            >
              Создать
            </button>
            <button
              type="button"
              onClick={() => setIsCreatingFolder(false)}
              className="px-3 py-1.5 bg-[#1b2132] hover:bg-[#252c42] text-[#94a3b8] rounded-xl text-xs"
            >
              Отмена
            </button>
          </form>
        )}
      </div>

      {/* Breadcrumbs Navigation & Search Filter */}
      <div className="px-4 py-2.5 border-b border-[#1e2333] bg-[#0e1017] flex items-center justify-between gap-4 text-xs">
        <div className="flex items-center gap-1 overflow-x-auto font-mono text-[11px] text-[#7c879c]">
          <button
            onClick={() => handleNavigate('/')}
            className="hover:text-[#f1f5f9] px-1.5 py-1 rounded hover:bg-[#181d2b] transition flex items-center gap-1.5"
          >
            <HardDrive className="w-3.5 h-3.5 text-[#64748b]" />
            <span>root</span>
          </button>

          {pathSegments.map((seg, idx) => {
            const fullSubPath = '/' + pathSegments.slice(0, idx + 1).join('/');
            const isLast = idx === pathSegments.length - 1;

            return (
              <React.Fragment key={fullSubPath}>
                <ChevronRight className="w-3 h-3 text-[#384360] shrink-0" />
                <button
                  onClick={() => handleNavigate(fullSubPath)}
                  className={`px-1.5 py-1 rounded transition truncate max-w-[150px] ${
                    isLast
                      ? 'text-sky-400 font-semibold bg-sky-500/10'
                      : 'hover:text-[#f1f5f9] hover:bg-[#181d2b]'
                  }`}
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
        </div>

        {/* Filter */}
        <div className="relative w-48 shrink-0">
          <Search className="w-3.5 h-3.5 text-[#64748b] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Поиск по имени..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-3 py-1 bg-[#141724] border border-[#212738] rounded-xl text-xs text-[#f1f5f9] placeholder-[#64748b] focus:outline-none focus:border-sky-500 font-mono"
          />
        </div>
      </div>

      {/* File & Folder Table View */}
      <div className="flex-1 overflow-y-auto p-4">
        {errorMsg && (
          <div className="p-3 mb-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center justify-between gap-3">
            <span className="flex-1">{errorMsg}</span>
            <button
              onClick={() => loadDirectory(currentPath, true)}
              className="px-2.5 py-1 rounded-lg bg-rose-500/20 hover:bg-rose-500/30 text-rose-200 border border-rose-500/40 font-medium transition text-xs shrink-0"
            >
              Повторить
            </button>
          </div>
        )}

        {!deviceSerial ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-8 text-[#64748b]">
            <HardDrive className="w-14 h-14 mb-3 opacity-30 stroke-1" />
            <h4 className="text-sm font-semibold text-[#94a3b8]">Устройство не подключено</h4>
            <p className="text-xs text-[#64748b] mt-1 max-w-xs">
              Подключите телефон по Wi-Fi или USB в разделе «Поиск и сопряжение» для просмотра файлов
            </p>
          </div>
        ) : isLoading && items.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center space-y-2">
            <RefreshCw className="w-7 h-7 animate-spin text-sky-400" />
            <span className="text-xs text-[#7c879c]">Загрузка файлов...</span>
          </div>
        ) : (
          <div className="space-y-1">
            {/* Go Up button */}
            {currentPath !== '/' && currentPath !== '/sdcard' && (
              <div
                onClick={handleNavigateUp}
                className="flex items-center gap-3 px-3.5 py-2.5 rounded-xl hover:bg-[#161a26] text-[#7c879c] hover:text-[#f1f5f9] cursor-pointer transition text-xs font-mono select-none"
              >
                <ArrowUp className="w-4 h-4 text-[#64748b]" />
                <span>.. (родительский каталог)</span>
              </div>
            )}

            {filteredItems.map((item) => (
              <div
                key={item.path}
                onDoubleClick={() => item.is_dir && handleNavigate(item.path)}
                className="flex items-center justify-between px-3.5 py-2 rounded-xl hover:bg-[#141724] border border-transparent hover:border-[#212738] transition group text-xs select-none"
              >
                <div
                  onClick={() => item.is_dir && handleNavigate(item.path)}
                  className={`flex items-center gap-3 flex-1 min-w-0 ${
                    item.is_dir ? 'cursor-pointer text-[#f1f5f9] font-medium' : 'text-[#cbd5e1]'
                  }`}
                >
                  {getFileIcon(item.name, item.is_dir)}
                  <span className="truncate">{item.name}</span>
                </div>

                <div className="flex items-center gap-4 text-[#64748b] text-[11px] font-mono shrink-0">
                  <span className="w-20 text-right">
                    {item.is_dir ? 'каталог' : formatBytes(item.size)}
                  </span>
                  <span className="hidden md:inline w-32 text-right text-[#4a5568]">
                    {item.mtime}
                  </span>

                  <div className="flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition">
                    {!item.is_dir && (
                      <button
                        onClick={() => handlePullFile(item)}
                        className="p-1.5 rounded-lg hover:bg-[#1e2333] hover:text-sky-400 text-[#7c879c] transition"
                        title="Скачать на ПК"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => handleDeleteItem(item)}
                      className="p-1.5 rounded-lg hover:bg-[#1e2333] hover:text-rose-400 text-[#7c879c] transition"
                      title="Удалить"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {filteredItems.length === 0 && (
              <div className="py-16 text-center text-[#64748b] text-xs">
                В этой папке нет файлов или поиск не дал результатов
              </div>
            )}
          </div>
        )}
      </div>

      {/* Path Footer */}
      <div className="px-4 py-2.5 border-t border-[#1e2333] bg-[#11141e] text-[11px] text-[#7c879c] flex items-center justify-between font-mono">
        <span className="truncate max-w-xl">Путь: {currentPath}</span>
        <span className="text-[#64748b]">{filteredItems.length} эл.</span>
      </div>
    </div>
  );
};
