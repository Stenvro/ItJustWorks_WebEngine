// Small reads of a large file through a cache of fixed-size blocks: many reads close together
// (the records of one cell, the scripts of one archive folder) become one read of their block,
// and a read whose block was read lately costs no I/O at all. In the browser every read is a
// round trip (a Blob slice or an HTTP range request) of about the same cost whatever its size,
// so record-by-record reads otherwise wait on one round trip each. Large reads (a scan's
// chunks, a texture) go to the file directly and are not kept. The blocks of all sources share
// one budget; the least recently used block goes first. Platform-independent.
// Notes: docs/formats/esm.md ("Reading records").

import { checkReadRange, type ByteSource } from './byte-source.ts';

/** Bytes per block: a cell's references and a folder's small files fit in a few. */
export const DEFAULT_BLOCK_SIZE = 64 * 1024;
/** The blocks kept at most, of all sources together (32 MB). */
export const DEFAULT_CACHE_BYTES = 32 * 1024 * 1024;

export class BlockCache {
  readonly blockSize: number;
  readonly maxBlocks: number;
  /** Least recently used first (a Map keeps insertion order; a hit moves its block last). */
  readonly #blocks = new Map<string, Promise<Uint8Array>>();
  #sources = 0;
  /** Reads that went to a file (blocks read and large reads), for statistics. */
  reads = 0;
  /** Small reads served from a block already read or being read. */
  hits = 0;

  constructor(blockSize = DEFAULT_BLOCK_SIZE, maxBytes = DEFAULT_CACHE_BYTES) {
    this.blockSize = blockSize;
    this.maxBlocks = Math.max(1, Math.floor(maxBytes / blockSize));
  }

  /** A source read through this cache. */
  wrap(source: ByteSource): ByteSource {
    return new CachedByteSource(source, this, this.#sources++);
  }

  /** One block of a source: the one kept, or read now (and kept). */
  block(source: ByteSource, id: number, index: number): Promise<Uint8Array> {
    const key = `${String(id)}:${String(index)}`;
    const kept = this.#blocks.get(key);
    if (kept) {
      this.hits++;
      this.#blocks.delete(key);
      this.#blocks.set(key, kept);
      return kept;
    }
    const start = index * this.blockSize;
    const length = Math.min(this.blockSize, source.size - start);
    this.reads++;
    const pending = source.read(start, length);
    // A failed read is not kept: the next read tries again.
    pending.catch(() => {
      if (this.#blocks.get(key) === pending) this.#blocks.delete(key);
    });
    this.#blocks.set(key, pending);
    while (this.#blocks.size > this.maxBlocks) {
      const oldest = this.#blocks.keys().next().value;
      if (oldest === undefined) break;
      this.#blocks.delete(oldest);
    }
    return pending;
  }
}

class CachedByteSource implements ByteSource {
  readonly #source: ByteSource;
  readonly #cache: BlockCache;
  readonly #id: number;

  constructor(source: ByteSource, cache: BlockCache, id: number) {
    this.#source = source;
    this.#cache = cache;
    this.#id = id;
  }

  get size(): number {
    return this.#source.size;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    checkReadRange(this.size, offset, length);
    const cache = this.#cache;
    const blockSize = cache.blockSize;
    if (length > blockSize) {
      cache.reads++;
      return this.#source.read(offset, length);
    }
    if (length === 0) return new Uint8Array(0);
    const first = Math.floor(offset / blockSize);
    const last = Math.floor((offset + length - 1) / blockSize);
    if (first === last) {
      const block = await cache.block(this.#source, this.#id, first);
      const at = offset - first * blockSize;
      // A copy: what the caller keeps must not hold the whole block in memory.
      return block.slice(at, at + length);
    }
    const [head, tail] = await Promise.all([
      cache.block(this.#source, this.#id, first),
      cache.block(this.#source, this.#id, last),
    ]);
    const bytes = new Uint8Array(length);
    const at = offset - first * blockSize;
    bytes.set(head.subarray(at), 0);
    bytes.set(tail.subarray(0, length - (head.length - at)), head.length - at);
    return bytes;
  }

  close(): Promise<void> {
    return this.#source.close?.() ?? Promise.resolve();
  }
}
