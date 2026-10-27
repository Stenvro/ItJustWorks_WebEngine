// Conformance: movement and paths (engine map: AI > Movement, paths): here the navmesh
// obstacles, the engine's cut of the navmesh under objects that block a way while they are there
// (docs/ai.md, "Navmesh obstacles").
//
// Sources:
// - CommonLibSSE: NavMeshObstacleManager, BSNavmeshObstacleData per triangle and
//   BSNavmeshObstacleUndoData to restore the cut, bhkObstacleDeactivationListener (a Havok body
//   come to rest), DoorObstacleAdapter (doors); TESForm record flag bit 25 (kObstacle) on a base
//   object makes its references obstacles.
// - The data: `node tools/navmesh-obstacle-audit.ts` (Skyrim.esm, the DLCs and the Creation Club
//   files of the maintainer's game folder, 2026-10-24): 65 flagged bases, 6,953 references,
//   CollisionMarker [00000021] 4,663 of them (docs/ai.md had 4,664).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { hasGamedata, openGameFolder } from '../../../tools/gamedata-path.ts';
import { findPath } from '../../../src/ai/pathfinding.ts';
import { openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

/** TESForm record flag of a base object: its references are navmesh obstacles. */
const OBSTACLE = 1 << 25;
/** The base types that carry it in the data (tools/navmesh-obstacle-audit.ts). */
const TYPES = ['STAT', 'MSTT', 'ACTI', 'CONT', 'LIGH', 'FURN', 'DOOR', 'TREE', 'FLOR', 'MISC'];
const COLLISION_MARKER = 0x21;

describe.skipIf(!hasGamedata())('navmesh obstacles across the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  const bases = new Set<number>();
  let references = 0;
  let markers = 0;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    for (const type of TYPES) {
      for (const formId of db.formIdsOfType(type)) {
        const record = await db.get(formId);
        if (record && !record.deleted && (record.flags & OBSTACLE) !== 0) bases.add(formId);
      }
    }
    for (const formId of db.formIdsOfType('REFR')) {
      const record = await db.get(formId);
      const base = record?.formIdField('NAME');
      if (!record || record.deleted || base === undefined || !bases.has(base)) continue;
      references++;
      if (base === COLLISION_MARKER) markers++;
    }
  }, 600_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts 65 obstacle bases with 6,953 references, 4,663 of them collision markers', () => {
    expect(bases.size).toBe(65);
    expect(references).toBe(6953);
    expect(markers).toBe(4663);
  });
});

// Korvanjund01: MQ103BanditDisabler [000A45EB] holds a collision box [000A45EA] across the hall
// north of the entrance (y -5038 to -4925) until the quest disables it. Hulda, placed at the
// player south of it and held from her packages, is sent past it as a script's PathToReference
// sends an actor (ActorMovers.travel).

const KORVANJUND01 = 0x152a1;
const BANDIT_BOX = 0xa45ea;
const BANDIT_DISABLER = 0xa45eb;
/** North of the box, on the navmesh. */
const BEYOND: [number, number, number] = [-273, -4800, 655];
/** The box's south face. */
const BOX_SOUTH = -5038;

describe.skipIf(!hasGamedata())('a quest collision box across a hall (headless simulation)', () => {
  let sim: Sim;
  let walker = 0;
  const walk = async (): Promise<{ arrived: boolean | undefined; northmost: number }> => {
    let arrived: boolean | undefined;
    let northmost = -Infinity;
    void sim.world.stage.movers.travel(walker, BEYOND, 'walk', 32).then((done) => {
      arrived = done;
    });
    await sim.until(() => {
      const at = sim.actor(walker)?.position;
      if (at) northmost = Math.max(northmost, at[1]);
      return arrived !== undefined;
    }, 30);
    return { arrived, northmost };
  };

  beforeAll(async () => {
    sim = await openSim({ interior: KORVANJUND01 });
    walker = await sim.place(await sim.formId('NPC_', 'Hulda'), PLAYER_REF);
    sim.world.stage.ai.hold(walker, true);
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('cuts the navmesh under the enabled box: a walking NPC stops short of it', async () => {
    expect(await sim.enabled(BANDIT_BOX)).toBe(true);
    const cut = sim.world.stage.obstacles.active.find((entry) => entry.reference === BANDIT_BOX);
    expect(cut).toBeDefined();
    const from = sim.actor(walker)?.position;
    const path =
      from &&
      findPath(sim.world.navmeshes, from, BEYOND, {
        radius: 20,
        obstacles: sim.world.stage.obstacles.index,
      });
    expect(path?.complete).toBe(false);
    const { arrived, northmost } = await walk();
    expect(arrived).toBe(false);
    expect(northmost).toBeLessThan(BOX_SOUTH);
  }, 120_000);

  it('restores the cut as the quest disables the box: the NPC walks through', async () => {
    await sim.runtime.setEnabled(BANDIT_DISABLER, false);
    await sim.world.settle();
    await sim.step(0.1);
    expect(sim.world.stage.obstacles.active.some((entry) => entry.reference === BANDIT_BOX)).toBe(
      false,
    );
    const { arrived, northmost } = await walk();
    expect(arrived).toBe(true);
    expect(northmost).toBeGreaterThan(-4925);
  }, 120_000);

  it.todo(
    'cuts a triangle partly covered as the engine does: ours closes the triangles whose middle ' +
      'lies under a box and the path steps across one (src/ai/pathfinding.test.ts); TODO(M13): ' +
      'the engine re-triangulates the navmesh under it (BSNavmeshObstacleData per triangle)',
  );
});

// Saarthal01: a portcullis (NorPortcullis [000DE07D], default2StateActivator) is an obstacle while
// it is shut; its open animation opens the way, its close animation cuts it again.

const SAARTHAL01 = 0x15220;
const PORTCULLIS = 0xde07d;

describe.skipIf(!hasGamedata())('a portcullis opening and shutting (headless simulation)', () => {
  let sim: Sim;

  beforeAll(async () => {
    sim = await openSim({ interior: SAARTHAL01 });
    await sim.step(0.5);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  const cuts = (): boolean =>
    sim.world.stage.obstacles.active.some((entry) => entry.reference === PORTCULLIS);

  it('cuts again as an animated obstacle shuts, and not while it is open', () => {
    sim.runtime.world.animationEvent?.(PORTCULLIS, 'Close');
    expect(cuts()).toBe(true);
    sim.runtime.world.animationEvent?.(PORTCULLIS, 'Open');
    expect(cuts()).toBe(false);
    sim.runtime.world.animationEvent?.(PORTCULLIS, 'Close');
    expect(cuts()).toBe(true);
  });

  it.todo(
    'cuts again as a Havok body comes to rest (bhkObstacleDeactivationListener): TODO(M13), the ' +
      'cut from the obstacle body where it lies, not from its animation events',
  );
});
