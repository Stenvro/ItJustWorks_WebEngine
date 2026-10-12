// BSA v105 (Skyrim Special Edition). Format: docs/formats/bsa.md

import { BinaryReader, FormatError } from '../binary-reader.ts';
import type { ByteSource } from '../byte-source.ts';
import { decompressLz4Frame } from '../lz4/lz4.ts';
import { fileNameOf, folderOf, normalizePath } from '../paths.ts';
import { decodeWindows1252 } from '../text.ts';
import { bsaHash } from './bsa-hash.ts';

export const BSA_VERSION_SSE = 105;

const HEADER_SIZE = 36;
const FOLDER_RECORD_SIZE = 24;
const FILE_RECORD_SIZE = 16;
const SIZE_MASK = 0x3fffffff;
const COMPRESSION_TOGGLE = 0x40000000;

export const BsaArchiveFlag = {
  includeDirectoryNames: 0x1,
  includeFileNames: 0x2,
  compressed: 0x4,
  retainDirectoryNames: 0x8,
  retainFileNames: 0x10,
  retainFileNameOffsets: 0x20,
  xbox360: 0x40,
  retainStringsDuringStartup: 0x80,
  embedFileNames: 0x100,
  xmemCodec: 0x200,
} as const;

export interface BsaHeader {
  readonly version: number;
  readonly archiveFlags: number;
  readonly folderCount: number;
  readonly fileCount: number;
  readonly totalFolderNameLength: number;
  readonly totalFileNameLength: number;
  /** Kinds of content (meshes, textures, ...); informational only. */
  readonly fileFlags: number;
}

export interface BsaEntry {
  /** Normalized path, or `undefined` if the archive contains no names. */
  readonly path: string | undefined;
  readonly offset: number;
  /** Stored size, including any embedded name and size prefix. */
  readonly size: number;
  readonly compressed: boolean;
}

/** A file's stored bytes: either the data itself or one LZ4 frame. */
export interface BsaPayload {
  readonly bytes: Uint8Array;
  readonly compressed: boolean;
  /** Size after decompression. */
  readonly originalSize: number;
}

/** Turns a payload into the file's contents (decompressing if needed). */
export function decodeBsaPayload(payload: BsaPayload): Uint8Array {
  return payload.compressed
    ? decompressLz4Frame(payload.bytes, payload.originalSize)
    : payload.bytes;
}

export interface BsaOpenOptions {
  /** Verify every folder and file name against the stored hash (for tools and tests). */
  readonly verifyHashes?: boolean;
}

function readHash(reader: BinaryReader): bigint {
  const low = reader.u32();
  const high = reader.u32();
  return (BigInt(high) << 32n) | BigInt(low);
}

function hashKey(folderHash: bigint, fileHash: bigint): string {
  return `${folderHash.toString(16)}:${fileHash.toString(16)}`;
}

function parseHeader(bytes: Uint8Array): BsaHeader & { readonly folderRecordOffset: number } {
  const reader = new BinaryReader(bytes);
  const magic = reader.fourCC();
  if (magic !== 'BSA\0')
    throw new FormatError(`Not a BSA archive (magic ${JSON.stringify(magic)})`, 0);
  const version = reader.u32();
  if (version !== BSA_VERSION_SSE) {
    throw new FormatError(
      `BSA version ${version} is not supported; Skyrim SE uses version ${BSA_VERSION_SSE}`,
      4,
    );
  }
  const header = {
    version,
    folderRecordOffset: reader.u32(),
    archiveFlags: reader.u32(),
    folderCount: reader.u32(),
    fileCount: reader.u32(),
    totalFolderNameLength: reader.u32(),
    totalFileNameLength: reader.u32(),
    fileFlags: reader.u16(),
  };
  if (header.archiveFlags & BsaArchiveFlag.xbox360) {
    throw new FormatError('Xbox 360 (big-endian) archives are not supported', 12);
  }
  if (header.folderRecordOffset < HEADER_SIZE) {
    throw new FormatError(`Invalid header size ${header.folderRecordOffset}`, 8);
  }
  return header;
}

/** Reads a null-terminated string; returns the text and the position after the null. */
function readZString(bytes: Uint8Array, start: number): [string, number] {
  const end = bytes.indexOf(0, start);
  if (end < 0) throw new FormatError('File name without terminating null', start);
  return [decodeWindows1252(bytes, start, end), end + 1];
}

export class BsaArchive {
  readonly header: BsaHeader;
  readonly entries: readonly BsaEntry[];
  readonly #source: ByteSource;
  /** Keyed by path (if the archive contains names), otherwise by hash. */
  readonly #index: Map<string, BsaEntry>;

  private constructor(
    source: ByteSource,
    header: BsaHeader,
    entries: BsaEntry[],
    index: Map<string, BsaEntry>,
  ) {
    this.#source = source;
    this.header = header;
    this.entries = entries;
    this.#index = index;
  }

  static async open(source: ByteSource, options: BsaOpenOptions = {}): Promise<BsaArchive> {
    if (source.size < HEADER_SIZE) {
      throw new FormatError(`File too small for a BSA header (${source.size} bytes)`, 0);
    }
    const header = parseHeader(await source.read(0, HEADER_SIZE));
    const flags = header.archiveFlags;
    const hasFolderNames = (flags & BsaArchiveFlag.includeDirectoryNames) !== 0;
    const hasFileNames = (flags & BsaArchiveFlag.includeFileNames) !== 0;
    const hasNames = hasFolderNames && hasFileNames;
    const compressedByDefault = (flags & BsaArchiveFlag.compressed) !== 0;

    // Folder records, file record blocks and the name block follow the header contiguously.
    const fileNamesStart =
      header.folderRecordOffset +
      header.folderCount * FOLDER_RECORD_SIZE +
      (hasFolderNames ? header.folderCount + header.totalFolderNameLength : 0) +
      header.fileCount * FILE_RECORD_SIZE;
    const directoryEnd = fileNamesStart + (hasFileNames ? header.totalFileNameLength : 0);
    if (directoryEnd > source.size) {
      throw new FormatError(`Index (${directoryEnd} bytes) is larger than the archive`, 0);
    }
    const directory = await source.read(0, directoryEnd);
    const reader = new BinaryReader(directory, header.folderRecordOffset);

    interface FolderRecord {
      readonly hash: bigint;
      readonly fileCount: number;
      readonly blockOffset: number;
    }
    const folders: FolderRecord[] = [];
    for (let i = 0; i < header.folderCount; i++) {
      const hash = readHash(reader);
      const fileCount = reader.u32();
      reader.skip(4); // padding
      // Offset points to the file record block, plus totalFileNameLength.
      const blockOffset = reader.u64Number() - header.totalFileNameLength;
      folders.push({ hash, fileCount, blockOffset });
    }

    const entries: BsaEntry[] = [];
    const index = new Map<string, BsaEntry>();
    let namePosition = fileNamesStart;
    let fileTotal = 0;

    for (const folder of folders) {
      fileTotal += folder.fileCount;
      if (fileTotal > header.fileCount) {
        throw new FormatError('Folders contain more files than the header states', 0);
      }
      reader.seek(folder.blockOffset);
      let folderName = '';
      if (hasFolderNames) {
        const length = reader.u8();
        const raw = reader.bytes(length);
        const nul = raw.indexOf(0); // name includes the terminating null
        folderName = decodeWindows1252(raw, 0, nul === -1 ? length : nul);
        if (options.verifyHashes && bsaHash(folderName, true) !== folder.hash) {
          throw new FormatError(`Hash mismatch for folder "${folderName}"`, folder.blockOffset);
        }
      }

      for (let i = 0; i < folder.fileCount; i++) {
        const fileHash = readHash(reader);
        const rawSize = reader.u32();
        const offset = reader.u32();

        let path: string | undefined;
        if (hasNames) {
          let fileName: string;
          [fileName, namePosition] = readZString(directory, namePosition);
          if (options.verifyHashes && bsaHash(fileName, false) !== fileHash) {
            throw new FormatError(`Hash mismatch for "${folderName}\\${fileName}"`, namePosition);
          }
          path = normalizePath(folderName === '.' ? fileName : `${folderName}\\${fileName}`);
        }

        const entry: BsaEntry = {
          path,
          offset,
          size: rawSize & SIZE_MASK,
          compressed: compressedByDefault !== ((rawSize & COMPRESSION_TOGGLE) !== 0),
        };
        entries.push(entry);
        const key = path ?? hashKey(folder.hash, fileHash);
        if (!index.has(key)) index.set(key, entry);
      }
    }
    if (fileTotal !== header.fileCount) {
      throw new FormatError(`Header states ${header.fileCount} files, found ${fileTotal}`, 0);
    }

    return new BsaArchive(source, header, entries, index);
  }

  /** Does the archive contain folder and file names? Without names, lookup is by hash only. */
  get hasNames(): boolean {
    const flags = this.header.archiveFlags;
    return (
      (flags & BsaArchiveFlag.includeDirectoryNames) !== 0 &&
      (flags & BsaArchiveFlag.includeFileNames) !== 0
    );
  }

  get(path: string): BsaEntry | undefined {
    const normalized = normalizePath(path);
    if (this.hasNames) return this.#index.get(normalized);
    const key = hashKey(
      bsaHash(folderOf(normalized), true),
      bsaHash(fileNameOf(normalized), false),
    );
    return this.#index.get(key);
  }

  /** Reads and decompresses a file. */
  async read(entry: BsaEntry): Promise<Uint8Array> {
    return decodeBsaPayload(await this.readPayload(entry));
  }

  /**
   * Reads a file's stored bytes without decompressing them. Lets the I/O happen on one
   * thread and the (CPU-heavy) decompression in a worker via `decodeBsaPayload`.
   */
  async readPayload(entry: BsaEntry): Promise<BsaPayload> {
    if (entry.offset + entry.size > this.#source.size) {
      throw new FormatError(
        `"${entry.path ?? '?'}" runs past the end of the archive`,
        entry.offset,
      );
    }
    const raw = await this.#source.read(entry.offset, entry.size);
    let start = 0;
    if (this.header.archiveFlags & BsaArchiveFlag.embedFileNames) {
      start = 1 + (raw[0] ?? 0); // bstring with the full path
    }
    if (!entry.compressed) {
      const bytes = raw.subarray(start);
      return { bytes, compressed: false, originalSize: bytes.length };
    }

    if (raw.length < start + 4) {
      throw new FormatError(
        `"${entry.path ?? '?'}" is too short for compressed data`,
        entry.offset,
      );
    }
    const originalSize = new DataView(raw.buffer, raw.byteOffset + start, 4).getUint32(0, true);
    return { bytes: raw.subarray(start + 4), compressed: true, originalSize };
  }

  async close(): Promise<void> {
    await this.#source.close?.();
  }
}
