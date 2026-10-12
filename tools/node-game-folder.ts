import { open, readdir, readFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { checkReadRange, type ByteSource } from '../src/formats/byte-source.ts';
import type { GameFolder } from '../src/vfs/game-folder.ts';

/** Leest een bestand op offset, zonder het in zijn geheel te laden. */
export class NodeFileSource implements ByteSource {
  readonly size: number;
  readonly #handle: FileHandle;

  private constructor(handle: FileHandle, size: number) {
    this.#handle = handle;
    this.size = size;
  }

  static async open(filePath: string): Promise<NodeFileSource> {
    const handle = await open(filePath, 'r');
    try {
      return new NodeFileSource(handle, (await handle.stat()).size);
    } catch (error) {
      await handle.close();
      throw error;
    }
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    checkReadRange(this.size, offset, length);
    const buffer = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.#handle.read(buffer, done, length - done, offset + done);
      if (bytesRead === 0) throw new Error(`Onverwacht einde van het bestand bij ${offset + done}`);
      done += bytesRead;
    }
    return buffer;
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}

/** Shadercache van de originele exe; geen content. */
const IGNORED = /^shadercache([\\/]|$)/i;

export class NodeGameFolder implements GameFolder {
  readonly dataDir: string;
  readonly rootDir: string | undefined;

  constructor(dataDir: string, rootDir?: string) {
    this.dataDir = dataDir;
    this.rootDir = rootDir;
  }

  async listDataFiles(): Promise<readonly string[]> {
    const entries = await readdir(this.dataDir, { recursive: true, withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(this.dataDir, path.join(entry.parentPath, entry.name)))
      .filter((relative) => !IGNORED.test(relative));
  }

  openDataFile(relativePath: string): Promise<ByteSource> {
    return NodeFileSource.open(path.join(this.dataDir, relativePath));
  }

  async readRootFile(name: string): Promise<Uint8Array | undefined> {
    if (this.rootDir === undefined) return undefined;
    const match = (await readdir(this.rootDir)).find((n) => n.toLowerCase() === name.toLowerCase());
    return match === undefined
      ? undefined
      : new Uint8Array(await readFile(path.join(this.rootDir, match)));
  }
}
