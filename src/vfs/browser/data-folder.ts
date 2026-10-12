import { checkDataFolder, type DataFolderReport, type FolderEntry } from '../data-folder-check.ts';
import { deleteHandle, loadDirectoryHandle, saveDirectoryHandle } from './handle-store.ts';

const HANDLE_KEY = 'data-folder';

export type StoredGameFolder =
  | { readonly status: 'none' }
  | { readonly status: 'granted'; readonly handle: FileSystemDirectoryHandle }
  /** Handle known, but the browser asks for permission again (requires a click). */
  | { readonly status: 'needs-permission'; readonly handle: FileSystemDirectoryHandle };

/** The selected folder, split into the Data folder and (if selected) the install folder. */
export interface ResolvedGameFolder {
  readonly data: FileSystemDirectoryHandle;
  /** Only if the install folder was selected; needed for Skyrim.ccc and the INI. */
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

/** Must be called from a click. */
export async function requestFolderAccess(handle: FileSystemDirectoryHandle): Promise<boolean> {
  return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

/** Must be called from a click. `undefined` if the user cancels. */
export async function pickGameFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  if (!window.showDirectoryPicker) {
    throw new Error('This browser does not support the File System Access API.');
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

/** Accepts the install folder (recommended) or the Data folder itself. */
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
