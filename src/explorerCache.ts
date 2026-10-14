import { invoke } from '@tauri-apps/api/core';
import { DirListing, RemoteFileItem } from './types';

// Shared device directory cache. Lives at module level so it survives Explorer tab unmounts and can be
// warmed by App as soon as a device is selected, before the Explorer tab is ever opened.

export interface DirectoryCacheEntry {
  items: RemoteFileItem[];
  timestamp: number;
}

export const BOOKMARK_PRESETS = [
  { label: 'Загрузки', path: '/sdcard/Download' },
  { label: 'DCIM / Камера', path: '/sdcard/DCIM/Camera' },
  { label: 'Документы', path: '/sdcard/Documents' },
  { label: 'Картинки', path: '/sdcard/Pictures' },
  { label: 'Музыка', path: '/sdcard/Music' },
];

/** A listing younger than this is shown as is, without a background revalidation. */
export const FRESH_MS = 10_000;
/** Bookmarks fetched within this window are not prefetched again. */
const PREFETCH_SKIP_MS = 60_000;

const cache = new Map<string, DirectoryCacheEntry>();
const inflight = new Map<string, Promise<RemoteFileItem[]>>();
// Bumped on every new fetch and on invalidation: only the newest fetch of a key may write the cache, so a
// slow prefetch can't overwrite a listing refreshed after a transfer/delete.
const generations = new Map<string, number>();

export function getCacheKey(serial: string, path: string): string {
  const normalized = path.replace(/\/+$/, '') || '/';
  return `${serial}::${normalized}`;
}

export function getCachedDirectory(serial: string, path: string): DirectoryCacheEntry | undefined {
  return cache.get(getCacheKey(serial, path));
}

export function isFresh(entry: DirectoryCacheEntry | undefined, maxAgeMs = FRESH_MS): boolean {
  return !!entry && Date.now() - entry.timestamp < maxAgeMs;
}

function nextGeneration(key: string): number {
  const gen = (generations.get(key) ?? 0) + 1;
  generations.set(key, gen);
  return gen;
}

/** Drops the listing of `path` and of everything below it (e.g. after the folder itself was deleted). */
export function invalidateDirectory(serial: string, path: string): void {
  const key = getCacheKey(serial, path);
  const subtreePrefix = key.endsWith('/') ? key : `${key}/`;
  const affected = new Set<string>([key]);
  for (const k of [...cache.keys(), ...inflight.keys()]) {
    if (k.startsWith(subtreePrefix)) affected.add(k);
  }
  for (const k of affected) {
    cache.delete(k);
    inflight.delete(k);
    nextGeneration(k);
  }
}

/**
 * After a transfer the changed folders are not known here: keep every listing for instant display, but
 * make it stale so the next open revalidates it, and drop requests in flight that may predate the change.
 */
export function markAllDirectoriesStale(): void {
  for (const entry of cache.values()) entry.timestamp = 0;
  for (const key of inflight.keys()) nextGeneration(key);
  inflight.clear();
}

function track(key: string, request: Promise<RemoteFileItem[]>): Promise<RemoteFileItem[]> {
  const gen = nextGeneration(key);
  const tracked: Promise<RemoteFileItem[]> = request
    .then((items) => {
      if (generations.get(key) === gen) {
        cache.set(key, { items, timestamp: Date.now() });
      }
      return items;
    })
    .finally(() => {
      if (inflight.get(key) === tracked) inflight.delete(key);
    });
  inflight.set(key, tracked);
  // Prefetches are often not awaited by anyone: keep their failures out of the unhandled-rejection log
  tracked.catch(() => {});
  return tracked;
}

/**
 * Lists one directory and stores the result. Concurrent calls for the same path share one request
 * (e.g. Explorer opening while App's prefetch of that path is still running). `force` always starts a
 * new request that also bypasses the backend's short-lived listing cache; its result wins over any older
 * one still in flight.
 */
export function fetchDirectory(serial: string, path: string, force = false): Promise<RemoteFileItem[]> {
  const key = getCacheKey(serial, path);
  if (!force) {
    const pending = inflight.get(key);
    if (pending) return pending;
  }
  return track(key, invoke<RemoteFileItem[]>('list_device_files', { serial, remotePath: path, force }));
}

/**
 * Warms several directories with ONE adb shell call (`list_device_dirs`). Paths that are cached recently
 * or already being fetched are skipped. A missing directory only fails its own entry. Never rejects.
 */
export function prefetchDirectories(serial: string, paths: string[], maxAgeMs = PREFETCH_SKIP_MS): Promise<void> {
  const seen = new Set<string>();
  const todo: string[] = [];
  for (const path of paths) {
    const key = getCacheKey(serial, path);
    if (seen.has(key)) continue;
    seen.add(key);
    if (inflight.has(key) || isFresh(cache.get(key), maxAgeMs)) continue;
    todo.push(path);
  }

  if (todo.length === 0) return Promise.resolve();
  if (todo.length === 1) {
    return fetchDirectory(serial, todo[0]).then(
      () => undefined,
      () => undefined
    );
  }

  const batch = invoke<DirListing[]>('list_device_dirs', { serial, paths: todo });
  const tasks = todo.map((path, i) =>
    track(
      getCacheKey(serial, path),
      batch.then((results) => {
        const res = results[i];
        if (res && res.path === path && res.items) return res.items;
        throw res?.error ?? 'Нет результата для каталога';
      })
    ).catch(() => undefined)
  );
  return Promise.all(tasks).then(() => undefined);
}

/**
 * True for errors meaning "the device did not answer in time" (adb timeout or a dropped/offline transport),
 * as opposed to errors from the device itself such as "No such file or directory".
 */
export function isDeviceUnresponsiveError(e: unknown): boolean {
  const text = String(e ?? '').toLowerCase();
  return (
    text.includes('таймаут') ||
    text.includes('device offline') ||
    (text.includes('device') && text.includes('not found'))
  );
}

const readinessWaits = new Map<string, Promise<void>>();

/**
 * Waits (one shared request per device) until the device answers commands again — e.g. a MuMu emulator,
 * which ignores everything for ~2 min after a reconnect. `recheck` re-probes a device that was considered
 * ready but whose command just timed out.
 */
export function waitDeviceReady(serial: string, recheck = false): Promise<void> {
  const pending = readinessWaits.get(serial);
  if (pending) return pending;
  const wait = invoke<void>('wait_device_ready', { serial, recheck }).finally(() => {
    if (readinessWaits.get(serial) === wait) readinessWaits.delete(serial);
  });
  readinessWaits.set(serial, wait);
  wait.catch(() => {});
  return wait;
}

export function prefetchBookmarks(serial: string): Promise<void> {
  return prefetchDirectories(
    serial,
    BOOKMARK_PRESETS.map((p) => p.path)
  );
}

/**
 * Called when a device becomes selected: lists the Explorer's current path on its own (so it is not
 * held back by slower bookmark folders) and, concurrently, all bookmarks in one batched call.
 */
export function prefetchDevice(serial: string, currentPath: string): Promise<void> {
  const currentKey = getCacheKey(serial, currentPath);
  const current =
    inflight.has(currentKey) || isFresh(cache.get(currentKey))
      ? Promise.resolve()
      : fetchDirectory(serial, currentPath).then(
          () => undefined,
          () => undefined
        );
  const bookmarks = prefetchDirectories(
    serial,
    BOOKMARK_PRESETS.map((p) => p.path).filter((p) => getCacheKey(serial, p) !== currentKey)
  );
  return Promise.all([current, bookmarks]).then(() => undefined);
}
