import { describe, expect, it } from 'vitest';
import { LIP_RATE, lipDuration, parseLip, sampleLip } from './lip.ts';

/** Compresses like the Creation Kit: zero bytes as runs (0, u16 count), others as they are. */
function compress(block: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < block.length;) {
    if (block[i] === 0) {
      let run = 0;
      while (i + run < block.length && block[i + run] === 0 && run < 0xffff) run++;
      out.push(0, run & 0xff, run >> 8);
      i += run;
    } else {
      out.push(block[i] ?? 0);
      i++;
    }
  }
  return out;
}

/** A .lip file of `frames` frames of `curves` curves (values by frame and curve). */
function lip(frames: number, first: number, phonemes: number, values: number[]): Uint8Array {
  const block = new DataView(new ArrayBuffer(12 + values.length * 4));
  block.setInt32(0, frames, true);
  block.setInt32(4, first, true);
  block.setInt32(8, phonemes, true);
  values.forEach((value, i) => {
    block.setFloat32(12 + i * 4, value, true);
  });
  const body = compress(new Uint8Array(block.buffer));
  const header = new DataView(new ArrayBuffer(12));
  header.setUint32(0, 1, true);
  header.setUint32(4, block.byteLength + 16, true);
  header.setUint32(8, 13, true);
  return Uint8Array.from([...new Uint8Array(header.buffer), ...body]);
}

describe('lip files', () => {
  it('expands the block and reads its frames', () => {
    const values = new Array<number>(3 * 33).fill(0);
    values[0] = 0.5; // frame 0: Aah
    values[33 + 2] = 1; // frame 1: BMP
    values[66 + 16] = 0.25; // frame 2: BlinkLeft
    const file = parseLip(lip(3, -1, 16, values));
    expect(file).toMatchObject({ frames: 3, first: -1, phonemes: 16, curves: 33 });
    expect(file.values[35]).toBe(1);
    expect(file.values[82]).toBe(0.25);
    expect(lipDuration(file)).toBeCloseTo(2 / LIP_RATE);
  });

  it('interpolates between frames, the audio starting at frame -first', () => {
    const values = new Array<number>(2 * 8).fill(0);
    values[0] = 0;
    values[8] = 1;
    const file = parseLip(lip(2, -1, 8, values));
    const out = new Float32Array(8);
    // Audio time 0 is frame 1; half a frame before it is halfway between frames 0 and 1.
    sampleLip(file, -0.5 / LIP_RATE, out);
    expect(out[0]).toBeCloseTo(0.5);
    sampleLip(file, 0, out);
    expect(out[0]).toBeCloseTo(1);
    sampleLip(file, 1, out);
    expect(out[0]).toBe(0);
  });

  it('rejects blocks that do not hold what the header says', () => {
    const data = lip(2, 0, 16, new Array<number>(2 * 33).fill(0.5));
    new DataView(data.buffer).setUint32(4, 99, true);
    expect(() => parseLip(data)).toThrow(/LIP block/);
  });
});
