import { describe, expect, it } from 'vitest';
import { buildBsa, type BsaFile } from '../../../tests/helpers/bsa-builder.ts';
import { FormatError } from '../binary-reader.ts';
import { MemoryByteSource } from '../byte-source.ts';
import { BsaArchive } from './bsa.ts';
import { bsaHash } from './bsa-hash.ts';

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const files: BsaFile[] = [
  { path: 'meshes\\clutter\\bucket.nif', data: ascii('bucket') },
  { path: 'meshes\\clutter\\Plate.NIF', data: ascii('plate'.repeat(1000)), compress: true },
  { path: 'textures/sky/cloud.dds', data: ascii('cloud') },
];

async function open(
  bytes: Uint8Array,
  options?: Parameters<typeof BsaArchive.open>[1],
): Promise<BsaArchive> {
  return BsaArchive.open(new MemoryByteSource(bytes), options);
}

describe('BsaArchive', () => {
  it('reads the index and files, with per-file compression', async () => {
    const archive = await open(buildBsa(files), { verifyHashes: true });
    expect(archive.header.fileCount).toBe(3);
    expect(archive.entries.map((e) => e.path)).toEqual([
      'meshes\\clutter\\bucket.nif',
      'meshes\\clutter\\plate.nif',
      'textures\\sky\\cloud.dds',
    ]);

    const plate = archive.get('Meshes/Clutter/PLATE.nif');
    expect(plate?.compressed).toBe(true);
    if (!plate) throw new Error('plate missing');
    expect(text(await archive.read(plate))).toBe('plate'.repeat(1000));

    const cloud = archive.get('textures\\sky\\cloud.dds');
    if (!cloud) throw new Error('cloud missing');
    expect(cloud.compressed).toBe(false);
    expect(text(await archive.read(cloud))).toBe('cloud');
    expect(archive.get('textures\\sky\\missing.dds')).toBeUndefined();
  });

  it('respects default compression with the toggle bit', async () => {
    const archive = await open(
      buildBsa(
        files.map((f) => ({ ...f, compress: f.compress !== true })),
        { compressedByDefault: true },
      ),
    );
    const bucket = archive.get('meshes\\clutter\\bucket.nif');
    const plate = archive.get('meshes\\clutter\\plate.nif');
    if (!bucket || !plate) throw new Error('entries missing');
    expect(bucket.compressed).toBe(true);
    expect(plate.compressed).toBe(false);
    expect(text(await archive.read(bucket))).toBe('bucket');
  });

  it('skips embedded file names', async () => {
    const archive = await open(buildBsa(files, { embedFileNames: true }));
    for (const file of files) {
      const entry = archive.get(file.path);
      if (!entry) throw new Error(`${file.path} missing`);
      expect(await archive.read(entry)).toEqual(file.data);
    }
  });

  it('looks up by hash in archives without names', async () => {
    const archive = await open(buildBsa(files, { includeNames: false }));
    expect(archive.hasNames).toBe(false);
    expect(archive.entries.every((e) => e.path === undefined)).toBe(true);
    const cloud = archive.get('Textures\\Sky\\Cloud.dds');
    if (!cloud) throw new Error('cloud not found by hash');
    expect(text(await archive.read(cloud))).toBe('cloud');
  });

  it('detects a wrong hash when verification is enabled', async () => {
    const bytes = buildBsa(files, { corruptFirstFileHash: true });
    await expect(open(bytes, { verifyHashes: true })).rejects.toThrow(/Hash mismatch/);
    await expect(open(bytes)).resolves.toBeInstanceOf(BsaArchive);
  });

  it('rejects other magic, versions and truncated archives', async () => {
    await expect(open(ascii('NOPE'.repeat(10)))).rejects.toThrow(/Not a BSA/);
    await expect(open(buildBsa(files, { version: 104 }))).rejects.toThrow(/version 104/);
    await expect(open(buildBsa(files).subarray(0, 60))).rejects.toThrow(FormatError);
  });

  it('throws FormatError for a file past the end', async () => {
    const bytes = buildBsa(files);
    const archive = await open(bytes.subarray(0, bytes.length - 2));
    const cloud = archive.get('textures\\sky\\cloud.dds');
    if (!cloud) throw new Error('cloud missing');
    await expect(archive.read(cloud)).rejects.toThrow(FormatError);
  });
});

describe('bsaHash', () => {
  it('is case-insensitive and treats / as \\', () => {
    expect(bsaHash('Meshes/Clutter', true)).toBe(bsaHash('meshes\\clutter', true));
    expect(bsaHash('Foo.NIF', false)).toBe(bsaHash('foo.nif', false));
  });

  it('sets extension flags in the low half', () => {
    const low = (name: string): bigint => bsaHash(name, false) & 0xffffffffn;
    expect(low('ab.nif') & 0x8000n).toBe(0x8000n);
    expect(low('ab.dds') & 0x8080n).toBe(0x8080n);
    expect(low('ab.wav') & 0x80000000n).toBe(0x80000000n);
  });

  it('encodes length, first and last characters in the low half', () => {
    // "abc": last 'c', second-to-last 'b', length 3, first 'a'
    expect(bsaHash('abc', true) & 0xffffffffn).toBe(0x61036263n);
  });
});
