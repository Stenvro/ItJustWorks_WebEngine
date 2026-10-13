// Shows a sound file (WAV, xWMA, FUZ): its format, length and loop; or audits every sound of
// the game data.
//
//   node tools/audio-info.ts music\special\mus_maintheme.xwm
//   node tools/audio-info.ts <file> --decode      also decode it (xWMA with ffmpeg.wasm)
//   node tools/audio-info.ts --audit [folder]     every .wav, .xwm and .fuz under the folder

import { decodeXwma } from '../src/audio/xwma-decoder.ts';
import { parseFuz } from '../src/formats/audio/fuz.ts';
import { decodeWav, parseWav, type PcmAudio } from '../src/formats/audio/wav.ts';
import { parseXwma, riffForm } from '../src/formats/audio/xwma.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { loadFfmpegCore } from './ffmpeg-node.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());

/** The audio inside a file (a FUZ's xWMA, else the file itself). */
function audioOf(bytes: Uint8Array): { audio: Uint8Array; prefix: string } {
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== 'FUZE') return { audio: bytes, prefix: '' };
  const fuz = parseFuz(bytes);
  return {
    audio: fuz.audio,
    prefix: `FUZ v${String(fuz.version)} lip ${String(fuz.lip.byteLength)} B · `,
  };
}

/** One line about a sound file; throws for broken ones. */
function describe(bytes: Uint8Array): { key: string; line: string; seconds: number } {
  const { audio, prefix } = audioOf(bytes);
  const fuz = prefix ? 'FUZ ' : '';
  const form = riffForm(audio);
  if (form === 'XWMA') {
    const xwma = parseXwma(audio);
    const f = xwma.format;
    return {
      key: `${fuz}xWMA 0x${f.tag.toString(16)} ${String(f.channels)} ch ${String(f.sampleRate)} Hz`,
      line:
        `${prefix}xWMA 0x${f.tag.toString(16)} · ${String(f.channels)} ch · ` +
        `${String(f.sampleRate)} Hz · ${String(f.bytesPerSecond * 8)} bit/s · ` +
        `${String(xwma.packetEnds.length)} packets · ${xwma.duration.toFixed(2)} s`,
      seconds: xwma.duration,
    };
  }
  if (form === 'WAVE') {
    const wav = parseWav(audio);
    const f = wav.format;
    const seconds = wav.frames / f.sampleRate;
    const loop = wav.loop ? ` · loop ${String(wav.loop.start)}–${String(wav.loop.end)}` : '';
    return {
      key: `${fuz}WAV ${String(f.subFormat)} ${String(f.bitsPerSample)}-bit ${String(f.channels)} ch${wav.loop ? ' loop' : ''}`,
      line:
        `${prefix}WAV format ${String(f.subFormat)} · ${String(f.bitsPerSample)}-bit · ` +
        `${String(f.channels)} ch · ${String(f.sampleRate)} Hz · ${seconds.toFixed(2)} s${loop}`,
      seconds,
    };
  }
  throw new Error(`not a sound file (${form ?? 'no RIFF header'})`);
}

if (process.argv.includes('--audit')) {
  const folder = process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '';
  const paths = vfs.list(folder).filter((path) => /\.(wav|xwm|fuz)$/.test(path));
  const kinds = new Map<string, { count: number; seconds: number; example: string }>();
  const broken: string[] = [];
  for (const path of paths) {
    try {
      const { key, seconds } = describe(await vfs.read(path));
      const entry = kinds.get(key) ?? { count: 0, seconds: 0, example: path };
      entry.count++;
      entry.seconds += seconds;
      kinds.set(key, entry);
    } catch (error) {
      broken.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const [key, { count, seconds, example }] of [...kinds].sort(
    (a, b) => b[1].count - a[1].count,
  )) {
    const hours = (seconds / 3600).toFixed(1).padStart(6);
    console.log(`${String(count).padStart(6)}  ${key.padEnd(34)} ${hours} h  ${example}`);
  }
  console.log(`${String(paths.length)} sound files, ${String(broken.length)} broken`);
  for (const line of broken.slice(0, 20)) console.log(`  ! ${line}`);
} else {
  const path =
    process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? 'music/special/mus_maintheme.xwm';
  const bytes = await vfs.read(path);
  console.log(`${path}: ${describe(bytes).line}`);
  if (process.argv.includes('--decode')) {
    const { audio } = audioOf(bytes);
    const start = performance.now();
    const pcm: PcmAudio =
      riffForm(audio) === 'XWMA'
        ? decodeXwma(await loadFfmpegCore(), audio)
        : decodeWav(parseWav(audio));
    const levels = pcm.channels.map((channel) => {
      let peak = 0;
      let sum = 0;
      for (const value of channel) {
        peak = Math.max(peak, Math.abs(value));
        sum += value * value;
      }
      const rms = Math.sqrt(sum / Math.max(1, channel.length));
      return `peak ${peak.toFixed(3)} rms ${rms.toFixed(3)}`;
    });
    const frames = pcm.channels[0]?.length ?? 0;
    console.log(
      `decoded ${String(frames)} frames (${(frames / pcm.sampleRate).toFixed(2)} s) at ` +
        `${String(pcm.sampleRate)} Hz in ${(performance.now() - start).toFixed(0)} ms · ` +
        levels.join(' | '),
    );
  }
}
await vfs.close();
