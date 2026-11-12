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

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readIdleTree, type IdleTree } from '../../../src/ai/idle-records.ts';
import { conditionFunctionName } from '../../../src/scripting/condition-functions.ts';
import { readCombatSettings } from '../../../src/gameplay/combat/combat-settings.ts';
import { HAVOK_SCALE } from '../../../src/physics/collision-data.ts';
import { RecordFlag } from '../../../src/formats/esm/record.ts';
import {
  drivenRagdollMode,
  RAGDOLL_ANIM_DEFAULTS,
  RagdollFeedback,
  ragdollDrivenByGraph,
  readRagdollAnimSettings,
  scaledControl,
} from '../../../src/physics/ragdoll-anim.ts';
import { ObjectHandle } from '../../../src/scripting/values.ts';
import type { ActorInteraction } from '../../../src/scripting/runtime/runtime.ts';
import { FurnitureMarkerType, parseFurniture } from '../../../src/world/furniture-records.ts';
import { INI_DEFAULTS } from '../../../src/world/ini-settings.ts';
import { DYING_TIMER, DyingClock } from '../../../src/world/dying.ts';
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
// leans (IsInFurnitureState 1), and her body slumps to the floor, whatever point of her lean idle
// she dies at.

const BANNERED_MARE = 0x1605e;
const HULDA = 0x1a66e;
/**
 * Seconds into her lean (after she settles into it) at which she is killed: she slumps at every
 * one. While her joints' limits were Rapier's own, which do not yield, she stood on, bent over
 * the counter on locked legs (below): killed at 1 to 4.5 s, and with the poses she dies in on
 * this tip at 0.5 and 5 s too (all ten, head at 99–101 units).
 */
const PHASES = [0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5] as const;

/** One kill at the counter. */
interface CounterDeath {
  readonly leaning: boolean;
  readonly animationType: number | undefined;
  readonly deathIdle: string | undefined;
  readonly headBefore: number;
  readonly headAfter: number;
  readonly held: boolean;
}

async function killAtCounter(phase: number): Promise<CounterDeath> {
  const sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
  try {
    const furniture = sim.world.stage.furniture;
    const leaning = await sim.until(() => furniture.interaction(HULDA)?.state === 3, 60);
    const animationType = furniture.interaction(HULDA)?.animationType;
    await sim.step(phase);
    const head = (): number =>
      sim.actor(HULDA)?.placed.pose.world('NPC Head [Head]')?.[14] ?? Number.NaN;
    const headBefore = head();
    let deathIdle: string | undefined;
    const actionEvent = furniture.actionEvent.bind(furniture);
    furniture.actionEvent = async (user, action, target, inFurniture) => {
      const event = await actionEvent(user, action, target, inFurniture);
      if (user.reference === HULDA && action.startsWith('ActionDeath') && event !== undefined)
        deathIdle = event;
      return event;
    };
    await sim.kill(HULDA, PLAYER_REF);
    await sim.step(5);
    return {
      leaning,
      animationType,
      deathIdle,
      headBefore,
      headAfter: head(),
      held: furniture.holds(HULDA),
    };
  } finally {
    await sim.close();
  }
}

describe.skipIf(!hasGamedata())('Hulda killed at the bar counter (headless simulation)', () => {
  const deaths = new Map<number, CounterDeath>();

  beforeAll(async () => {
    // One simulation at a time (each kills her).
    for (const phase of PHASES) deaths.set(phase, await killAtCounter(phase));
  }, 900_000);

  it('she leans at the counter on a sit marker (animation type 1)', () => {
    for (const death of deaths.values()) {
      expect(death.leaning).toBe(true);
      expect(death.animationType).toBe(FurnitureMarkerType.sit);
    }
  });

  it('her death idle is Ragdoll (IsInFurnitureState 1)', () => {
    for (const death of deaths.values()) expect(death.deathIdle).toBe('Ragdoll');
  });

  it('the counter lets go of her', () => {
    for (const death of deaths.values()) expect(death.held).toBe(false);
  });

  // Killed still (a script's Kill: no blow pushes her), her ragdoll is let go from the lean pose.
  // Held by Rapier's box of swing limits alone, her joints lay within it but past Havok's cone
  // on its diagonals, and her friction kept her on her feet, asleep upright (head at 98 units);
  // with the cone (constraint-solver.ts) her joints are turned back into it and she slumps.
  it.each(PHASES)(
    'killed %s s into her lean, her body slumps below the counter’s height',
    (phase) => {
      const death = deaths.get(phase);
      expect(death?.headBefore).toBeGreaterThan(100);
      expect(death?.headAfter).toBeLessThan(60);
    },
  );

  // Killed 1 to 4.5 s into her lean her upper body tips forward over the counter until her
  // hips are at their cone (45°), and its weight then bears on her legs through their limits:
  // the hips', the knees' straight one and the ankles' dorsiflexion (3.6°: her feet flat, her
  // calves leaning back). With limits that do not yield (Rapier's) that is a strut, and she
  // stood bent over the counter (head at 99–101 units: every case above failed).
  // Havok's limits are as stiff as its solver's four iterations leave them
  // (constraint-solver.ts, limitGive; PhysicsWorld.#giveLimits): an ankle's, between a 3 kg
  // foot and her calf, is a spring of 96 N·m a radian, and her weight bore on it with 13 to
  // 19 N·m (measured while it still held, against a spring twice as stiff): it yields the 8°
  // and more that bring her calves forward over her feet, her knees fold and she goes down
  // within 2 s (her head at 81–95 units 1 s after the kill, 10–17 at 2 s, 9–24 units 5 s
  // on). Inferred from Havok's solver (TODO(M13)).
});

// The engine's own drive of a ragdoll ([RagdollAnim], the engine's built-in defaults; their use
// inferred from their names: src/physics/ragdoll-anim.ts).

describe('the engine’s ragdoll drive (settings, rules)', () => {
  it('[RagdollAnim]: the engine’s built-in gains and feedback settings', () => {
    for (const [key, value] of Object.entries(RAGDOLL_ANIM_DEFAULTS)) {
      expect(INI_DEFAULTS.RagdollAnim[key as keyof typeof RAGDOLL_ANIM_DEFAULTS]).toBe(value);
    }
    const settings = readRagdollAnimSettings();
    expect(settings.control).toEqual({
      hierarchyGain: 0.17,
      velocityDamping: 0,
      accelerationGain: 1,
      velocityGain: 0.6,
      positionGain: 0.05,
      positionMaxLinearVelocity: 14,
      positionMaxAngularVelocity: 18,
      snapGain: 0.1,
      snapMaxLinearVelocity: 3,
      snapMaxAngularVelocity: 0.3,
      snapMaxLinearDistance: 0.3,
      snapMaxAngularDistance: 1,
    });
    expect(settings.feedback).toBe(true);
    expect(settings.feedbackImpulse).toBe(500);
    expect(settings.feedbackGain).toBeCloseTo(0.3, 6);
    expect(settings.feedbackGainTime).toBe(1);
    expect(settings.feedbackTime).toBe(10);
  });

  it('powered ragdoll motors: the graph’s powered bones by the RagdollAnim gains', () => {
    // A dying graph's powered bones (force above 0) are driven by the [RagdollAnim] gains.
    expect(drivenRagdollMode({ rigid: false, poweredForce: 200, dying: true })).toBe('powered');
    expect(drivenRagdollMode({ rigid: true, poweredForce: 200, dying: true })).toBe('powered');
    // FullyRagdoll's limp (force 0) lets the death go; a get-up's powered controls keep their
    // motors (the living's).
    expect(drivenRagdollMode({ rigid: true, poweredForce: 0, dying: true })).toBe('follow');
    expect(drivenRagdollMode({ rigid: false, poweredForce: 200, dying: false })).toBe('follow');
    // The rigid body controls drive it where no powered controls are; neither: its pose.
    expect(drivenRagdollMode({ rigid: true, poweredForce: undefined, dying: true })).toBe('rigid');
    expect(drivenRagdollMode({ rigid: false, poweredForce: undefined, dying: true })).toBe(
      'follow',
    );
  });

  // The dying life state (src/world/dying.ts): the scripts' OnDeath waits for its end
  // (src/scripting/runtime/actor-engine.test.ts), the stage's lifeState answers dying (1) until
  // then. That fDyingTimer bounds it from the kill is inferred, TODO(M13).
  it('fDyingTimer (2): how long an actor dies before it is dead  [settings, inferred]', async () => {
    expect(DYING_TIMER).toBe(2);
    const clock = new DyingClock();
    const ended: string[] = [];
    void clock.begin(1).then(() => ended.push('timer'));
    void clock.begin(2).then(() => ended.push('deathStop'));
    void clock.begin(3, 5).then(() => ended.push('retimed'));
    clock.frame(1);
    clock.end(2);
    await Promise.resolve();
    expect(ended).toEqual(['deathStop']);
    expect(clock.has(1)).toBe(true);
    // fDyingTimer as set (setgs) counts from the kill: 0.5 s, already passed, ends it now.
    clock.retime(3, 0.5);
    clock.frame(0.99);
    await Promise.resolve();
    expect(ended).toEqual(['deathStop', 'retimed']);
    clock.frame(0.02);
    await Promise.resolve();
    expect(ended).toEqual(['deathStop', 'retimed', 'timer']);
    expect(clock.until(1)).toBeUndefined();
  });

  it('[Animation] bAlwaysDriveRagdoll (0): a ragdoll driven while alive', () => {
    expect(INI_DEFAULTS.Animation.bAlwaysDriveRagdoll).toBe(0);
    const game = { driveWithGraph: true, alwaysDrive: false };
    expect(ragdollDrivenByGraph(game, false)).toBe(false);
    expect(ragdollDrivenByGraph(game, true)).toBe(true);
    expect(ragdollDrivenByGraph({ ...game, alwaysDrive: true }, false)).toBe(true);
    expect(ragdollDrivenByGraph({ driveWithGraph: false, alwaysDrive: false }, true)).toBe(false);
  });

  it('ragdoll feedback (bRagdollFeedback, fFeedback*): hit impulses on a driven ragdoll', () => {
    const settings = readRagdollAnimSettings();
    const feedback = new RagdollFeedback();
    expect(feedback.gainScale(0, settings)).toBe(1);
    // A hit at 10 s: fFeedbackImpulseMult on the body struck; the gains go to 0.3 over 1 s,
    // stay there until 10 s after it, and come back over 1 s.
    expect(feedback.hit(10, settings)).toBe(500);
    expect(feedback.gainScale(10.5, settings)).toBeCloseTo(0.65, 6);
    expect(feedback.gainScale(11, settings)).toBeCloseTo(0.3, 6);
    expect(feedback.gainScale(19.9, settings)).toBeCloseTo(0.3, 6);
    expect(feedback.gainScale(20.5, settings)).toBeCloseTo(0.65, 6);
    expect(feedback.gainScale(21, settings)).toBe(1);
    // A second hit half-way down the ramp: on down from where they are (no jump back up), and
    // held for the full 10 s from the second hit (until 40.5, not 40).
    feedback.hit(30, settings);
    feedback.hit(30.5, settings);
    expect(feedback.gainScale(30.5, settings)).toBeCloseTo(0.65, 6);
    expect(feedback.gainScale(31, settings)).toBeCloseTo(0.3, 6);
    expect(feedback.gainScale(40.25, settings)).toBeCloseTo(0.3, 6);
    expect(feedback.gainScale(41, settings)).toBeCloseTo(0.65, 6);
    expect(feedback.gainScale(41.5, settings)).toBe(1);
    // A hit while they are held renews the hold for the full 10 s (from 55 to 65, not 64).
    feedback.hit(50, settings);
    feedback.hit(55, settings);
    expect(feedback.gainScale(64.5, settings)).toBeCloseTo(0.3, 6);
    expect(feedback.gainScale(65.5, settings)).toBeCloseTo(0.65, 6);
    // A hit as they come back up: down again from where they are, held 10 s from it.
    feedback.hit(70, settings);
    feedback.hit(80.5, settings);
    expect(feedback.gainScale(80.5, settings)).toBeCloseTo(0.65, 6);
    expect(feedback.gainScale(81, settings)).toBeCloseTo(0.3, 6);
    expect(feedback.gainScale(90.25, settings)).toBeCloseTo(0.3, 6);
    // The settings of the moment: a lower fFeedbackOnOffGain holds them lower.
    const lower = readRagdollAnimSettings((key) =>
      key === 'fFeedbackOnOffGain' ? 0.1 : undefined,
    );
    expect(feedback.gainScale(85, lower)).toBeCloseTo(0.1, 6);
    const half = scaledControl(settings.control, 0.5);
    expect(half.hierarchyGain).toBeCloseTo(0.085, 6);
    expect(half.positionMaxLinearVelocity).toBe(14);
    // Off: no push, no yield.
    const off = readRagdollAnimSettings((key) => (key === 'bRagdollFeedback' ? 0 : undefined));
    const none = new RagdollFeedback();
    expect(none.hit(1, off)).toBe(0);
    expect(none.gainScale(1.5, off)).toBe(1);
  });
});

/** The humans' behaviour graph, as the idle tree names it. */
const HUMAN_GRAPH = 'actors\\character\\behaviors\\0_master.hkx';

describe.skipIf(!hasGamedata())(
  'the Bannered Mare: the ragdoll INI, a lean’s death, a get-up’s blow (headless simulation)',
  () => {
    let sim: Sim;

    beforeAll(async () => {
      sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
      await sim.step(5);
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    it('a death in a lean marker (type 4): Ragdoll half the time, else DeathAnim', async () => {
      const tree = await readIdleTree(sim.db);
      const action = tree.action('ActionDeathWait');
      const runtime = sim.runtime;
      const world = runtime.world;
      const original = Object.getOwnPropertyDescriptor(world, 'interaction');
      const before = world.interaction?.bind(world);
      // The death idle chosen for Hulda in furniture of an animation type, the random percent
      // drawn as `random` × 100; her killer, the player, is the action's target.
      const choose = async (animationType: number, random: number): Promise<string | undefined> => {
        world.interaction = (actor: number): ActorInteraction | undefined =>
          actor === HULDA
            ? {
                furniture: 0x58e17,
                base: 0,
                marker: 0,
                animationType,
                entry: 0x10000,
                state: 3,
                quickEnter: false,
                quickExit: false,
              }
            : before?.(actor);
        const spy = vi.spyOn(Math, 'random').mockReturnValue(random);
        try {
          const idle = await tree.resolveAsync(action?.formId ?? 0, HUMAN_GRAPH, (candidate) =>
            runtime.conditionsHold(
              candidate.conditions,
              new ObjectHandle(HULDA, 'actor'),
              undefined,
              {
                target: runtime.referenceHandle(PLAYER_REF),
              },
            ),
          );
          return idle?.editorId;
        } finally {
          spy.mockRestore();
          if (original) Object.defineProperty(world, 'interaction', original);
          else delete (world as { interaction?: unknown }).interaction;
        }
      };
      // Leaning (type 4) is not IsInFurnitureState 1: Ragdoll only by GetRandomPercent < 50.
      expect(await choose(FurnitureMarkerType.lean, 0.3)).toBe('Ragdoll');
      expect(await choose(FurnitureMarkerType.lean, 0.7)).toBe('DeathAnimationStart');
      // Sitting (type 1, the counter she leans at) always drops her as a ragdoll.
      expect(await choose(FurnitureMarkerType.sit, 0.7)).toBe('Ragdoll');
    }, 120_000);

    it('bAlwaysDriveRagdoll on: a living actor’s ragdoll is driven by its graph', async () => {
      const bodies = sim.world.stage.bodies;
      expect(bodies.has(HULDA)).toBe(true);
      // Off (the game's): her bodies are keyframed to her pose, no hit pushes them.
      expect(bodies.driven(HULDA)).toBeUndefined();
      expect(bodies.feedback(HULDA, [1, 0, 0])).toBeUndefined();
      sim.world.session.preferences.set('Animation:bAlwaysDriveRagdoll', 1);
      await sim.step(1);
      expect(sim.actor(HULDA)?.dead).toBe(false);
      expect(bodies.driven(HULDA)).toBeDefined();
    }, 120_000);

    it('ragdoll feedback: a blow pushes the body it lands nearest and the drive yields', async () => {
      const bodies = sim.world.stage.bodies;
      const preferences = sim.world.session.preferences;
      if (bodies.driven(HULDA)?.dynamic !== true) {
        // Her graph's rigid body controls simulate her bodies only in the states that have them.
        await sim.until(() => bodies.driven(HULDA)?.dynamic === true, 20);
      }
      expect(bodies.driven(HULDA)?.dynamic).toBe(true);
      // Her bodies: her ragdoll's 18, and her skeleton's character bumper, which has no mass
      // (nothing pushes it) and whose origin lies farther from her pelvis than any of them
      // (81 units; her feet 61, her head 53).
      const all = bodies.bodyStates(HULDA);
      const states = all.filter((state) => state.mass > 0);
      const bumper = all.find((state) => state.mass === 0);
      expect(states).toHaveLength(18);
      expect(bumper?.node).toBe('CharacterBumper');
      const first = states[0];
      expect(first).toBeDefined();
      if (!first || !bumper) return;
      // Driven by her graph she stands at the counter as her pose has her, her joints' limits
      // giving or not: her head 48 units above her pelvis and her feet 60 below it (47.9 to
      // 48.0 and 59.6 to 60.0 with limits that do not yield, 48.2 to 48.6 and 59.2 to 60.3
      // with the give).
      const above = (pattern: RegExp): number[] =>
        states.filter((state) => pattern.test(state.node)).map((s) => s.at[2] - first.at[2]);
      expect(above(/Head/)).toHaveLength(1);
      expect(above(/Foot/)).toHaveLength(2);
      for (const height of above(/Head/)) {
        expect(height).toBeGreaterThan(47);
        expect(height).toBeLessThan(49.5);
      }
      for (const height of above(/Foot/)) {
        expect(height).toBeGreaterThan(-61);
        expect(height).toBeLessThan(-58.5);
      }
      const far = (s: (typeof states)[number]): number =>
        Math.hypot(s.at[0] - first.at[0], s.at[1] - first.at[1], s.at[2] - first.at[2]);
      // The blow lands on the body of her ragdoll farthest from her first (a foot, not her
      // pelvis).
      const target = [...states].sort((a, b) => far(b) - far(a))[0];
      expect(target).toBeDefined();
      if (!target) return;
      expect(far(target)).toBeGreaterThan(55);
      expect(far(bumper)).toBeGreaterThan(far(target));
      const before = target.velocity;
      expect(bodies.feedback(HULDA, [1, 0, 0], target.at)).toBe(target.node);
      // fFeedbackImpulseMult (500 game units of momentum) made Havok's: 500 / 69.99 on its mass.
      const after = bodies.bodyStates(HULDA).find((s) => s.node === target.node)?.velocity;
      const gained = (after?.[0] ?? 0) - before[0];
      expect(gained).toBeCloseTo(500 / HAVOK_SCALE / target.mass, 3);
      // A blow that lands nearest her bumper strikes the body of her ragdoll nearest there (it
      // struck the bumper, and pushed nothing).
      const struck = bodies.feedback(HULDA, [1, 0, 0], bumper.at);
      expect(states.map((state) => state.node)).toContain(struck);
      await sim.step(0.5);
      expect(bodies.feedbackGain(HULDA)).toBeLessThan(0.8);
      await sim.step(1);
      expect(bodies.feedbackGain(HULDA)).toBeCloseTo(0.3, 2);
      // The player's settings reach her drive at once (not those of her first hit).
      preferences.set('RagdollAnim:fFeedbackOnOffGain', 0.5);
      await sim.step(0.1);
      expect(bodies.feedbackGain(HULDA)).toBeCloseTo(0.5, 2);
      preferences.set('RagdollAnim:fFeedbackOnOffGain', 0.3);
      // Hit again while held: held for the full 10 s from this blow.
      expect(bodies.feedback(HULDA, [0, 1, 0], target.at)).toBe(target.node);
      await sim.step(9.5);
      expect(bodies.feedbackGain(HULDA)).toBeCloseTo(0.3, 2);
      await sim.step(1.6);
      expect(bodies.feedbackGain(HULDA)).toBe(1);
      // Turned off again, her ragdoll is no longer driven while she lives; no hit pushes it.
      preferences.set('Animation:bAlwaysDriveRagdoll', 0);
      await sim.step(0.1);
      expect(bodies.driven(HULDA)).toBeUndefined();
      expect(bodies.feedback(HULDA, [1, 0, 0], target.at)).toBeUndefined();
    }, 120_000);

    it('a blow on her get-up yields its drive; once up, the feedback is gone with the drive', async () => {
      const stage = sim.world.stage;
      const bodies = stage.bodies;
      expect(bodies.driven(HULDA)).toBeUndefined();
      expect(await stage.knockdowns.knockDown(HULDA, { direction: [1, 0, 0], force: 2 })).toBe(
        true,
      );
      // Getting up, her ragdoll is in the world, driven by the get-up's rigid body controls.
      expect(await sim.until(() => bodies.driven(HULDA)?.dynamic === true, 20)).toBe(true);
      const head = bodies.bodyStates(HULDA).find((s) => /head/i.test(s.node));
      expect(head).toBeDefined();
      if (!head) return;
      expect(bodies.feedback(HULDA, [1, 0, 0], head.at)).toBe(head.node);
      await sim.step(0.5);
      expect(bodies.feedbackGain(HULDA)).toBeLessThan(0.8);
      // Up in a few seconds: its drive over, so is its feedback (not the 11 s of the hit's).
      expect(await sim.until(() => bodies.driven(HULDA) === undefined, 8)).toBe(true);
      expect(bodies.feedbackGain(HULDA)).toBe(1);
      expect(stage.knockdowns.holds(HULDA)).toBe(false);
    }, 120_000);
  },
);
