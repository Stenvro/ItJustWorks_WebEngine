import { describe, expect, it } from 'vitest';
import { BlockCache } from './block-cache.ts';
import { MemoryByteSource, type ByteSource } from './byte-source.ts';

/** A source of `size` bytes (byte i is i & 0xff) that counts and can fail its reads. */
class CountingSource implements ByteSource {
  readonly size: number;
  readonly #inner: MemoryByteSource;
  readonly reads: [number, number][] = [];
  fail = false;

  constructor(size: number) {
    this.size = size;
    this.#inner = new MemoryByteSource(Uint8Array.from({ length: size }, (_, i) => i & 0xff));
  }

  read(offset: number, length: number): Promise<Uint8Array> {
    this.reads.push([offset, length]);
    if (this.fail) return Promise.reject(new Error('unreadable'));
    return this.#inner.read(offset, length);
  }
}

const expected = (offset: number, length: number): number[] =>
  Array.from({ length }, (_, i) => (offset + i) & 0xff);

describe('BlockCache', () => {
  it('reads small ranges through whole blocks, once each', async () => {
    const file = new CountingSource(1000);
    const cache = new BlockCache(100, 1000);
    const source = cache.wrap(file);
    expect(source.size).toBe(1000);
    expect([...(await source.read(10, 20))]).toEqual(expected(10, 20));
    expect([...(await source.read(40, 5))]).toEqual(expected(40, 5));
    expect(file.reads).toEqual([[0, 100]]);
    expect(cache.reads).toBe(1);
    expect(cache.hits).toBe(1);
  });

  it('joins a range that spans two blocks', async () => {
    const file = new CountingSource(1000);
    const source = new BlockCache(100, 1000).wrap(file);
    expect([...(await source.read(150, 100))]).toEqual(expected(150, 100));
    expect(file.reads).toEqual([
      [100, 100],
      [200, 100],
    ]);
  });

  it('reads the short last block of a file', async () => {
    const file = new CountingSource(250);
    const source = new BlockCache(100, 1000).wrap(file);
    expect([...(await source.read(240, 10))]).toEqual(expected(240, 10));
    expect(file.reads).toEqual([[200, 50]]);
    await expect(source.read(245, 10)).rejects.toThrow(RangeError);
  });

  it('reads large ranges directly, without keeping them', async () => {
    const file = new CountingSource(1000);
    const source = new BlockCache(100, 1000).wrap(file);
    expect([...(await source.read(5, 300))]).toEqual(expected(5, 300));
    await source.read(5, 300);
    expect(file.reads).toEqual([
      [5, 300],
      [5, 300],
    ]);
  });

  it('returns copies that do not hold the block', async () => {
    const source = new BlockCache(100, 1000).wrap(new CountingSource(1000));
    const bytes = await source.read(10, 4);
    expect(bytes.buffer.byteLength).toBe(4);
    bytes[0] = 99;
    expect((await source.read(10, 1))[0]).toBe(10);
  });

  it('shares one read between readers waiting on the same block', async () => {
    const file = new CountingSource(1000);
    const source = new BlockCache(100, 1000).wrap(file);
    await Promise.all([source.read(0, 10), source.read(20, 10), source.read(90, 10)]);
    expect(file.reads).toEqual([[0, 100]]);
  });

  it('drops the least recently used block beyond its budget', async () => {
    const file = new CountingSource(1000);
    const source = new BlockCache(100, 200).wrap(file);
    await source.read(0, 1); // block 0
    await source.read(100, 1); // block 1
    await source.read(0, 1); // block 0 used again
    await source.read(200, 1); // block 2: block 1 goes
    await source.read(0, 1);
    await source.read(100, 1);
    expect(file.reads.map(([offset]) => offset)).toEqual([0, 100, 200, 100]);
  });

  it('keeps the blocks of each source apart', async () => {
    const cache = new BlockCache(100, 1000);
    const a = new CountingSource(1000);
    const b = new CountingSource(1000);
    await cache.wrap(a).read(0, 10);
    await cache.wrap(b).read(0, 10);
    expect(a.reads).toHaveLength(1);
    expect(b.reads).toHaveLength(1);
  });

  it('does not keep a failed read', async () => {
    const file = new CountingSource(1000);
    const source = new BlockCache(100, 1000).wrap(file);
    file.fail = true;
    await expect(source.read(0, 10)).rejects.toThrow('unreadable');
    file.fail = false;
    expect([...(await source.read(0, 10))]).toEqual(expected(0, 10));
    expect(file.reads).toHaveLength(2);
  });
});
