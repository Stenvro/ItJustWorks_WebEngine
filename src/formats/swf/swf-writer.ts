// Writes small SWF movies: the engine's own (the menus' font library, the host movie each
// menu runs in). Uncompressed (FWS), an empty stage unless given one, tags as given.
// Notes: docs/formats/swf.md.

import { encodeUtf8 } from '../text.ts';

export interface SwfTagData {
  readonly code: number;
  readonly body: Uint8Array;
}

export interface SwfWriteOptions {
  readonly version?: number;
  /** Stage size in pixels. */
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  readonly frameCount?: number;
}

/** A tag with its header: short for bodies under 63 bytes, long otherwise. */
export function encodeTag(code: number, body: Uint8Array): Uint8Array {
  const long = body.length >= 0x3f;
  const out = new Uint8Array((long ? 6 : 2) + body.length);
  const view = new DataView(out.buffer);
  view.setUint16(0, (code << 6) | (long ? 0x3f : body.length), true);
  if (long) view.setUint32(2, body.length, true);
  out.set(body, long ? 6 : 2);
  return out;
}

/** A RECT of 0..width × 0..height pixels (twips, fields of the bits the largest needs). */
export function encodeRect(width: number, height: number): Uint8Array {
  const xMax = Math.round(width * 20);
  const yMax = Math.round(height * 20);
  const largest = Math.max(xMax, yMax);
  // Signed fields: one bit more than the magnitude needs.
  const size = largest === 0 ? 0 : Math.floor(Math.log2(largest)) + 2;
  const bits: number[] = [];
  const push = (value: number, count: number): void => {
    for (let i = count - 1; i >= 0; i--) bits.push(Math.floor(value / 2 ** i) % 2);
  };
  push(size, 5);
  push(0, size);
  push(xMax, size);
  push(0, size);
  push(yMax, size);
  while (bits.length % 8 !== 0) bits.push(0);
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) {
    out[i] = bits.slice(i * 8, i * 8 + 8).reduce((byte, bit) => byte * 2 + bit, 0);
  }
  return out;
}

/** A movie of the given tags (an End tag is added when missing). */
export function writeSwf(tags: readonly SwfTagData[], options: SwfWriteOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [
    encodeRect(options.width ?? 0, options.height ?? 0),
    Uint8Array.of(0, options.frameRate ?? 30),
    Uint8Array.of((options.frameCount ?? 1) & 0xff, (options.frameCount ?? 1) >> 8),
    ...tags.map((tag) => encodeTag(tag.code, tag.body)),
  ];
  if (tags[tags.length - 1]?.code !== 0) parts.push(encodeTag(0, new Uint8Array(0)));
  const length = 8 + parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  out.set([0x46, 0x57, 0x53, options.version ?? 15], 0);
  new DataView(out.buffer).setUint32(4, length, true);
  let at = 8;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A null-terminated UTF-8 string. */
export function encodeSwfString(text: string): Uint8Array {
  const bytes = encodeUtf8(text);
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes);
  return out;
}

/** Joins byte arrays. */
export function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A u16, little-endian. */
export function u16Bytes(value: number): Uint8Array {
  return Uint8Array.of(value & 0xff, (value >> 8) & 0xff);
}
