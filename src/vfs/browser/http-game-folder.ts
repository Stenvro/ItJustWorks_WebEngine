// Development only: reads the game data from the Vite dev server (tools/dev-gamedata-plugin.ts)
// instead of a folder picked with the File System Access API.

import { checkReadRange, type ByteSource } from '../../formats/byte-source.ts';
import type { GameFolder } from '../game-folder.ts';

const BASE = '/@gamedata/';

class HttpByteSource implements ByteSource {
  readonly size: number;
  readonly #url: string;

  constructor(url: string, size: number) {
    this.#url = url;
    this.size = size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    checkReadRange(this.size, offset, length);
    if (length === 0) return new Uint8Array(0);
    const response = await fetch(this.#url, {
      headers: { Range: `bytes=${offset}-${offset + length - 1}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${this.#url}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== length) {
      throw new Error(`Expected ${length} bytes from ${this.#url}, got ${bytes.length}`);
    }
    return bytes;
  }
}

const encodePath = (path: string): string => path.split(/[\\/]/).map(encodeURIComponent).join('/');

export class HttpGameFolder implements GameFolder {
  readonly #sizes = new Map<string, number>();

  /** True if the dev server offers game data. */
  static async available(): Promise<boolean> {
    try {
      const response = await fetch(`${BASE}list`, { method: 'HEAD' });
      return response.ok && response.headers.get('content-type') === 'application/json';
    } catch {
      return false;
    }
  }

  async listDataFiles(): Promise<readonly string[]> {
    const response = await fetch(`${BASE}list`);
    if (!response.ok) throw new Error(`Dev game data unavailable (HTTP ${response.status})`);
    const files = (await response.json()) as { path: string; size: number }[];
    this.#sizes.clear();
    for (const file of files) this.#sizes.set(file.path, file.size);
    return files.map((file) => file.path);
  }

  openDataFile(relativePath: string): Promise<ByteSource> {
    const size = this.#sizes.get(relativePath);
    if (size === undefined) return Promise.reject(new Error(`Not listed: ${relativePath}`));
    return Promise.resolve(new HttpByteSource(`${BASE}data/${encodePath(relativePath)}`, size));
  }

  async readRootFile(name: string): Promise<Uint8Array | undefined> {
    const response = await fetch(`${BASE}root/${encodeURIComponent(name)}`);
    return response.ok ? new Uint8Array(await response.arrayBuffer()) : undefined;
  }
}
