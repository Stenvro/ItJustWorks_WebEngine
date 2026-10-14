// Indexes a plugin by reading only record and group headers, in large sequential chunks.
// The index is stored in typed arrays: Skyrim.esm has close to a million records.

import { FormatError } from '../binary-reader.ts';
import type { ByteSource } from '../byte-source.ts';
import {
  GROUP_HEADER_SIZE,
  GRUP,
  RECORD_HEADER_SIZE,
  fourCCFromInt,
  parseRecordHeader,
  recordData,
  type RecordHeader,
} from './record.ts';

const DEFAULT_CHUNK = 8 * 1024 * 1024;

class GrowableUint32 {
  #data = new Uint32Array(1024);
  length = 0;

  push(value: number): void {
    if (this.length === this.#data.length) {
      const bigger = new Uint32Array(this.#data.length * 2);
      bigger.set(this.#data);
      this.#data = bigger;
    }
    this.#data[this.length++] = value;
  }

  set(index: number, value: number): void {
    this.#data[index] = value;
  }

  toArray(): Uint32Array {
    return this.#data.slice(0, this.length);
  }
}

export interface PluginIndex {
  readonly fileSize: number;
  readonly recordCount: number;
  /** Per record (in file order): type as a little-endian four-character code. */
  readonly types: Uint32Array;
  /** Per record: form id as stored in this plugin (high byte = master index). */
  readonly formIds: Uint32Array;
  /** Per record: offset of the record header. */
  readonly offsets: Uint32Array;
  readonly dataSizes: Uint32Array;
  readonly flags: Uint32Array;
  /** Per record: index of the innermost enclosing group + 1 (0 = none). */
  readonly parentGroups: Uint32Array;
  readonly groupCount: number;
  readonly groupOffsets: Uint32Array;
  readonly groupSizes: Uint32Array;
  readonly groupLabels: Uint32Array;
  readonly groupTypes: Uint32Array;
  /** Per group: index of the enclosing group + 1 (0 = top level). */
  readonly groupParents: Uint32Array;
  /** Per group: records [first, end) inside it, including nested groups. */
  readonly groupFirstRecord: Uint32Array;
  readonly groupEndRecord: Uint32Array;
  /** Form ids sorted ascending, and the record index for each. */
  readonly sortedFormIds: Uint32Array;
  readonly sortedRecords: Uint32Array;
}

/** Sequential reader that keeps one large chunk of the file in memory. */
class ChunkReader {
  readonly #source: ByteSource;
  readonly #chunkSize: number;
  #start = 0;
  #bytes: Uint8Array = new Uint8Array(0);

  constructor(source: ByteSource, chunkSize: number) {
    this.#source = source;
    this.#chunkSize = chunkSize;
  }

  /** Bytes [offset, offset + length), from the current chunk or a freshly read one. */
  async read(offset: number, length: number): Promise<Uint8Array> {
    if (offset < this.#start || offset + length > this.#start + this.#bytes.length) {
      const size = Math.min(Math.max(this.#chunkSize, length), this.#source.size - offset);
      if (size < length) throw new FormatError('Unexpected end of plugin', offset);
      this.#bytes = await this.#source.read(offset, size);
      this.#start = offset;
    }
    const at = offset - this.#start;
    return this.#bytes.subarray(at, at + length);
  }
}

export async function indexPlugin(
  source: ByteSource,
  chunkSize = DEFAULT_CHUNK,
): Promise<PluginIndex> {
  const reader = new ChunkReader(source, chunkSize);
  const types = new GrowableUint32();
  const formIds = new GrowableUint32();
  const offsets = new GrowableUint32();
  const dataSizes = new GrowableUint32();
  const flags = new GrowableUint32();
  const parentGroups = new GrowableUint32();
  const groupOffsets = new GrowableUint32();
  const groupSizes = new GrowableUint32();
  const groupLabels = new GrowableUint32();
  const groupTypes = new GrowableUint32();
  const groupParents = new GrowableUint32();
  const groupFirstRecord = new GrowableUint32();
  const groupEndRecord = new GrowableUint32();

  /** Open groups: [group index, end offset]. */
  const stack: [number, number][] = [];
  let offset = 0;
  while (offset < source.size) {
    while (stack.length > 0 && (stack.at(-1)?.[1] ?? 0) <= offset) {
      const [group] = stack.pop() ?? [0];
      groupEndRecord.set(group, types.length);
    }
    const limit = stack.at(-1)?.[1] ?? source.size;
    if (offset + RECORD_HEADER_SIZE > limit) {
      throw new FormatError('Header runs past its group or the file', offset);
    }
    const header = await reader.read(offset, RECORD_HEADER_SIZE);
    const view = new DataView(header.buffer, header.byteOffset, RECORD_HEADER_SIZE);
    const type = view.getUint32(0, true);
    const size = view.getUint32(4, true);
    const parent = (stack.at(-1)?.[0] ?? -1) + 1;

    if (type === GRUP) {
      if (size < GROUP_HEADER_SIZE || offset + size > limit) {
        throw new FormatError(`Group of ${size} bytes does not fit`, offset);
      }
      const group = groupOffsets.length;
      groupOffsets.push(offset);
      groupSizes.push(size);
      groupLabels.push(view.getUint32(8, true));
      groupTypes.push(view.getUint32(12, true));
      groupParents.push(parent);
      groupFirstRecord.push(types.length);
      groupEndRecord.push(types.length);
      stack.push([group, offset + size]);
      offset += GROUP_HEADER_SIZE;
    } else {
      const end = offset + RECORD_HEADER_SIZE + size;
      if (end > limit) throw new FormatError(`Record ${fourCCFromInt(type)} does not fit`, offset);
      types.push(type);
      dataSizes.push(size);
      flags.push(view.getUint32(8, true));
      formIds.push(view.getUint32(12, true));
      offsets.push(offset);
      parentGroups.push(parent);
      offset = end;
    }
  }
  for (const [group] of stack) groupEndRecord.set(group, types.length);

  const formIdArray = formIds.toArray();
  const order = Uint32Array.from({ length: formIdArray.length }, (_, i) => i).sort(
    (a, b) => (formIdArray[a] ?? 0) - (formIdArray[b] ?? 0),
  );
  return {
    fileSize: source.size,
    recordCount: types.length,
    types: types.toArray(),
    formIds: formIdArray,
    offsets: offsets.toArray(),
    dataSizes: dataSizes.toArray(),
    flags: flags.toArray(),
    parentGroups: parentGroups.toArray(),
    groupCount: groupOffsets.length,
    groupOffsets: groupOffsets.toArray(),
    groupSizes: groupSizes.toArray(),
    groupLabels: groupLabels.toArray(),
    groupTypes: groupTypes.toArray(),
    groupParents: groupParents.toArray(),
    groupFirstRecord: groupFirstRecord.toArray(),
    groupEndRecord: groupEndRecord.toArray(),
    sortedFormIds: Uint32Array.from(order, (i) => formIdArray[i] ?? 0),
    sortedRecords: order,
  };
}

/** Record index for a form id as stored in this plugin, or -1. */
export function findRecord(index: PluginIndex, formId: number): number {
  const ids = index.sortedFormIds;
  let low = 0;
  let high = ids.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const value = ids[mid] ?? 0;
    if (value < formId) low = mid + 1;
    else if (value > formId) high = mid - 1;
    else return index.sortedRecords[mid] ?? -1;
  }
  return -1;
}

export interface LoadedRecord {
  readonly header: RecordHeader;
  /** Decompressed field data. */
  readonly data: Uint8Array;
}

/** Reads and (if needed) decompresses one record. */
export async function readRecord(
  source: ByteSource,
  index: PluginIndex,
  record: number,
): Promise<LoadedRecord> {
  const offset = index.offsets[record];
  const size = index.dataSizes[record];
  if (offset === undefined || size === undefined) {
    throw new RangeError(`Record ${record} out of range`);
  }
  const bytes = await source.read(offset, RECORD_HEADER_SIZE + size);
  const header = parseRecordHeader(bytes);
  return { header, data: recordData(header, bytes.subarray(RECORD_HEADER_SIZE)) };
}

/**
 * Visits every record in file order with its decompressed data, reading the file in large
 * chunks. With `types` (four-character codes as integers), only records of those types are
 * read, and with `accept` only those it accepts (by their index entry). For tools,
 * verification passes and indexes over a few record types.
 */
export async function forEachRecord(
  source: ByteSource,
  index: PluginIndex,
  visit: (record: number, loaded: LoadedRecord) => void,
  types?: ReadonlySet<number>,
  chunkSize = DEFAULT_CHUNK,
  range: readonly [number, number] = [0, index.recordCount],
  accept?: (record: number) => boolean,
): Promise<void> {
  const reader = new ChunkReader(source, chunkSize);
  for (let record = range[0]; record < range[1]; record++) {
    if (types && !types.has(index.types[record] ?? 0)) continue;
    if (accept && !accept(record)) continue;
    const offset = index.offsets[record] ?? 0;
    const size = index.dataSizes[record] ?? 0;
    const bytes = await reader.read(offset, RECORD_HEADER_SIZE + size);
    const header = parseRecordHeader(bytes);
    visit(record, { header, data: recordData(header, bytes.subarray(RECORD_HEADER_SIZE)) });
  }
}
