// Builds small RIFF files (WAV, xWMA) and FUZ files for unit tests.

export function riff(form: string, chunks: readonly (readonly [string, Uint8Array])[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [id, data] of chunks) {
    const header = new Uint8Array(8);
    header.set(ascii(id));
    new DataView(header.buffer).setUint32(4, data.byteLength, true);
    parts.push(header, data);
    if (data.byteLength % 2 === 1) parts.push(new Uint8Array(1));
  }
  const body = concat(parts);
  const out = new Uint8Array(12 + body.byteLength);
  out.set(ascii('RIFF'));
  new DataView(out.buffer).setUint32(4, 4 + body.byteLength, true);
  out.set(ascii(form), 8);
  out.set(body, 12);
  return out;
}

/** A "fmt " chunk (WAVEFORMATEX without extension). */
export function waveFormat(
  tag: number,
  channels: number,
  sampleRate: number,
  bitsPerSample: number,
  blockAlign = (channels * bitsPerSample) / 8,
): Uint8Array {
  const data = new Uint8Array(18);
  const view = new DataView(data.buffer);
  view.setUint16(0, tag, true);
  view.setUint16(2, channels, true);
  view.setUint32(4, sampleRate, true);
  view.setUint32(8, sampleRate * blockAlign, true);
  view.setUint16(12, blockAlign, true);
  view.setUint16(14, bitsPerSample, true);
  return data;
}

/** A sampler chunk with one loop (start and end frames, end inclusive). */
export function samplerLoop(start: number, end: number): Uint8Array {
  const data = new Uint8Array(36 + 24);
  const view = new DataView(data.buffer);
  view.setUint32(28, 1, true);
  view.setUint32(36 + 8, start, true);
  view.setUint32(36 + 12, end, true);
  return data;
}

export function int16s(values: readonly number[]): Uint8Array {
  const data = new Uint8Array(values.length * 2);
  const view = new DataView(data.buffer);
  values.forEach((value, i) => {
    view.setInt16(i * 2, value, true);
  });
  return data;
}

export function uint32s(values: readonly number[]): Uint8Array {
  const data = new Uint8Array(values.length * 4);
  const view = new DataView(data.buffer);
  values.forEach((value, i) => {
    view.setUint32(i * 4, value, true);
  });
  return data;
}

export function fuz(lip: Uint8Array, audio: Uint8Array, version = 1): Uint8Array {
  const out = new Uint8Array(12 + lip.byteLength + audio.byteLength);
  const view = new DataView(out.buffer);
  out.set(ascii('FUZE'));
  view.setUint32(4, version, true);
  view.setUint32(8, lip.byteLength, true);
  out.set(lip, 12);
  out.set(audio, 12 + lip.byteLength);
  return out;
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
