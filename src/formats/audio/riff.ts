// RIFF containers (Microsoft's chunked format): "RIFF", the size of what follows, a form type
// ("WAVE" for sound effects, "XWMA" for music and voice), then chunks of a four-character id,
// a u32 size and the data, padded to an even size. Notes: docs/formats/audio.md.

import { FormatError } from '../binary-reader.ts';

export interface RiffChunk {
  readonly id: string;
  /** The chunk's data (a view on the file, no copy). */
  readonly data: Uint8Array;
  /** Offset of the data in the file. */
  readonly offset: number;
}

export interface RiffFile {
  /** Form type: "WAVE", "XWMA". */
  readonly form: string;
  readonly chunks: readonly RiffChunk[];
}

const HEADER = 12;
const CHUNK_HEADER = 8;

function fourCC(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset] ?? 0,
    bytes[offset + 1] ?? 0,
    bytes[offset + 2] ?? 0,
    bytes[offset + 3] ?? 0,
  );
}

/** Splits a RIFF file into its chunks; a chunk running past the end is cut at the end. */
export function parseRiff(bytes: Uint8Array): RiffFile {
  if (bytes.byteLength < HEADER || fourCC(bytes, 0) !== 'RIFF') {
    throw new FormatError('Not a RIFF file', 0);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const form = fourCC(bytes, 8);
  // Some files state a RIFF size past their end; the chunks decide.
  const end = Math.min(bytes.byteLength, CHUNK_HEADER + view.getUint32(4, true));
  const chunks: RiffChunk[] = [];
  let offset = HEADER;
  while (offset + CHUNK_HEADER <= end) {
    const id = fourCC(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + CHUNK_HEADER;
    const stop = Math.min(end, start + size);
    chunks.push({ id, data: bytes.subarray(start, stop), offset: start });
    offset = start + size + (size & 1);
  }
  return { form, chunks };
}

/** The first chunk with an id, or undefined. */
export function chunk(file: RiffFile, id: string): RiffChunk | undefined {
  return file.chunks.find((candidate) => candidate.id === id);
}

/** A chunk that must be there. */
export function requireChunk(file: RiffFile, id: string): RiffChunk {
  const found = chunk(file, id);
  if (!found) throw new FormatError(`RIFF ${file.form} without a "${id}" chunk`, 0);
  return found;
}

/** WAVEFORMATEX: the format of the samples in a "fmt " chunk. */
export interface WaveFormat {
  /** wFormatTag: 1 PCM, 3 IEEE float, 0x161 WMA v2, 0x162 WMA Pro, 0xFFFE extensible. */
  readonly tag: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly bytesPerSecond: number;
  readonly blockAlign: number;
  readonly bitsPerSample: number;
  /** WAVE_FORMAT_EXTENSIBLE: the actual format (1 PCM, 3 float), else the tag. */
  readonly subFormat: number;
}

export const WAVE_FORMAT = {
  pcm: 0x1,
  float: 0x3,
  wmaV2: 0x161,
  wmaPro: 0x162,
  extensible: 0xfffe,
} as const;

export function parseWaveFormat(fmt: RiffChunk): WaveFormat {
  if (fmt.data.byteLength < 16) throw new FormatError('"fmt " chunk too short', fmt.offset);
  const view = new DataView(fmt.data.buffer, fmt.data.byteOffset, fmt.data.byteLength);
  const tag = view.getUint16(0, true);
  // WAVEFORMATEXTENSIBLE: cbSize 22, then valid bits, channel mask and the sub-format GUID,
  // whose first two bytes are the format tag.
  const subFormat =
    tag === WAVE_FORMAT.extensible && fmt.data.byteLength >= 26 ? view.getUint16(24, true) : tag;
  return {
    tag,
    channels: view.getUint16(2, true),
    sampleRate: view.getUint32(4, true),
    bytesPerSecond: view.getUint32(8, true),
    blockAlign: view.getUint16(12, true),
    bitsPerSample: view.getUint16(14, true),
    subFormat,
  };
}
