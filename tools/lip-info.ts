// Reads lip-sync data (.lip files, and the lip part of .fuz voice files): one line in detail
// (its active curves frame by frame), or every one of the load order, checked against its
// audio (the curves must end with the spoken line).
//
//   node tools/lip-info.ts sound\voice\skyrim.esm\femaleeventoned\<line>.fuz
//   node tools/lip-info.ts --all

import { parseFuz } from '../src/formats/audio/fuz.ts';
import {
  LIP_MODIFIERS,
  LIP_PHONEMES,
  LIP_RATE,
  lipDuration,
  parseLip,
  type LipFile,
} from '../src/formats/audio/lip.ts';
import { parseXwma } from '../src/formats/audio/xwma.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const vfs = await Vfs.mount(openGameFolder());

const CURVES = [...LIP_PHONEMES, ...LIP_MODIFIERS, 'HeadPitch', 'HeadRoll', 'HeadYaw'];

/** The lip data and audio duration of a voice file (undefined: none). */
async function readLine(
  path: string,
): Promise<{ lip: Uint8Array; audio: number | undefined } | undefined> {
  const bytes = await vfs.read(path);
  if (path.endsWith('.fuz')) {
    const fuz = parseFuz(bytes);
    return fuz.lip.byteLength > 0
      ? { lip: fuz.lip, audio: parseXwma(fuz.audio).duration }
      : undefined;
  }
  return { lip: bytes, audio: undefined };
}

/** The last frame any phoneme is above 0.05 (−1: none). */
function lastSpoken(lip: LipFile): number {
  for (let frame = lip.frames - 1; frame >= 0; frame--) {
    for (let c = 0; c < lip.phonemes; c++) {
      if ((lip.values[frame * lip.curves + c] ?? 0) > 0.05) return frame;
    }
  }
  return -1;
}

if (args.includes('--all')) {
  let lines = 0;
  const curves = new Map<number, number>();
  const failures: string[] = [];
  const offsets: number[] = [];
  for (const path of vfs.list('sound\\voice')) {
    if (!path.endsWith('.fuz') && !path.endsWith('.lip')) continue;
    try {
      const line = await readLine(path);
      if (!line) continue;
      lines++;
      const lip = parseLip(line.lip);
      curves.set(lip.curves, (curves.get(lip.curves) ?? 0) + 1);
      const spoken = lastSpoken(lip);
      if (line.audio !== undefined && spoken >= 0 && lip.curves === 33) {
        offsets.push((spoken + lip.first) / LIP_RATE - line.audio);
      }
    } catch (error) {
      failures.push(`${path}: ${String(error)}`);
    }
  }
  offsets.sort((a, b) => a - b);
  const at = (p: number): string => (offsets[Math.floor(p * (offsets.length - 1))] ?? 0).toFixed(2);
  console.log(`${String(lines)} lines with lip data, ${String(failures.length)} failed`);
  console.log(
    `curves per frame: ${[...curves].map(([n, c]) => `${String(n)} × ${String(c)}`).join(', ')}`,
  );
  console.log(
    `last phoneme minus audio end (s): min ${at(0)}, 10% ${at(0.1)}, median ${at(0.5)}, ` +
      `90% ${at(0.9)}, max ${at(1)}`,
  );
  for (const failure of failures.slice(0, 20)) console.log(`  ${failure}`);
} else {
  const path = args[0] ?? '';
  const line = await readLine(path);
  if (!line) {
    console.log(`${path}: no lip data`);
  } else {
    const lip = parseLip(line.lip);
    console.log(
      `${path}: ${String(lip.frames)} frames from frame ${String(lip.first)}, ` +
        `${String(lip.curves)} curves (${String(lip.phonemes)} phonemes), ` +
        `${lipDuration(lip).toFixed(2)} s` +
        (line.audio === undefined ? '' : `, audio ${line.audio.toFixed(2)} s`),
    );
    for (let frame = 0; frame < lip.frames; frame++) {
      const active: string[] = [];
      for (let c = 0; c < lip.curves; c++) {
        const value = lip.values[frame * lip.curves + c] ?? 0;
        const name = lip.curves === CURVES.length ? CURVES[c] : `curve${String(c)}`;
        if (Math.abs(value) > 0.05) active.push(`${name ?? ''} ${value.toFixed(2)}`);
      }
      const time = (frame + lip.first) / LIP_RATE;
      console.log(`  ${time.toFixed(2).padStart(6)} s  ${active.join(', ')}`);
    }
  }
}
await vfs.close();
