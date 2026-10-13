// xWMA (RIFF "XWMA"): Windows Media Audio packets as XAudio2 plays them, used for music
// (.xwm) and inside voice files (.fuz). The "fmt " chunk is a WAVEFORMATEX with format tag
// 0x161 (WMA v2; vanilla) or 0x162 (WMA Pro); "dpds" lists, per packet of blockAlign bytes,
// the number of decoded bytes (16-bit output) up to its end; "data" holds the packets. The
// samples are decoded by ffmpeg (src/audio/xwma-decoder.ts). Notes: docs/formats/audio.md.

import { FormatError } from '../binary-reader.ts';
import { parseRiff, parseWaveFormat, requireChunk, WAVE_FORMAT, type WaveFormat } from './riff.ts';

export interface XwmaFile {
  readonly format: WaveFormat;
  /** Cumulative decoded bytes at the end of each packet. */
  readonly packetEnds: Uint32Array;
  readonly data: Uint8Array;
  /** Sample frames once decoded (from the last packet's cumulative count). */
  readonly frames: number;
  readonly duration: number;
}

export function parseXwma(bytes: Uint8Array): XwmaFile {
  const riff = parseRiff(bytes);
  if (riff.form !== 'XWMA') throw new FormatError(`RIFF ${riff.form} is not an xWMA file`, 8);
  const format = parseWaveFormat(requireChunk(riff, 'fmt '));
  if (format.tag !== WAVE_FORMAT.wmaV2 && format.tag !== WAVE_FORMAT.wmaPro) {
    throw new FormatError(`xWMA with format tag 0x${format.tag.toString(16)}`, 0);
  }
  const dpds = requireChunk(riff, 'dpds').data;
  const packetEnds = new Uint32Array(Math.floor(dpds.byteLength / 4));
  const view = new DataView(dpds.buffer, dpds.byteOffset, dpds.byteLength);
  for (let i = 0; i < packetEnds.length; i++) packetEnds[i] = view.getUint32(i * 4, true);
  const decodedBytes = packetEnds.length > 0 ? (packetEnds[packetEnds.length - 1] ?? 0) : 0;
  const frames = Math.floor(decodedBytes / (2 * Math.max(1, format.channels)));
  return {
    format,
    packetEnds,
    data: requireChunk(riff, 'data').data,
    frames,
    duration: format.sampleRate > 0 ? frames / format.sampleRate : 0,
  };
}

/** The RIFF form type of a sound file ("WAVE", "XWMA"), whatever its extension. */
export function riffForm(bytes: Uint8Array): string | undefined {
  if (bytes.byteLength < 12) return undefined;
  const text = String.fromCharCode(...bytes.subarray(0, 4));
  return text === 'RIFF' ? String.fromCharCode(...bytes.subarray(8, 12)) : undefined;
}
