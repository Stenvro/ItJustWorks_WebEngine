// The frame's CPU time in the headless simulation, by system (docs/qa.md, "Frame time in the
// simulation"): a scene stepped at 60 frames a second under the CPU profiler. Not a case: it
// runs only when asked, with the output folder named (outside the repository):
//
//   FRAME_PROFILE=<folder> [FRAME_PROFILE_SCENE=attack|whiterun] [FRAME_PROFILE_SECONDS=20]
//   [FRAME_PROFILE_TAG=run] [FRAME_PROFILE_HEAP=1] node simq.mjs ... tests/sim-frame-profile.int.test.ts
//
// `attack`: a new game played through its opening to Alduin's attack (MQ101 stage 160, ten
// seconds on), kept as <folder>/mq101-attack.save and loaded from there by later runs (their
// numbers compare with each other, not with a run played through); `whiterun`: the market at
// 9:00. It writes <folder>/<scene>-<tag>.cpuprofile and .json (the frame's wall and CPU
// milliseconds, percentiles); `node tools/cpu-profile-summary.ts <file> <frames>` sums the
// profile by system, file and function. FRAME_PROFILE_HEAP=1 also samples what the frames
// allocate (objects collected too), by function.

import fs from 'node:fs';
import path from 'node:path';
import { Session } from 'node:inspector/promises';
import { describe, it } from 'vitest';
import { hasGamedata, loadSim, openSim, type Sim } from './helpers/sim.ts';

const OUT = process.env.FRAME_PROFILE;
const SCENE = process.env.FRAME_PROFILE_SCENE ?? 'attack';
const SECONDS = Number(process.env.FRAME_PROFILE_SECONDS ?? 20);
const TAG = process.env.FRAME_PROFILE_TAG ?? 'run';
const HEAP = process.env.FRAME_PROFILE_HEAP === '1';
const MQ101 = 0x3372b;
/** WhiterunWorld. */
const WHITERUN = 0x1a26f;

interface HeapNode {
  readonly callFrame: { readonly functionName: string; readonly url: string };
  readonly selfSize: number;
  readonly children: readonly HeapNode[];
}

/** What the sampled frames allocated, by function and its caller (MB), the most first. */
function allocations(head: HeapNode): [string, number][] {
  const bySite = new Map<string, number>();
  const name = (node: HeapNode): string => {
    const { functionName, url } = node.callFrame;
    return `${functionName || '(anonymous)'} ${url.replace(/^.*[\\/](src|tests)[\\/]/, '$1/')}`;
  };
  const walk = (node: HeapNode, caller: string): void => {
    const here = name(node);
    const key = `${here} < ${caller}`;
    if (node.selfSize > 0) bySite.set(key, (bySite.get(key) ?? 0) + node.selfSize / 1e6);
    for (const child of node.children) walk(child, here);
  };
  walk(head, '');
  return [...bySite].sort((a, b) => b[1] - a[1]);
}

async function profile(sim: Sim, folder: string): Promise<void> {
  await sim.world.run(2);
  const session = new Session();
  session.connect();
  await session.post('Profiler.enable');
  await session.post('Profiler.setSamplingInterval', { interval: 200 });
  await session.post('Profiler.start');
  if (HEAP) {
    await session.post('HeapProfiler.startSampling', {
      samplingInterval: 16384,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const frames: number[] = [];
  const steps = Math.round(SECONDS * 60);
  const started = process.hrtime.bigint();
  const cpu = process.cpuUsage();
  for (let i = 0; i < steps; i++) {
    const at = process.hrtime.bigint();
    await sim.world.step(1 / 60);
    frames.push(Number(process.hrtime.bigint() - at) / 1e6);
  }
  const wall = Number(process.hrtime.bigint() - started) / 1e6;
  const used = process.cpuUsage(cpu);
  if (HEAP) {
    const { profile: sampled } = await session.post('HeapProfiler.stopSampling');
    const sites = allocations(sampled.head);
    const total = sites.reduce((sum, [, mb]) => sum + mb, 0);
    console.log(`allocated ${(total / steps).toFixed(2)} MB a frame`);
    for (const [site, mb] of sites.slice(0, 40))
      console.log(`${(mb / steps).toFixed(3)} MB  ${site}`);
  }
  const { profile: cpuProfile } = await session.post('Profiler.stop');
  session.disconnect();
  frames.sort((a, b) => a - b);
  const at = (p: number): number => frames[Math.floor((frames.length - 1) * p)] ?? 0;
  const summary = {
    scene: SCENE,
    tag: TAG,
    frames: steps,
    msPerFrame: wall / steps,
    cpuMsPerFrame: (used.user + used.system) / 1000 / steps,
    p50: at(0.5),
    p95: at(0.95),
    max: at(1),
    actors: sim.actors().length,
  };
  console.log(JSON.stringify(summary));
  fs.writeFileSync(path.join(folder, `${SCENE}-${TAG}.json`), JSON.stringify(summary));
  fs.writeFileSync(path.join(folder, `${SCENE}-${TAG}.cpuprofile`), JSON.stringify(cpuProfile));
}

describe.skipIf(!hasGamedata() || OUT === undefined)('the frame profile (only when asked)', () => {
  it('profiles a scene', { timeout: 3_600_000 }, async () => {
    const folder = OUT ?? '';
    if (SCENE === 'whiterun') {
      const sim = await openSim({ exterior: { world: WHITERUN, cell: [4, -2] }, hour: 9 });
      await sim.world.run(5);
      await profile(sim, folder);
      await sim.close();
      return;
    }
    const saved = path.join(folder, 'mq101-attack.save');
    let sim: Sim;
    if (fs.existsSync(saved)) {
      sim = await loadSim(fs.readFileSync(saved));
      await sim.world.run(3);
    } else {
      sim = await openSim({ opening: true });
      await sim.openAtPlayer();
      await sim.until(() => sim.stageDone(MQ101, 160), 900);
      await sim.world.run(10);
      fs.writeFileSync(saved, await sim.save());
    }
    await profile(sim, folder);
    await sim.close();
  });
});
