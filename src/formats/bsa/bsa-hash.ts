import { asciiLowerCase, encodeWindows1252 } from '../text.ts';

// The 64-bit "TES hash" BSAs use to index folders and files (Oblivion through Skyrim SE).
// Source: UESP "Oblivion Mod:Hash Calculation", BSArch.

const EXTENSION_FLAGS: Readonly<Record<string, number>> = {
  '.kf': 0x80,
  '.nif': 0x8000,
  '.dds': 0x8080,
  '.wav': 0x80000000,
};

function rollingHash(bytes: Uint8Array, start: number, end: number): number {
  let hash = 0;
  for (let i = start; i < end; i++) hash = (Math.imul(hash, 0x1003f) + (bytes[i] ?? 0)) | 0;
  return hash;
}

/**
 * Hash of a folder path (`meshes\clutter`) or a file name without folder (`foo.nif`).
 * For files the extension is hashed separately; for folders it is not.
 */
export function bsaHash(name: string, isFolder: boolean): bigint {
  const bytes = encodeWindows1252(asciiLowerCase(name).replaceAll('/', '\\'));
  const dot = isFolder ? -1 : bytes.lastIndexOf(0x2e);
  const stemLength = dot < 0 ? bytes.length : dot;
  const extension = dot < 0 ? '' : asciiLowerCase(name.slice(dot));

  let low = 0;
  if (stemLength > 0) {
    low =
      (bytes[stemLength - 1] ?? 0) +
      (stemLength > 2 ? (bytes[stemLength - 2] ?? 0) << 8 : 0) +
      (stemLength << 16) +
      ((bytes[0] ?? 0) << 24);
  }
  low = (low | (EXTENSION_FLAGS[extension] ?? 0)) >>> 0;

  const stemHash = rollingHash(bytes, 1, stemLength - 2);
  const extensionHash = rollingHash(bytes, stemLength, bytes.length);
  const high = (stemHash + extensionHash) >>> 0;

  return (BigInt(high) << 32n) | BigInt(low);
}
