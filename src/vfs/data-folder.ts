import { checkDataFolder, type DataFolderReport, type FolderEntry } from './data-folder-check.ts';
import { deleteHandle, loadDirectoryHandle, saveDirectoryHandle } from './handle-store.ts';

const HANDLE_KEY = 'data-folder';

export type StoredDataFolder =
  | { readonly status: 'none' }
  | { readonly status: 'granted'; readonly handle: FileSystemDirectoryHandle }
  /** Handle bekend, maar de browser vraagt opnieuw toestemming (vereist een klik). */
  | { readonly status: 'needs-permission'; readonly handle: FileSystemDirectoryHandle };

export function isFileSystemAccessSupported(): boolean {
  return typeof window.showDirectoryPicker === 'function';
}

export async function getStoredDataFolder(): Promise<StoredDataFolder> {
  const handle = await loadDirectoryHandle(HANDLE_KEY);
  if (!handle) return { status: 'none' };
  const permission = await handle.queryPermission({ mode: 'read' });
  if (permission === 'granted') return { status: 'granted', handle };
  if (permission === 'prompt') return { status: 'needs-permission', handle };
  return { status: 'none' };
}

/** Moet vanuit een klik aangeroepen worden. */
export async function requestDataFolderAccess(handle: FileSystemDirectoryHandle): Promise<boolean> {
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

/** Moet vanuit een klik aangeroepen worden. `undefined` als de gebruiker annuleert. */
export async function pickDataFolder(): Promise<FileSystemDirectoryHandle | undefined> {
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

export async function rememberDataFolder(handle: FileSystemDirectoryHandle): Promise<void> {
  await saveDirectoryHandle(HANDLE_KEY, handle);
}

export async function forgetDataFolder(): Promise<void> {
  await deleteHandle(HANDLE_KEY);
}

export async function inspectDataFolder(
  handle: FileSystemDirectoryHandle,
): Promise<DataFolderReport> {
  const entries: FolderEntry[] = [];
  for await (const entry of handle.values()) {
    entries.push({ name: entry.name, kind: entry.kind });
  }
  return checkDataFolder(entries);
}
