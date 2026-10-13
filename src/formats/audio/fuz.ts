// FUZ voice files ("FUZE"): the lip-sync data and the spoken line in one file: u32 version
// (1), u32 size of the lip data, the lip data (a .lip file; 0 bytes for lines without
// lip-sync, like shouts), then the audio, an xWMA file (mono or stereo, 44100 Hz).
// Notes: docs/formats/audio.md.

import { FormatError } from '../binary-reader.ts';

export interface FuzFile {
  readonly version: number;
  /** The .lip data (empty without lip-sync; src/formats/audio/lip.ts). */
  readonly lip: Uint8Array;
  /** The audio (RIFF "XWMA"). */
  readonly audio: Uint8Array;
}

const HEADER = 12;

export function parseFuz(bytes: Uint8Array): FuzFile {
  if (bytes.byteLength < HEADER || String.fromCharCode(...bytes.subarray(0, 4)) !== 'FUZE') {
    throw new FormatError('Not a FUZ file', 0);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  const lipSize = view.getUint32(8, true);
  if (HEADER + lipSize > bytes.byteLength) {
    throw new FormatError(`FUZ lip data of ${String(lipSize)} bytes runs past the end`, 8);
  }
  return {
    version,
    lip: bytes.subarray(HEADER, HEADER + lipSize),
    audio: bytes.subarray(HEADER + lipSize),
  };
}
