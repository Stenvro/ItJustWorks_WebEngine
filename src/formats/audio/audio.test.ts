import { describe, expect, it } from 'vitest';
import {
  fuz,
  int16s,
  riff,
  samplerLoop,
  uint32s,
  waveFormat,
} from '../../../tests/helpers/riff-builder.ts';
import { FormatError } from '../binary-reader.ts';
import { parseFuz } from './fuz.ts';
import { parseRiff } from './riff.ts';
import { decodeWav, parseWav } from './wav.ts';
import { parseXwma, riffForm } from './xwma.ts';

describe('RIFF', () => {
  it('splits a file into its chunks, skipping the padding of odd sizes', () => {
    const file = parseRiff(
      riff('WAVE', [
        ['LIST', Uint8Array.of(1, 2, 3)],
        ['data', Uint8Array.of(9, 9)],
      ]),
    );
    expect(file.form).toBe('WAVE');
    expect(file.chunks.map((c) => [c.id, c.data.byteLength])).toEqual([
      ['LIST', 3],
      ['data', 2],
    ]);
    expect(() => parseRiff(Uint8Array.of(1, 2, 3))).toThrow(FormatError);
  });
});

describe('WAV', () => {
  it('decodes 16-bit PCM per channel and reads the sampler loop', () => {
    const wav = parseWav(
      riff('WAVE', [
        ['fmt ', waveFormat(1, 2, 32000, 16)],
        ['data', int16s([16384, -16384, 32767, -32768, 0, 8192])],
        ['smpl', samplerLoop(1, 2)],
      ]),
    );
    expect(wav.frames).toBe(3);
    expect(wav.loop).toEqual({ start: 1, end: 3 });
    const pcm = decodeWav(wav);
    expect(pcm.sampleRate).toBe(32000);
    expect(Array.from(pcm.channels[0] ?? [])).toEqual([0.5, 32767 / 32768, 0]);
    expect(Array.from(pcm.channels[1] ?? [])).toEqual([-0.5, -1, 0.25]);
  });

  it('decodes 8-bit and float samples, and rejects compressed ones', () => {
    const eight = decodeWav(
      parseWav(
        riff('WAVE', [
          ['fmt ', waveFormat(1, 1, 11025, 8)],
          ['data', Uint8Array.of(128, 192, 64)],
        ]),
      ),
    );
    expect(Array.from(eight.channels[0] ?? [])).toEqual([0, 0.5, -0.5]);
    const floats = new Uint8Array(8);
    new DataView(floats.buffer).setFloat32(0, 0.25, true);
    new DataView(floats.buffer).setFloat32(4, -1, true);
    const float = decodeWav(
      parseWav(
        riff('WAVE', [
          ['fmt ', waveFormat(3, 1, 48000, 32)],
          ['data', floats],
        ]),
      ),
    );
    expect(Array.from(float.channels[0] ?? [])).toEqual([0.25, -1]);
    const adpcm = parseWav(
      riff('WAVE', [
        ['fmt ', waveFormat(2, 1, 22050, 4, 256)],
        ['data', new Uint8Array(256)],
      ]),
    );
    expect(() => decodeWav(adpcm)).toThrow(/Unsupported/);
  });
});

describe('xWMA and FUZ', () => {
  const xwma = riff('XWMA', [
    ['fmt ', waveFormat(0x161, 2, 44100, 16, 2230)],
    ['dpds', uint32s([4096, 8192, 10000])],
    ['data', new Uint8Array(2230 * 3)],
  ]);

  it('reads the format and the decoded length from the packet table', () => {
    const file = parseXwma(xwma);
    expect(file.format.tag).toBe(0x161);
    expect(file.packetEnds.length).toBe(3);
    // 10000 bytes of 16-bit stereo: 2500 frames.
    expect(file.frames).toBe(2500);
    expect(file.duration).toBeCloseTo(2500 / 44100);
    expect(riffForm(xwma)).toBe('XWMA');
    expect(() =>
      parseXwma(
        riff('XWMA', [
          ['fmt ', waveFormat(1, 1, 8000, 16)],
          ['dpds', uint32s([2])],
          ['data', new Uint8Array(2)],
        ]),
      ),
    ).toThrow(/format tag/);
  });

  it('splits a FUZ into lip-sync data and audio', () => {
    const lip = Uint8Array.of(1, 2, 3, 4, 5);
    const file = parseFuz(fuz(lip, xwma));
    expect(file.version).toBe(1);
    expect(Array.from(file.lip)).toEqual([1, 2, 3, 4, 5]);
    expect(riffForm(file.audio)).toBe('XWMA');
    expect(parseFuz(fuz(new Uint8Array(0), xwma)).lip.byteLength).toBe(0);
    const broken = fuz(lip, xwma);
    new DataView(broken.buffer).setUint32(8, 1_000_000, true);
    expect(() => parseFuz(broken)).toThrow(FormatError);
  });
});
