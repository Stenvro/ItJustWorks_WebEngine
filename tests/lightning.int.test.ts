// Integration test: procedural lightning (BSProceduralLightningController) built from the
// vanilla beam models and run as their behavior graph plays them. Skipped without game data.
// More: `node tools/particle-info.ts meshes/magic/lightningbolt01.nif`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseNif } from '../src/formats/nif/nif.ts';
import { LightningSimulation } from '../src/render/lightning.ts';
import { identity } from '../src/render/math.ts';
import { buildModel } from '../src/render/model-data.ts';
import { PARTICLE_FLOATS } from '../src/render/particle-sim.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('procedural lightning in the local game data', () => {
  let vfs: Vfs;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  it('builds the beam bolts of Sparks and Lightning Bolt from their controllers', async () => {
    for (const path of [
      'meshes\\magic\\lightningbolt01.nif',
      'meshes\\magic\\lightningbolt02.nif',
    ]) {
      const model = buildModel(parseNif(await vfs.read(path)));
      const bolts = model.particles.filter((system) => system.lightning);
      expect(bolts).toHaveLength(3);
      for (const system of bolts) {
        expect(system.lightning).toMatchObject({ subdivisions: 6, length: 512 });
        expect(system.material?.kind).toBe('effect');
        // Their idle sequence (the graph's mIdle) generates, mutates and animates the arc.
        const tracks = system.sequenceTracks.get('midle')?.map((track) => track.param);
        expect(tracks).toEqual(expect.arrayContaining(['generation', 'mutation', 'arcOffset']));
      }
      // The empty shapes are drawn as lightning, not as parts; BeamEnd sets the stretch.
      expect(model.parts).toHaveLength(0);
      expect(model.nodeWorlds?.get('beamend')?.[13]).toBe(512);
    }
  });

  it('stretches the bolts to a beam and mutates them as the sequence flips', async () => {
    const model = buildModel(parseNif(await vfs.read('meshes\\magic\\lightningbolt01.nif')));
    const system = model.particles.find((candidate) => candidate.name === 'object0');
    if (!system) throw new Error('no object0');
    const simulation = new LightningSimulation(system, 1, { stretch: () => 2 });
    const context = {
      seconds: 0,
      dt: 1 / 30,
      instanceWorld: identity(),
      animated: undefined,
      camera: [0, -300, 0] as const,
      wind: [0, 0, 0] as const,
      sequences: [{ sequence: 'midle', start: 0 }],
    };
    const ribbons = (seconds: number): Float32Array => {
      simulation.update({ ...context, seconds });
      const out = new Float32Array(simulation.instanceCount * PARTICLE_FLOATS);
      expect(simulation.write(out, 0, { ...context, seconds })).toBe(simulation.instanceCount);
      return out;
    };
    const first = ribbons(0.05);
    expect(simulation.count).toBeGreaterThanOrEqual(128);
    // The main bolt's last segment ends at twice its length along the beam (stretched).
    let farthest = 0;
    for (let i = 0; i < first.length; i += PARTICLE_FLOATS) {
      farthest = Math.max(farthest, (first[i + 1] ?? 0) + (first[i + 13] ?? 0));
    }
    expect(farthest).toBeCloseTo(1024, 0);
    // Its ribbons stay as wide as the controller says (width 4.5): the sides are not stretched.
    const side = Math.hypot(first[10] ?? 0, first[11] ?? 0, first[15] ?? 0);
    expect(side).toBeCloseTo(2.25);
    // After the mutation key (0.133 s) the bolt is laid out anew.
    const mutated = ribbons(0.2);
    expect(mutated.slice(0, 64)).not.toEqual(first.slice(0, 64));
  });
});
