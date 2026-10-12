import { checkReadRange, type ByteSource } from '../../formats/byte-source.ts';
import type { GameFolder } from '../game-folder.ts';

/** Leest uit een Blob/File op offset; de browser laadt alleen het gevraagde stuk. */
export class BlobByteSource implements ByteSource {
  readonly #blob: Blob;

  constructor(blob: Blob) {
    this.#blob = blob;
  }

  get size(): number {
    return this.#blob.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    checkReadRange(this.size, offset, length);
    return new Uint8Array(await this.#blob.slice(offset, offset + length).arrayBuffer());
  }
}

/** Shadercache van de originele exe; geen content. */
const IGNORED_ROOT_DIRECTORIES = new Set(['shadercache']);

async function findFile(
  directory: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | undefined> {
  const wanted = name.toLowerCase();
  for await (const handle of directory.values()) {
    if (handle.kind === 'file' && handle.name.toLowerCase() === wanted) return handle;
  }
  return undefined;
}

export class BrowserGameFolder implements GameFolder {
  readonly #data: FileSystemDirectoryHandle;
  readonly #root: FileSystemDirectoryHandle | undefined;
  readonly #files = new Map<string, FileSystemFileHandle>();

  /** `root` is de installatiemap; zonder root zijn Skyrim.ccc en de INI niet bereikbaar. */
  constructor(data: FileSystemDirectoryHandle, root?: FileSystemDirectoryHandle) {
    this.#data = data;
    this.#root = root;
  }

  async listDataFiles(): Promise<readonly string[]> {
    this.#files.clear();
    const walk = async (directory: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      const subdirectories: Promise<void>[] = [];
      for await (const handle of directory.values()) {
        const path = prefix + handle.name;
        if (handle.kind === 'file') {
          this.#files.set(path, handle);
        } else if (prefix !== '' || !IGNORED_ROOT_DIRECTORIES.has(handle.name.toLowerCase())) {
          subdirectories.push(walk(handle, `${path}/`));
        }
      }
      await Promise.all(subdirectories);
    };
    await walk(this.#data, '');
    return [...this.#files.keys()];
  }

  async openDataFile(relativePath: string): Promise<ByteSource> {
    const handle = this.#files.get(relativePath) ?? (await this.#resolve(relativePath));
    return new BlobByteSource(await handle.getFile());
  }

  async readRootFile(name: string): Promise<Uint8Array | undefined> {
    if (!this.#root) return undefined;
    const handle = await findFile(this.#root, name);
    return handle && new Uint8Array(await (await handle.getFile()).arrayBuffer());
  }

  async #resolve(relativePath: string): Promise<FileSystemFileHandle> {
    const parts = relativePath.split(/[\\/]+/).filter((part) => part !== '');
    const fileName = parts.pop();
    if (fileName === undefined) throw new Error(`Invalid path: ${relativePath}`);
    let directory = this.#data;
    for (const part of parts) directory = await directory.getDirectoryHandle(part);
    return directory.getFileHandle(fileName);
  }
}
