import { checkDataFolder, type DataFolderReport, type FolderEntry } from '../data-folder-check.ts';
import { deleteHandle, loadDirectoryHandle, saveDirectoryHandle } from './handle-store.ts';

const HANDLE_KEY = 'data-folder';

export type StoredGameFolder =
  | { readonly status: 'none' }
  | { readonly status: 'granted'; readonly handle: FileSystemDirectoryHandle }
  /** Handle bekend, maar de browser vraagt opnieuw toestemming (vereist een klik). */
  | { readonly status: 'needs-permission'; readonly handle: FileSystemDirectoryHandle };

/** De gekozen map, opgesplitst in Data-map en (indien gekozen) installatiemap. */
export interface ResolvedGameFolder {
  readonly data: FileSystemDirectoryHandle;
  /** Alleen als de installatiemap gekozen is; nodig voor Skyrim.ccc en de INI. */
  readonly root: FileSystemDirectoryHandle | undefined;
  readonly report: DataFolderReport;
}

export function isFileSystemAccessSupported(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

export async function getStoredGameFolder(): Promise<StoredGameFolder> {
  const handle = await loadDirectoryHandle(HANDLE_KEY);
  if (!handle) return { status: 'none' };
  const permission = await handle.queryPermission({ mode: 'read' });
  if (permission === 'granted') return { status: 'granted', handle };
  if (permission === 'prompt') return { status: 'needs-permission', handle };
  return { status: 'none' };
}

/** Moet vanuit een klik aangeroepen worden. */
export async function requestFolderAccess(handle: FileSystemDirectoryHandle): Promise<boolean> {
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

/** Moet vanuit een klik aangeroepen worden. `undefined` als de gebruiker annuleert. */
export async function pickGameFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  if (!window.showDirectoryPicker) {
    throw new Error('Deze browser ondersteunt de File System Access API niet.');
  }
  try {
    return await window.showDirectoryPicker({ id: 'skyrim-data', mode: 'read' });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return undefined;
    throw error;
  }
}

export async function rememberGameFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  await saveDirectoryHandle(HANDLE_KEY, handle);
}

export async function forgetGameFolder(): Promise<void> {
  await deleteHandle(HANDLE_KEY);
}

async function listEntries(handle: FileSystemDirectoryHandle): Promise<FolderEntry[]> {
  const entries: FolderEntry[] = [];
  for await (const entry of handle.values()) entries.push({ name: entry.name, kind: entry.kind });
  return entries;
}

/** Accepteert de installatiemap (aanbevolen) of de Data-map zelf. */
export async function resolveGameFolder(
  picked: FileSystemDirectoryHandle,
): Promise<ResolvedGameFolder> {
  const entries = await listEntries(picked);
  const report = checkDataFolder(entries);
  if (report.ok || !report.looksLikeGameRoot) return { data: picked, root: undefined, report };

  const dataName = entries.find((e) => e.kind === 'directory' && e.name.toLowerCase() === 'data');
  const data = await picked.getDirectoryHandle(dataName?.name ?? 'Data');
  return { data, root: picked, report: checkDataFolder(await listEntries(data)) };
}
