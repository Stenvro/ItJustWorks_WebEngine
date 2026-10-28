// Conformance: ragdolls and death (engine map: Animation and bodies > Ragdolls, death): how an
// actor dies through its idle tree into its ragdoll, and the settings that drive it.
//
// Sources:
// - The data: the death actions' idle trees (`node tools/idle-info.ts --tree ActionDeathWait
//   0_master`): the humans' DeathAnimationRoot drops as a Ragdoll one whose killer holds a bow,
//   a staff or magic, one paired, in furniture of animation type 1 (IsInFurnitureState 1),
//   bleeding out, swimming, soul-rent, or half the time (GetRandomPercent < 50), else
//   DeathAnim, which the master graph's wildcard takes from any state into AnimateToRagdoll.
//   The furniture's markers (FURN FNPR): 395 sit, 219 sleep and 2 lean (type 4); the bar
//   counters people lean at are sit markers.
// - The engine, observed in the original (docs/animation.md, "Graph events"): AddRagdollToWorld adds the
//   ragdoll, driven by the graph where [Animation] bDriveRagdollWithGraph (1); deathStop ends
//   the dying; DeathEmote queues the Death line.
// - The settings: the engine's defaults and Skyrim.esm (`node tools/gmst-info.ts --prefix fDeath`).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readIdleTree, type IdleTree } from '../../../src/ai/idle-records.ts';
import { conditionFunctionName } from '../../../src/scripting/condition-functions.ts';
import { readCombatSettings } from '../../../src/gameplay/combat/combat-settings.ts';
import { RecordFlag } from '../../../src/formats/esm/record.ts';
import { FurnitureMarkerType, parseFurniture } from '../../../src/world/furniture-records.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

/** Skyrim.esm's death force settings (gmst-info), the engine's for the mass terms. */
const ESM: Readonly<Record<string, number>> = {
  fDeathForceDamageMax: 40,
  fDeathForceDamageMin: 1,
  fDeathForceForceMax: 12,
  fDeathForceForceMin: 4,
  fDeathForceRangedDamageMax: 50,
  fDeathForceRangedDamageMin: 1,
  fDeathForceRangedForceMax: 30,
  fDeathForceRangedForceMin: 10,
};

describe('the settings', () => {
  it('the death push: Skyrim.esm’s fDeathForce*, the engine’s mass base 3 and mult 0.15', () => {
    const settings = readCombatSettings((name) => ESM[name]);
    expect(settings.deathForceForceMin).toBe(4);
    expect(settings.deathForceForceMax).toBe(12);
    expect(settings.deathForceDamageMin).toBe(1);
    expect(settings.deathForceDamageMax).toBe(40);
    expect(settings.deathForceRangedForceMin).toBe(10);
    expect(settings.deathForceRangedForceMax).toBe(30);
    expect(settings.deathForceMassBase).toBe(3);
    expect(settings.deathForceMassMult).toBeCloseTo(0.15, 6);
  });
});

describe.skipIf(!hasGamedata())('the death idles and furniture of the load order (data)', () => {
  let sim: Sim;
  let tree: IdleTree;
  const markerTypes = new Map<number, number>();

  beforeAll(async () => {
    sim = await openSim();
    tree = await readIdleTree(sim.db);
    await sim.db.scan(
      ['FURN'],
      (flags) => (flags & RecordFlag.deleted) === 0,
      (record) => {
        for (const entry of parseFurniture(record).entryPoints) {
          markerTypes.set(entry.type, (markerTypes.get(entry.type) ?? 0) + 1);
        }
      },
    );
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('the humans’ ActionDeathWait: MQPhantomUnsummon, MS12BedDeath, Ragdoll, DeathAnimationStart', () => {
    const action = tree.action('ActionDeathWait');
    const graph = 'actors\\character\\behaviors\\0_master.hkx';
    const [root] = tree.children(action?.formId ?? 0, graph);
    expect(root?.editorId).toBe('DeathAnimationRoot');
    expect(tree.children(root?.formId ?? 0, graph).map((idle) => idle.editorId)).toEqual([
      'MQPhantomUnsummon',
      'MS12BedDeath',
      'Ragdoll',
      'DeathAnimationStart',
    ]);
  });

  it('Ragdoll for one in furniture of animation type 1, or half the time', () => {
    const ragdoll = [...tree.idles.values()].find((idle) => idle.editorId === 'Ragdoll');
    const conditions = (ragdoll?.conditions ?? []).map(
      (condition) => `${conditionFunctionName(condition.function)}(${condition.raw1})`,
    );
    expect(conditions).toContain('IsInFurnitureState(1)');
    expect(conditions).toContain('GetRandomPercent(0)');
  });

  it('the furniture markers: 395 sit, 219 sleep, 2 lean (type 4)', () => {
    expect(markerTypes.get(FurnitureMarkerType.sit)).toBe(395);
    expect(markerTypes.get(FurnitureMarkerType.sleep)).toBe(219);
    expect(markerTypes.get(FurnitureMarkerType.lean)).toBe(2);
  });
});

// Hulda (the Bannered Mare's innkeeper) leans at the bar counter, a sit marker
// (IdleBarCounterEnter): killed there, the death tree drops her as a ragdoll from where she
// leans (IsInFurnitureState 1), and her body slumps to the floor.

const BANNERED_MARE = 0x1605e;
const HULDA = 0x1a66e;

describe.skipIf(!hasGamedata())('Hulda killed at the bar counter (headless simulation)', () => {
  let sim: Sim;
  let leaning = false;
  let animationType: number | undefined;
  let deathIdle: string | undefined;
  let headBefore = 0;
  let headAfter = 0;
  let held = true;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    const furniture = sim.world.stage.furniture;
    leaning = await sim.until(() => furniture.interaction(HULDA)?.state === 3, 60);
    animationType = furniture.interaction(HULDA)?.animationType;
    await sim.step(2);
    const head = (): number =>
      sim.actor(HULDA)?.placed.pose.world('NPC Head [Head]')?.[14] ?? Number.NaN;
    headBefore = head();
    const actionEvent = furniture.actionEvent.bind(furniture);
    furniture.actionEvent = async (user, action, target, inFurniture) => {
      const event = await actionEvent(user, action, target, inFurniture);
      if (user.reference === HULDA && action.startsWith('ActionDeath') && event !== undefined)
        deathIdle = event;
      return event;
    };
    await sim.kill(HULDA, PLAYER_REF);
    await sim.step(5);
    headAfter = head();
    held = furniture.holds(HULDA);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('she leans at the counter on a sit marker (animation type 1)', () => {
    expect(leaning).toBe(true);
    expect(animationType).toBe(FurnitureMarkerType.sit);
  });

  it('her death idle is Ragdoll (IsInFurnitureState 1)', () => {
    expect(deathIdle).toBe('Ragdoll');
  });

  it('the counter lets go of her', () => {
    expect(held).toBe(false);
  });

  // Killed still (a script's Kill: no blow pushes her), her ragdoll is let go from the lean pose.
  // Held by Rapier's box of swing limits alone, her joints lay within it but past Havok's cone
  // on its diagonals, and her friction kept her on her feet, asleep upright (head at 98 units);
  // with the cone (constraint-solver.ts) her joints are turned back into it and she slumps.
  it('her body slumps: the head falls below the counter’s height', () => {
    expect(headBefore).toBeGreaterThan(100);
    expect(headAfter).toBeLessThan(60);
  });
});

describe('ragdolls and death (todo)', () => {
  it.todo('powered ragdoll motors: the graph’s powered bones by the RagdollAnim gains  [INI]');
  it.todo('fDyingTimer (2): how long an actor dies before it is dead  [settings, original]');
  it.todo('[Animation] bAlwaysDriveRagdoll (0): a ragdoll driven while alive  [INI]');
  it.todo('iDeathDropWeaponChance (0): the weapon dropped at death  [settings]');
  it.todo('a death in a lean marker (type 4): Ragdoll half the time, else DeathAnim  [data]');
  it.todo('fEssentialDeathTime (30): an essential actor’s bleedout time  [settings]');
  it.todo(
    'ragdoll feedback (bRagdollFeedback, fFeedback*): hit impulses on a driven ragdoll  [INI]',
  );
});
