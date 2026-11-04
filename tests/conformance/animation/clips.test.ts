// Conformance: clips (engine map: Animation and bodies > Clips): the clips' data the engine reads
// besides the clips themselves, the animation data of every behaviour project.
//
// Sources:
// - The data: meshes\animationdatasinglefile.txt (each project's behaviour files, clip
//   generators and their root motion), animationsetdatasinglefile.txt and the projects' speed
//   data (.spd) (docs/formats/hkx.md, "Animation data").

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnimationDataLibrary } from '../../../src/animation/animation-data-library.ts';
import { readAnimationContainer } from '../../../src/formats/hkx/animation.ts';
import { parseBehaviorGraph } from '../../../src/formats/hkx/behavior.ts';
import { Packfile } from '../../../src/formats/hkx/packfile.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

describe.skipIf(!hasGamedata())('the animation data of the load order (data)', () => {
  let sim: Sim;
  let library: AnimationDataLibrary;

  beforeAll(async () => {
    sim = await openSim();
    library = await sim.world.session.animation.animationData();
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('419 projects, every one read', () => {
    expect(library.projects).toHaveLength(419);
    expect(library.failures).toHaveLength(0);
  });

  it('the people’s project (DefaultMale) lists its behaviours, 0_Master first, with clip data', () => {
    const project = library.project('defaultmale');
    expect(project?.data?.files[0]).toBe('Behaviors\\0_Master.hkx');
    expect(project?.data?.hasClipData).toBe(true);
  });

  it('the people’s speed data (DefaultMale.spd) has its tables', () => {
    const speed = library.project('defaultmale')?.speedData;
    expect(speed?.tables.length).toBeGreaterThan(0);
  });
});

describe('clips (todo)', () => {
  it.todo(
    'the clips’ triggers and annotations raise at their times, ping-pong and looping  [Havok]',
  );
});

describe.skipIf(!hasGamedata())('every vanilla graph (a data sweep)', () => {
  const others = new Set<string>();
  const missing = new Set<string>();
  const mirrored = new Set<string>();
  let graphs = 0;
  let clips = 0;

  beforeAll(async () => {
    const vfs = await Vfs.mount(openGameFolder());
    for (const file of vfs.list('meshes').filter((name) => /\\behaviors?\\.*\.hkx$/.test(name))) {
      const pack = Packfile.parse(await vfs.read(file));
      if (pack.objectsOf('hkbBehaviorGraph').length === 0) continue;
      graphs++;
      // A clip's name is relative to its project's folder, the one its behaviors folder is in.
      const project = file.replace(/\\behaviors?\\.*$/, '');
      const seen = new Set<unknown>();
      const walk = (node: unknown): void => {
        if (typeof node !== 'object' || node === null || seen.has(node)) return;
        seen.add(node);
        const record = node as Record<string, unknown>;
        if (record.kind === 'other') others.add(String(record.className));
        if (record.kind === 'clip' && typeof record.animation === 'string') {
          clips++;
          const parts: string[] = [];
          for (const part of `${project}\\${record.animation}`.toLowerCase().split('\\')) {
            if (part === '..') parts.pop();
            else if (part !== '.') parts.push(part);
          }
          const path = parts.join('\\');
          if (!vfs.has(path)) missing.add(path);
          else if (((record.flags as number | undefined) ?? 0) & 0x4) mirrored.add(path);
        }
        for (const value of Object.values(record)) {
          if (Array.isArray(value)) value.forEach(walk);
          else if (typeof value === 'object') walk(value);
        }
      };
      walk(parseBehaviorGraph(pack).root);
    }
    for (const path of mirrored) {
      const binding = readAnimationContainer(Packfile.parse(await vfs.read(path))).bindings[0];
      if (binding?.additive !== true) mirrored.delete(path);
    }
  }, 600_000);

  it('runs: no node of any of them falls to the parser’s catch-all', () => {
    expect(graphs).toBeGreaterThan(300);
    expect([...others]).toEqual([]);
  });
  it('every clip a graph names is in the archives, but for 17', () => {
    expect(clips).toBeGreaterThan(9000);
    // The data's own gaps: five human and werewolf killmoves (each in first and third person), two
    // walks of no quest (dlc01trailerwalkforward, idlevalericawalkforward), the boar riekling's
    // five attacks. A graph that reaches one holds its pose (the runtime's update).
    expect(missing.size).toBe(17);
    expect([...missing].filter((path) => /jump|land|fall|sprint/.test(path))).toEqual([]);
  });
  // Our mirroring of an additive clip is our own rule (docs/animation.md, "Mirrored clips"). The
  // engine's would differ from it only on such a clip, and no vanilla graph plays one mirrored.
  it('no mirrored clip of a vanilla graph is additive', () => {
    expect([...mirrored]).toEqual([]);
  });
});
