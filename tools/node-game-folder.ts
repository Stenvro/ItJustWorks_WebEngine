import { open, readdir, readFile, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { checkReadRange, type ByteSource } from '../src/formats/byte-source.ts';
import type { GameFolder } from '../src/vfs/game-folder.ts';

/**
 * The reads of a folder's files in flight: the headless simulation (src/sim/) lets the work a
 * step started finish its reads within the step, so every run reads and steps alike.
 */
export class ReadsInFlight {
  #count = 0;

  get pending(): number {
    return this.#count;
  }

  async track<T>(read: Promise<T>): Promise<T> {
    this.#count++;
    try {
      return await read;
    } finally {
      this.#count--;
    }
  }
}

/** Reads a file at an offset, without loading it in full. */
export class NodeFileSource implements ByteSource {
  readonly size: number;
  readonly #handle: FileHandle;
  readonly #reads: ReadsInFlight | undefined;

  private constructor(handle: FileHandle, size: number, reads: ReadsInFlight | undefined) {
    this.#handle = handle;
    this.size = size;
    this.#reads = reads;
  }

  static async open(filePath: string, reads?: ReadsInFlight): Promise<NodeFileSource> {
    const opening = (async () => {
      const handle = await open(filePath, 'r');
      try {
        return new NodeFileSource(handle, (await handle.stat()).size, reads);
      } catch (error) {
        await handle.close();
        throw error;
      }
    })();
    return reads ? reads.track(opening) : opening;
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    const reading = this.#read(offset, length);
    return this.#reads ? this.#reads.track(reading) : reading;
  }

  async #read(offset: number, length: number): Promise<Uint8Array> {
    checkReadRange(this.size, offset, length);
    const buffer = new Uint8Array(length);
    let done = 0;
    while (done < length) {
      const { bytesRead } = await this.#handle.read(buffer, done, length - done, offset + done);
      if (bytesRead === 0) throw new Error(`Unexpected end of file at ${offset + done}`);
      done += bytesRead;
    }
    return buffer;
  }

  async close(): Promise<void> {
    await this.#handle.close();
  }
}

/** Shader cache of the original exe; not content. */
const IGNORED = /^shadercache([\\/]|$)/i;

export class NodeGameFolder implements GameFolder {
  readonly dataDir: string;
  readonly rootDir: string | undefined;
  /** Its files' reads in flight. */
  readonly reads = new ReadsInFlight();

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
    return NodeFileSource.open(path.join(this.dataDir, relativePath), this.reads);
  }

  async readRootFile(name: string): Promise<Uint8Array | undefined> {
    if (this.rootDir === undefined) return undefined;
    const match = (await readdir(this.rootDir)).find((n) => n.toLowerCase() === name.toLowerCase());
    return match === undefined
      ? undefined
      : new Uint8Array(await readFile(path.join(this.rootDir, match)));
  }
}
