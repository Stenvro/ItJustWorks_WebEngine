// File System Access API (WICG): Chromium only, and therefore not in TypeScript's DOM lib.
// https://wicg.github.io/file-system-access/

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite';
}

interface FileSystemHandle {
  queryPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
  requestPermission(descriptor?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>;
}

interface DirectoryPickerOptions {
  id?: string;
  mode?: 'read' | 'readwrite';
  startIn?:
    FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos';
}

interface OpenFilePickerOptions {
  id?: string;
  multiple?: boolean;
  excludeAcceptAllOption?: boolean;
  startIn?: DirectoryPickerOptions['startIn'];
  types?: { description?: string; accept: Record<string, string[]> }[];
}

interface Window {
  /** Missing outside Chromium; always check first. */
  showDirectoryPicker?(options?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>;
  /** Missing outside Chromium; always check first. */
  showOpenFilePicker?(options?: OpenFilePickerOptions): Promise<FileSystemFileHandle[]>;
}
