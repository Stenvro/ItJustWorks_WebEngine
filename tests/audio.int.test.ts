// Integration test: sound files of the local game data, parsed and decoded (xWMA with
// ffmpeg.wasm). Skipped without game data. Full coverage: `node tools/audio-info.ts --audit`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeXwma, decodeXwmaToWav, STREAM_HEADROOM } from '../src/audio/xwma-decoder.ts';
import { parseFuz } from '../src/formats/audio/fuz.ts';
import { decodeWav, parseWav } from '../src/formats/audio/wav.ts';
import { parseXwma } from '../src/formats/audio/xwma.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { loadFfmpegCore } from '../tools/ffmpeg-node.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const peak = (channel: Float32Array | undefined): number => {
  let max = 0;
  for (const value of channel ?? []) max = Math.max(max, Math.abs(value));
  return max;
};

describe.skipIf(!hasGamedata())('sound files in the local game data', () => {
  let vfs: Vfs;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  it('decodes a looping sound effect with its loop', async () => {
    const wav = parseWav(
      await vfs.read('sound\\fx\\amb\\dungeon\\dwemer\\amb_dungeon_dwemer_flame_01_lp.wav'),
    );
    expect(wav.format.channels).toBe(1);
    expect(wav.format.sampleRate).toBe(32000);
    expect(wav.loop).toEqual({ start: 0, end: wav.frames });
    const pcm = decodeWav(wav);
    expect(pcm.channels[0]?.length).toBe(wav.frames);
    expect(peak(pcm.channels[0])).toBeGreaterThan(0.05);
  });

  it('decodes the main theme and a voice line with ffmpeg.wasm', async () => {
    const core = await loadFfmpegCore();
    const theme = await vfs.read('music\\special\\mus_maintheme.xwm');
    const header = parseXwma(theme);
    expect(header.format.sampleRate).toBe(48000);
    expect(header.duration).toBeCloseTo(235.65, 1);
    const music = decodeXwma(core, theme);
    expect(music.channels).toHaveLength(2);
    expect(music.channels[0]?.length).toBe(header.frames);
    expect(peak(music.channels[1])).toBeGreaterThan(0.5);
    // Streamed music: the same samples as a 16-bit WAV file, with headroom (no clipping).
    const wav = parseWav(decodeXwmaToWav(core, theme));
    expect(wav.format.bitsPerSample).toBe(16);
    expect(wav.format.sampleRate).toBe(48000);
    expect(wav.frames).toBe(header.frames);
    const streamed = decodeWav(wav);
    expect(peak(streamed.channels[1]) * STREAM_HEADROOM).toBeCloseTo(peak(music.channels[1]), 3);

    const voice = parseFuz(
      await vfs.read(
        'sound\\voice\\dawnguard.esm\\crdragonvoice\\dlc1vqdrag_dlc1vqdragonint_0001156b_1.fuz',
      ),
    );
    expect(voice.lip.byteLength).toBeGreaterThan(0);
    const line = decodeXwma(core, voice.audio);
    expect(line.sampleRate).toBe(44100);
    expect(line.channels).toHaveLength(1);
    expect(peak(line.channels[0])).toBeGreaterThan(0.05);
  }, 60_000);
});
