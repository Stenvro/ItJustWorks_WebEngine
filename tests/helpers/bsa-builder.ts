// Bouwt kleine BSA v105-archieven in geheugen voor unit tests (geen gamedata).

import { bsaHash } from '../../src/formats/bsa/bsa-hash.ts';
import { fileNameOf, folderOf, normalizePath } from '../../src/formats/paths.ts';
import { encodeWindows1252 } from '../../src/formats/text.ts';
import { literalFrame } from './lz4-frame.ts';

export interface BsaFile {
  readonly path: string;
  readonly data: Uint8Array;
  /** Standaard: volgens `compressedByDefault`. */
  readonly compress?: boolean;
}

export interface BsaBuildOptions {
  readonly version?: number;
  readonly compressedByDefault?: boolean;
  readonly embedFileNames?: boolean;
  readonly includeNames?: boolean;
  /** Schrijf een verkeerde hash voor het eerste bestand. */
  readonly corruptFirstFileHash?: boolean;
}

interface PlannedFile {
  readonly name: string;
  readonly payload: Uint8Array;
  readonly toggled: boolean;
}

export function buildBsa(files: readonly BsaFile[], options: BsaBuildOptions = {}): Uint8Array {
  const includeNames = options.includeNames ?? true;
  const compressedByDefault = options.compressedByDefault ?? false;

  const folders = new Map<string, PlannedFile[]>();
  for (const file of files) {
    const path = normalizePath(file.path);
    const compress = file.compress ?? compressedByDefault;
    const parts: number[] = [];
    if (options.embedFileNames) {
      const name = encodeWindows1252(path);
      parts.push(name.length, ...name);
    }
    if (compress) {
      const size = file.data.length;
      parts.push(size & 0xff, (size >>> 8) & 0xff, (size >>> 16) & 0xff, size >>> 24);
      parts.push(...literalFrame(file.data));
    } else {
      parts.push(...file.data);
    }
    const folder = folderOf(path);
    const list = folders.get(folder) ?? [];
    list.push({
      name: fileNameOf(path),
      payload: Uint8Array.from(parts),
      toggled: compress !== compressedByDefault,
    });
    folders.set(folder, list);
  }

  const folderList = [...folders.entries()];
  const totalFolderNameLength = includeNames
    ? folderList.reduce((sum, [name]) => sum + name.length + 1, 0)
    : 0;
  const totalFileNameLength = includeNames
    ? files.reduce((sum, f) => sum + fileNameOf(f.path).length + 1, 0)
    : 0;

  let position = 36 + folderList.length * 24;
  const blockOffsets = folderList.map(([name, list]) => {
    const offset = position;
    position += (includeNames ? name.length + 2 : 0) + list.length * 16;
    return offset;
  });
  const namesOffset = position;
  position += totalFileNameLength;
  const dataOffset = position;
  const dataSize = folderList.reduce(
    (sum, [, list]) => sum + list.reduce((s, f) => s + f.payload.length, 0),
    0,
  );

  const out = new Uint8Array(dataOffset + dataSize);
  const view = new DataView(out.buffer);
  out.set(encodeWindows1252('BSA\0'), 0);
  const flags =
    (includeNames ? 0x3 : 0) |
    (compressedByDefault ? 0x4 : 0) |
    (options.embedFileNames ? 0x100 : 0);
  [options.version ?? 105, 36, flags, folderList.length, files.length].forEach((v, i) => {
    view.setUint32(4 + i * 4, v, true);
  });
  view.setUint32(24, totalFolderNameLength, true);
  view.setUint32(28, totalFileNameLength, true);

  let names = namesOffset;
  let data = dataOffset;
  let first = true;
  folderList.forEach(([folderName, list], i) => {
    const record = 36 + i * 24;
    const blockOffset = blockOffsets[i] ?? 0;
    view.setBigUint64(record, bsaHash(folderName, true), true);
    view.setUint32(record + 8, list.length, true);
    view.setBigUint64(record + 16, BigInt(blockOffset + totalFileNameLength), true);

    let p = blockOffset;
    if (includeNames) {
      out[p++] = folderName.length + 1;
      out.set(encodeWindows1252(folderName), p);
      p += folderName.length + 1;
    }
    for (const file of list) {
      const hash = bsaHash(file.name, false) ^ (first && options.corruptFirstFileHash ? 1n : 0n);
      first = false;
      view.setBigUint64(p, hash, true);
      view.setUint32(p + 8, file.payload.length | (file.toggled ? 0x40000000 : 0), true);
      view.setUint32(p + 12, data, true);
      p += 16;
      out.set(file.payload, data);
      data += file.payload.length;
      if (includeNames) {
        out.set(encodeWindows1252(file.name), names);
        names += file.name.length + 1;
      }
    }
  });
  return out;
}
