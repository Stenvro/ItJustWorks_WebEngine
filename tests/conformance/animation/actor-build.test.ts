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
import { BehaviorRuntime } from '../../../src/animation/behavior-runtime.ts';
import { buildRig } from '../../../src/animation/skeleton.ts';
import {
  readAnimationContainer,
  TRANSFORM_FLOATS,
  type AnimationBinding,
  type HkxSkeleton,
} from '../../../src/formats/hkx/animation.ts';
import { loadCharacterInfo } from '../../../src/formats/hkx/behavior.ts';
import { Packfile } from '../../../src/formats/hkx/packfile.ts';
import { parseNif } from '../../../src/formats/nif/nif.ts';
import {
  FIRST_PERSON_DEPTH,
  firstPersonDepth,
  verticalFov,
} from '../../../src/render/first-person-view.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { parseRace } from '../../../src/world/actor-records.ts';
import { meshPath } from '../../../src/world/actors.ts';
import { FIRST_PERSON_SKELETON } from '../../../src/world/player-body.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
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

// The first-person skeleton's pass (docs/rendering.md, "First person"; observed in the
// original): the arms and what they hold are drawn through a camera of their own, first
// person's field of view ([Display] fDefault1stPersonFOV) and near plane ([Display]
// fNear1stPersonDistance, 5), in the depth band nearest the eye that the world never reaches.

/** Clip coordinates of a world point through a view-projection. */
function clip(m: Float32Array, p: readonly number[]): [number, number, number, number] {
  const out: [number, number, number, number] = [0, 0, 0, 0];
  for (let row = 0; row < 4; row++) {
    out[row] =
      (m[row] ?? 0) * (p[0] ?? 0) +
      (m[4 + row] ?? 0) * (p[1] ?? 0) +
      (m[8 + row] ?? 0) * (p[2] ?? 0) +
      (m[12 + row] ?? 0);
  }
  return out;
}

describe.skipIf(!hasGamedata())('the first-person skeleton’s pass (headless simulation)', () => {
  let sim: Sim;

  beforeAll(async () => {
    sim = await openSim({ interior: 0x1605e, hour: 12 });
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('the first-person skeleton runs its own graph, with the camera node it rides', () => {
    const arms = sim.world.playerView?.avatar?.firstPersonBody;
    expect(arms).toBeDefined();
    expect(FIRST_PERSON_SKELETON).toBe('meshes\\actors\\character\\_1stperson\\skeleton.nif');
    expect(arms?.pose.skeleton.nodeByName.has('camera1st [cam1]')).toBe(true);
  });

  it('its settings: 80° across a 4:3 frame, a near plane at 5', () => {
    const ini = sim.world.session.ini;
    expect(ini.lookup('Display', 'fDefault1stPersonFOV')).toBe(80);
    expect(ini.lookup('Display', 'fNear1stPersonDistance')).toBe(5);
    expect(ini.lookup('Display', 'fNearDistance')).toBe(15);
  });

  it('its own projection: the near plane at 5 (the world’s at 15), its field of view', () => {
    const player = sim.world.player;
    const aspect = 16 / 9;
    const world = player.viewProjection(aspect);
    const arms = player.firstPersonViewProjection(aspect);
    const eye = player.position;
    const forward = player.forward;
    const ahead = (distance: number, up = 0): number[] => {
      // Up in the view: the world's up, less its share along the look.
      const along = forward[2];
      const upward = [-along * forward[0], -along * forward[1], 1 - along * forward[2]];
      const length = Math.hypot(upward[0] ?? 0, upward[1] ?? 0, upward[2] ?? 0);
      return [0, 1, 2].map(
        (i) => (eye[i] ?? 0) + (forward[i] ?? 0) * distance + ((upward[i] ?? 0) / length) * up,
      );
    };
    // Reversed depth: a point at the near plane is at 1.
    const [, , z5, w5] = clip(arms, ahead(5));
    expect(z5 / w5).toBeCloseTo(1, 3);
    const [, , z40, w40] = clip(arms, ahead(40));
    expect(z40 / w40).toBeCloseTo(5 / 40, 3);
    const [, , zw, ww] = clip(world, ahead(40));
    expect(zw / ww).toBeCloseTo(15 / 40, 3);
    // Its vertical field of view: fDefault1stPersonFOV across a 4:3 frame.
    const [, y, , w] = clip(arms, ahead(40, 10));
    expect(((y / w) * 40) / 10).toBeCloseTo(1 / Math.tan(verticalFov(80) / 2), 2);
  });

  it('its depth band lies in front of the world past the world’s near plane', () => {
    // The world keeps its near plane 15 from the eye: its nearest depth (reversed) is 1 there,
    // and below the band's start for a wall 15.2 away or more (15/15.2 is 0.987).
    expect(FIRST_PERSON_DEPTH).toBe(0.99);
    expect(firstPersonDepth(0)).toBeGreaterThan(15 / 15.2);
    expect(firstPersonDepth(5 / 40)).toBeGreaterThan(firstPersonDepth(5 / 60));
  });
});

// Bone LOD (observed in the original): the skeleton model's BSBoneLODExtraData names, from each
// distance on, the Havok bone from which the rest keep their pose; the distance is the camera's
// across the ground times [Animation] fBoneLODDistanceScale over the actor's scale.

describe.skipIf(!hasGamedata())('bone LOD of the people’s skeleton (data)', () => {
  let rig: HkxSkeleton | undefined;
  let levels: readonly { readonly distance: number; readonly bone: string }[] = [];

  beforeAll(async () => {
    const vfs = await Vfs.mount(openGameFolder());
    const read = (path: string): Promise<Uint8Array> => vfs.read(path);
    const rigPath = (await loadCharacterInfo(PROJECT, read)).rig ?? '';
    rig = readAnimationContainer(Packfile.parse(await read(rigPath))).skeletons[0];
    levels = buildRig(parseNif(await read(MODEL))).boneLod ?? [];
    await vfs.close();
  }, 600_000);

  it('the skeleton names three levels: the third-person camera at 128, the fingers at 768, the head’s magic node at 2048', () => {
    expect(levels).toEqual([
      { distance: 128, bone: 'Camera3rd [Cam3]' },
      { distance: 768, bone: 'NPC L Finger00 [LF00]' },
      { distance: 2048, bone: 'NPC Head MagicNode [Hmag]' },
    ]);
  });

  it('a far actor keeps the pose of the bones from the level’s bone on', () => {
    if (!rig) throw new Error('No rig');
    const skeleton = rig;
    const count = skeleton.bones.length;
    // Every bone moves along x with the clip's time.
    const moving: AnimationBinding = {
      skeletonName: skeleton.name,
      animation: {
        duration: 100,
        trackCount: count,
        floatTrackCount: 0,
        annotations: [],
        motion: undefined,
        sample: (time, out) => {
          for (let bone = 0; bone < count; bone++) {
            out.set([time, 0, 0, 0, 0, 0, 1, 1, 1, 1], bone * TRANSFORM_FLOATS);
          }
        },
      },
      trackToBone: undefined,
      floatTrackToSlot: undefined,
      additive: false,
    };
    const runtime = new BehaviorRuntime({
      root: {
        name: 'test',
        events: [],
        variables: [],
        root: { kind: 'clip', name: 'move', animation: 'move', mode: 1, playbackSpeed: 1 },
      },
      host: { clip: () => moving, behavior: () => undefined },
      skeleton,
    });
    runtime.setBoneLod(levels);
    const index = (name: string): number => skeleton.bones.findIndex((bone) => bone.name === name);
    const moved = (): number => {
      let bones = 0;
      while (bones < count && runtime.pose[bones * TRANSFORM_FLOATS] === runtime.pose[0]) bones++;
      return bones;
    };
    runtime.boneLodDistance = 100;
    runtime.update(1);
    expect(moved()).toBe(count);
    for (const [distance, bone] of [
      [200, 'Camera3rd [Cam3]'],
      [1000, 'NPC L Finger00 [LF00]'],
      [3000, 'NPC Head MagicNode [Hmag]'],
    ] as const) {
      runtime.boneLodDistance = distance;
      runtime.update(1);
      // The bones before the level's move on; it and those after keep where they were.
      expect(moved()).toBe(index(bone));
      expect(index(bone)).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!hasGamedata())('the actors’ bone LOD distance (headless simulation)', () => {
  let sim: Sim;

  beforeAll(async () => {
    sim = await openSim({ interior: 0x1605e, hour: 20 });
    await sim.step(2);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('is each actor’s distance from the camera across the ground', () => {
    const camera = sim.world.player.position;
    let checked = 0;
    for (const staged of sim.actors()) {
      const distance = staged.placed.behavior?.boneLodDistance;
      const world = staged.placed.instances[0]?.world;
      if (distance === undefined || !world) continue;
      const scale = Math.hypot(world[0] ?? 0, world[1] ?? 0, world[2] ?? 0) || 1;
      const across = Math.hypot((world[12] ?? 0) - camera[0], (world[13] ?? 0) - camera[1]);
      // As of its last update (an actor walking moves a little between).
      expect(Math.abs(distance * scale - across)).toBeLessThan(64);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

// Every race's skeleton model against its behaviour project's rig: the engine matches the rig's
// bones to the model's nodes by name (ActorSkeleton.boneOfNode).

describe.skipIf(!hasGamedata())('every race’s project against its skeleton (a data sweep)', () => {
  /** Per race (editor id, "(f)" for the female half): the rig's bones the model lacks. */
  const missing = new Map<string, string[]>();
  const failures: string[] = [];

  beforeAll(async () => {
    const vfs = await Vfs.mount(openGameFolder());
    const db = await RecordDatabase.open(vfs);
    const read = (path: string): Promise<Uint8Array> => vfs.read(path);
    const byPair = new Map<string, string[] | undefined>();
    for (const formId of db.formIdsOfType('RACE')) {
      const record = await db.get(formId);
      if (!record) continue;
      const race = parseRace(record);
      for (const sex of [0, 1] as const) {
        const model = race.skeleton[sex];
        const project = race.behavior[sex];
        if (model === undefined || project === undefined) continue;
        const name = `${record.editorId ?? formId.toString(16)}${sex === 1 ? '(f)' : ''}`;
        const key = `${meshPath(project)}|${meshPath(model)}`.toLowerCase();
        if (!byPair.has(key)) {
          try {
            const rigPath = (await loadCharacterInfo(meshPath(project), read)).rig ?? '';
            const bones =
              readAnimationContainer(Packfile.parse(await read(rigPath))).skeletons[0]?.bones ?? [];
            const nodes = new Set(
              buildRig(parseNif(await read(meshPath(model)))).names.map((node) =>
                node.toLowerCase(),
              ),
            );
            byPair.set(
              key,
              bones.map((bone) => bone.name).filter((bone) => !nodes.has(bone.toLowerCase())),
            );
          } catch (error) {
            byPair.set(key, undefined);
            failures.push(`${name}: ${String(error)}`);
          }
        }
        const lacking = byPair.get(key);
        if (lacking) missing.set(name, lacking);
      }
    }
    await db.close();
    await vfs.close();
  }, 600_000);

  it('every race’s project and skeleton are read', () => {
    expect(failures).toEqual([]);
    expect(missing.size).toBeGreaterThan(100);
  });

  it('the people’s rigs lack only their three helper bones in every people’s skeleton', () => {
    for (const race of ['NordRace', 'NordRace(f)', 'KhajiitRace', 'ArgonianRace(f)']) {
      expect(missing.get(race)).toEqual([
        'x_NPC LookNode [Look]',
        'x_NPC Translate [Pos ]',
        'x_NPC Rotate [Rot ]',
      ]);
    }
  });

  it('every creature’s rig is all nodes of its model, the werewolf’s arm helpers and a few unused halves apart', () => {
    const helpers = /^x_NPC |^NPC [LR] Upperarm(Override|TwistHelper|LocalRef)$|ExposeTransform$/;
    const mismatched = [...missing]
      .filter(([, lacking]) => lacking.some((bone) => !helpers.test(bone)))
      .map(([race]) => race)
      .sort();
    // The female halves of five creature races keep the people's project over their own
    // skeleton (no actor of them is female), the Midden's empty race the people's project on an
    // empty model, and a test race a skeleton of the Dawnguard draugr.
    expect(mismatched).toEqual([
      'AlduinRace(f)',
      'MagicAnomalyRace(f)',
      'SprigganSwarmRace(f)',
      'SwarmRace(f)',
      'UndeadDragonRace(f)',
      'dunMiddenEmptyRace',
      'testDraugrRace',
    ]);
  });
});
