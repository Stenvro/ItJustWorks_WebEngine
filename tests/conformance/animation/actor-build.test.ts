// Conformance: the actor build (engine map: Animation and bodies > Actor build): an actor's
// skeleton from its race's model and behaviour project, the Havok skeleton matched to its nodes.
//
// Sources:
// - The data: the people's behaviour project (actors\character\defaultmale.hkx: hkbCharacterData's
//   string data names the rig character assets\skeleton.hkx), the skeleton model
//   (character assets\skeleton.nif) with the nodes made for the animation objects (AnimObjectR,
//   AnimObjectL, AnimObjectA, AnimObjectB) and the Havok skeleton's bones by name
//   (docs/animation.md, "Actors" and "Animation objects").

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildRig } from '../../../src/animation/skeleton.ts';
import { readAnimationContainer } from '../../../src/formats/hkx/animation.ts';
import { loadCharacterInfo } from '../../../src/formats/hkx/behavior.ts';
import { Packfile } from '../../../src/formats/hkx/packfile.ts';
import { parseNif } from '../../../src/formats/nif/nif.ts';
import { hasGamedata, openSim, type Sim } from '../../helpers/sim.ts';

const PROJECT = 'meshes\\actors\\character\\defaultmale.hkx';
const MODEL = 'meshes\\actors\\character\\character assets\\skeleton.nif';

describe.skipIf(!hasGamedata())('the people’s skeleton (data)', () => {
  let sim: Sim;
  let rig: string | undefined;
  let bones: readonly string[] = [];
  let nodes: readonly string[] = [];

  beforeAll(async () => {
    sim = await openSim();
    const vfs = sim.world.session.vfs;
    const read = (path: string): Promise<Uint8Array> => vfs.read(path);
    rig = (await loadCharacterInfo(PROJECT, read)).rig;
    const container = readAnimationContainer(Packfile.parse(await read(rig ?? '')));
    bones = container.skeletons[0]?.bones.map((bone) => bone.name) ?? [];
    nodes = buildRig(parseNif(await read(MODEL))).names;
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('the project names its rig: character assets\\skeleton.hkx', () => {
    expect(rig?.toLowerCase()).toBe('meshes\\actors\\character\\character assets\\skeleton.hkx');
  });

  it('the Havok skeleton has 99 bones, 96 of them nodes of the model', () => {
    expect(bones).toHaveLength(99);
    const named = new Set(nodes.map((name) => name.toLowerCase()));
    expect(bones.filter((bone) => named.has(bone.toLowerCase()))).toHaveLength(96);
  });

  it('the model has the four animation object nodes', () => {
    for (const node of ['AnimObjectR', 'AnimObjectL', 'AnimObjectA', 'AnimObjectB']) {
      expect(nodes).toContain(node);
    }
  });
});

describe('the actor build (todo)', () => {
  it.todo('the first-person skeleton’s render pass (its own field of view and depth)  [original]');
  it.todo('bone LOD: far actors drop the bones their LOD names  [original]');
  it.todo('every race’s project matches its rig’s bones to its model’s nodes (a sweep)  [data]');
});
