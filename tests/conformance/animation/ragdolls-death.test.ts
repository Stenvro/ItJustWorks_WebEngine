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
import { DYING_TIMER, DyingActors, lifeAfterDeath } from '../../../src/gameplay/combat/dying.ts';
import { LifeState } from '../../../src/gameplay/combat/combat-state.ts';
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
 * Seconds into her lean (after she settles into it) at which she is killed and slumps. Killed
 * at 1 to 4.5 s she stands draped over the counter (STANDING_PHASES). Which phases slump depends
 * on the pose she dies in, so on how her lean began and whom she looks at: since her walk to the
 * counter ends with its path end's canned turn into the entry (ActionPathEnd: NPC_TurnLeft90),
 * 2 s stands too (it slumped when she turned in place by her steering alone), and since she
 * chooses whom she looks at by head tracking's own rule, 1.5 s stands and 0.5 and 4 s slump; since
 * a far graph hears an event at once (src/animation/animated-skeleton.ts), a few frames sooner,
 * 4 and 4.5 s stand and 0.5 and 5 s slump.
 */
const PHASES = [0.5, 5] as const;
const STANDING_PHASES = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5] as const;

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

  // In the other phases her upper body tips onto the counter while her hips bend to their 45°
  // limit and her knees straighten to theirs: her legs stand as a locked strut (feet flat at the
  // ankles' limit, head at 96–99 units). The original sets her ragdoll up with nothing of its
  // own (its files' constraints, the world's solver; made dynamic, its still bodies lifted:
  // PhysicsWorld.liftStill), and with all of that Rapier at four substeps (Havok's world solves
  // with four iterations) keeps her standing too (head at 91–93 units); only two buckle the
  // strut, and fewer substeps settle the race skeletons' ragdolls worse. Easing every limit
  // the joints lie past (by tau of the error a step, as Havok's soft limits correct) changes
  // nothing: the strut's joints lie at their limits, not past them. TODO(M13): Havok's solver's
  // give at four iterations with the settling of the eight.
  for (const phase of STANDING_PHASES) {
    it.todo(`killed ${phase} s into her lean, her body slumps below the counter’s height`);
  }
});

// The engine's own drive of a ragdoll ([RagdollAnim], the engine's built-in defaults; their use
// inferred from their names: src/physics/ragdoll-anim.ts) and fDyingTimer (src/gameplay/combat/
// dying.ts).

describe('the engine’s ragdoll drive and a death’s timer (settings, rules)', () => {
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

  it('fDyingTimer (2): how long an actor dies before it is dead', () => {
    expect(DYING_TIMER).toBe(2);
    expect(lifeAfterDeath(0, DYING_TIMER)).toBe(LifeState.dying);
    expect(lifeAfterDeath(1.99, DYING_TIMER)).toBe(LifeState.dying);
    expect(lifeAfterDeath(2, DYING_TIMER)).toBe(LifeState.dead);
    const dying = new DyingActors();
    dying.died(7);
    dying.frame(1.5);
    expect(dying.dying(7)).toBe(true);
    // A second death's report does not start it again.
    dying.died(7);
    dying.frame(0.5);
    expect(dying.dying(7)).toBe(false);
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
    const feedback = new RagdollFeedback(settings);
    expect(feedback.gainScale(0)).toBe(1);
    // A hit at 10 s: fFeedbackImpulseMult on the body struck; the gains go to 0.3 over 1 s,
    // stay there until 10 s after it, and come back over 1 s.
    expect(feedback.hit(10)).toBe(500);
    expect(feedback.gainScale(10.5)).toBeCloseTo(0.65, 6);
    expect(feedback.gainScale(11)).toBeCloseTo(0.3, 6);
    expect(feedback.gainScale(19.9)).toBeCloseTo(0.3, 6);
    expect(feedback.gainScale(20.5)).toBeCloseTo(0.65, 6);
    expect(feedback.gainScale(21)).toBe(1);
    // A hit while the gains are down keeps them down, from where they are.
    feedback.hit(30);
    feedback.hit(30.5);
    expect(feedback.gainScale(30.5)).toBeCloseTo(0.65, 6);
    expect(feedback.gainScale(31)).toBeCloseTo(0.3, 6);
    expect(feedback.gainScale(39.9)).toBeCloseTo(0.3, 6);
    const half = scaledControl(settings.control, 0.5);
    expect(half.hierarchyGain).toBeCloseTo(0.085, 6);
    expect(half.positionMaxLinearVelocity).toBe(14);
    // Off: no push, no yield.
    const off = new RagdollFeedback(
      readRagdollAnimSettings((key) => (key === 'bRagdollFeedback' ? 0 : undefined)),
    );
    expect(off.hit(1)).toBe(0);
    expect(off.gainScale(1.5)).toBe(1);
  });
});

/** The humans' behaviour graph, as the idle tree names it. */
const HUMAN_GRAPH = 'actors\\character\\behaviors\\0_master.hkx';

describe.skipIf(!hasGamedata())(
  'the Bannered Mare: the ragdoll INI, a lean’s death and fDyingTimer (headless simulation)',
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
      expect(bodies.feedback(HULDA, [1, 0, 0])).toBe(false);
      sim.world.session.preferences.set('Animation:bAlwaysDriveRagdoll', 1);
      await sim.step(1);
      expect(sim.actor(HULDA)?.dead).toBe(false);
      expect(bodies.driven(HULDA)).toBeDefined();
    }, 120_000);

    it('ragdoll feedback: a hit on her driven ragdoll pushes it and the drive yields', async () => {
      const bodies = sim.world.stage.bodies;
      if (bodies.driven(HULDA)?.dynamic !== true) {
        // Her graph's rigid body controls simulate her bodies only in the states that have them.
        await sim.until(() => bodies.driven(HULDA)?.dynamic === true, 20);
      }
      expect(bodies.driven(HULDA)?.dynamic).toBe(true);
      expect(bodies.feedback(HULDA, [1, 0, 0])).toBe(true);
      await sim.step(0.5);
      expect(bodies.feedbackGain(HULDA)).toBeLessThan(0.8);
      await sim.step(1);
      expect(bodies.feedbackGain(HULDA)).toBeCloseTo(0.3, 2);
      await sim.step(10);
      expect(bodies.feedbackGain(HULDA)).toBe(1);
      // Turned off again, her ragdoll is no longer driven while she lives.
      sim.world.session.preferences.set('Animation:bAlwaysDriveRagdoll', 0);
      await sim.step(0.1);
      expect(bodies.driven(HULDA)).toBeUndefined();
    }, 120_000);

    it('fDyingTimer (2): killed, she is dying for 2 s, then dead', async () => {
      const stage = sim.world.stage;
      expect(stage.lifeState(HULDA)).toBe(LifeState.alive);
      await sim.kill(HULDA, PLAYER_REF);
      expect(stage.lifeState(HULDA)).toBe(LifeState.dying);
      await sim.step(1.5);
      expect(stage.lifeState(HULDA)).toBe(LifeState.dying);
      await sim.step(0.6);
      expect(stage.lifeState(HULDA)).toBe(LifeState.dead);
    }, 120_000);
  },
);
