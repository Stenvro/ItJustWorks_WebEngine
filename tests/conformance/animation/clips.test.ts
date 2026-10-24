// Conformance: clips (engine map: Animation and bodies > Clips): the clips' data the engine reads
// besides the clips themselves, the animation data of every behaviour project.
//
// Sources:
// - The data: meshes\animationdatasinglefile.txt (each project's behaviour files, clip
//   generators and their root motion), animationsetdatasinglefile.txt and the projects' speed
//   data (.spd) (docs/formats/hkx.md, "Animation data").

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AnimationDataLibrary } from '../../../src/animation/animation-data-library.ts';
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
  it.todo('a mirrored additive clip by the engine’s rule (ours: our own)  [original]');
  it.todo('every clip a vanilla graph names is in the archives (a sweep)  [data]');
  it.todo(
    'the clips’ triggers and annotations raise at their times, ping-pong and looping  [Havok]',
  );
});
