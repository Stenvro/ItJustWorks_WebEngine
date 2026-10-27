// The engine's own packages, those no record holds (docs/ai.md, "The engine's own packages"):
// the engine creates one and puts it in front of the actor's package (ActorPackages.push); as
// it ends the actor's packages are chosen again. Platform-independent.
//
// Avoid Player, observed in the original (behaviour only, in our words):
// - **Its start.** The player's swing of a melee weapon, bow shot or projectile spell (the
//   actions whose comments are SwingMeleeWeapon, ShootBow, PlayerCastProjectileSpell) gives it to
//   each actor within fTriggerAvoidPlayerDistance (400) of the player that detects them and is
//   in no combat, as the comment on the action is picked.
// - **Its procedure.** While the player is within fAvoidPlayerDistance (100) of the actor, it
//   goes to a spot away from them; once they are farther, a short timer runs out and it ends.
//
// Inferred, TODO(M13): the spot's rule (here: on the player's far side, twice
// fAvoidPlayerDistance from them, turned up to 60° either way where the straight one is not
// walkable), the timer's length (AVOID_LINGER), the gait (it runs), which other conditions the
// start weighs beyond detection and combat.

import type { AiSettings } from './ai-settings.ts';
import type { EnginePackage, EngineRunner } from './package-runtime.ts';

type Vec3 = readonly [number, number, number];

const PLAYER = 0x14;
/** It looks again this often (real seconds). */
const STEP = 0.25;
/** The player this long beyond fAvoidPlayerDistance, it ends (real seconds; ours). */
const AVOID_LINGER = 1;
/** Within this of its spot it is there (units; ours). */
const ARRIVE = 32;
/** The turns tried for its spot when the straight one is not walkable (radians). */
const TURNS = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3];

/** The player's actions that start Avoid Player near them (their comments' subtypes). */
export const AVOID_PLAYER_ACTIONS: ReadonlySet<string> = new Set(['SWMW', 'FIWE', 'PCPS']);

/**
 * Whether an actor takes Avoid Player from the player's action: within
 * fTriggerAvoidPlayerDistance of them, detecting them, in no combat.
 */
export function avoidsPlayer(
  distance: number,
  detects: boolean,
  inCombat: boolean,
  trigger: number,
): boolean {
  return distance < trigger && detects && !inCombat;
}

/** The spot away from the player: on their far side, `reach` from them. */
export function awayFrom(here: Vec3, player: Vec3, reach: number, turn = 0): Vec3 {
  const dx = here[0] - player[0];
  const dy = here[1] - player[1];
  const length = Math.hypot(dx, dy);
  const [ux, uy] = length > 1e-6 ? [dx / length, dy / length] : [0, 1];
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return [
    player[0] + (ux * cos - uy * sin) * reach,
    player[1] + (ux * sin + uy * cos) * reach,
    here[2],
  ];
}

/** Avoid Player: out of the player's way while they are near, then it ends. */
export const avoidPlayer: EngineRunner = async (run) => {
  const reach = run.settings.avoidPlayerDistance;
  let clear = 0;
  while (!run.stopped()) {
    const here = run.body.position();
    const player = run.mind.livePosition?.(PLAYER);
    if (!here || !player) return;
    if (Math.hypot(here[0] - player[0], here[1] - player[1]) >= reach) {
      clear += STEP;
      if (clear >= AVOID_LINGER) return;
      await run.wait(STEP);
      continue;
    }
    clear = 0;
    let spot: Vec3 | undefined;
    for (const turn of TURNS) {
      const point = awayFrom(here, player, reach * 2, turn);
      spot = run.mind.walkable ? run.mind.walkable(run.actor, point) : point;
      if (spot) break;
    }
    if (!spot) {
      await run.wait(STEP);
      continue;
    }
    await run.body.travel(spot, 'run', ARRIVE);
    await run.wait(STEP);
  }
};

// --- Warnings ------------------------------------------------------------------------------------
//
// Steal Warning, observed in the original (behaviour only, in our words):
// - **Its start.** A theft by the player that its owner sees (the owner alive, detecting them,
//   free to act) of anything but a horse, while the player has had fewer than iStealWarnings (2)
//   warnings: the owner is given a Steal Warning aimed at the player, and the theft is no crime.
//   Each warning counts one more; the first starts the player's warning timer at fWarningTimer
//   (5 s). Once the warnings are used up, the next theft seen is the crime.
// - **Its end.** It ends once the owner has not seen the player for fWarningTimer.
// - Pickpocket Warning: the engine builds it as the steal warning (its own count beside it), but
//   nothing starts it and iPickPocketWarnings is never read: a pickpocket caught is the crime at
//   once. Ours keeps the procedure for it (warnThief) and starts it nowhere, as the engine.
//
// Inferred, TODO(M13): the timer's effect (ours: the warnings are forgotten once it runs out),
// the owner's way up to them (ours: within WARN_REACH, at a walk), its line (ours: the crime's
// own, Steal for a guard, StealFromNC else), and which thefts the engine lets warn.

/** The owner comes this near the thief to warn them (units; ours). */
const WARN_REACH = 150;
/** It gives up coming up after this many tries (ours). */
const WARN_TRIES = 4;

const flat = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** The heading (about z from +y) from one point to another. */
const headingTo = (from: Vec3, to: Vec3): number => Math.atan2(to[0] - from[0], to[1] - from[1]);

/**
 * Steal Warning, Pickpocket Warning: the owner comes up to the thief (its target), turns to
 * them and says `line`, then watches them for fWarningTimer before its own package goes on.
 */
export function warnThief(line: string): EngineRunner {
  return async (run) => {
    const thief = run.target ?? PLAYER;
    for (let tries = 0; !run.stopped(); tries++) {
      const here = run.body.position();
      const there = run.mind.livePosition?.(thief);
      if (!here || !there) return;
      if (flat(here, there) <= WARN_REACH) break;
      if (tries >= WARN_TRIES) return;
      await run.body.travel([there[0], there[1], there[2]], 'walk', WARN_REACH);
    }
    const here = run.body.position();
    const there = run.mind.livePosition?.(thief);
    if (run.stopped() || !here || !there) return;
    run.body.face(headingTo(here, there));
    await run.body.say(line, { target: thief });
    await run.wait(run.settings.warningTimer);
  };
}

/**
 * The player's steal warnings (the engine keeps the count and its timer on the player): whether
 * a theft its owner sees is warned rather than the crime.
 */
export class StealWarnings {
  #count = 0;
  /** When the warnings are forgotten (real seconds), once the first was given. */
  #until: number | undefined;

  /** The warnings given and not yet forgotten. */
  get count(): number {
    return this.#count;
  }

  /**
   * Whether a theft seen at `now` (real seconds) may be warned: fewer than iStealWarnings given
   * (those older than the timer forgotten); false: the warnings are used up, it is the crime.
   */
  due(now: number, settings: Pick<AiSettings, 'stealWarnings'>): boolean {
    if (this.#until !== undefined && now >= this.#until) {
      this.#count = 0;
      this.#until = undefined;
    }
    return this.#count < settings.stealWarnings;
  }

  /** A warning was given at `now`: one more, the timer started with the first. */
  give(now: number, settings: Pick<AiSettings, 'warningTimer'>): void {
    this.#count++;
    this.#until ??= now + settings.warningTimer;
  }
}

// --- Getting up, surfacing, reacting -------------------------------------------------------------

/** Get Up From Chair Or Bed: it gets out of the furniture it is in; then its package goes on. */
export const getUpFromChairBed: EngineRunner = async (run) => {
  await run.body.leaveFurniture();
};

/**
 * The engine packages an actor may take in its furniture (it looks from its seat); the others
 * get it up first, as Get Up From Chair Or Bed does. The engine puts a created package with a
 * flag allowing it from furniture (Actor::PutCreatedPackage's allowFromFurniture, CommonLibSSE);
 * TODO(M13): which packages it allows was not read, nor what makes the Get Up package itself (no
 * maker of it was found among the package factory's callers: the engine's packages leave
 * furniture as they start, as ours do).
 */
const FROM_FURNITURE: ReadonlySet<EnginePackage> = new Set([
  'reactToDestroyedObject',
  'getUpFromChairBed',
]);

/** An engine package's procedure, the actor got up from its furniture first where it must. */
export function upFirst(kind: EnginePackage, runner: EngineRunner): EngineRunner {
  if (FROM_FURNITURE.has(kind)) return runner;
  return async (run) => {
    await getUpFromChairBed(run);
    if (!run.stopped()) await runner(run);
  };
}

/** How long an actor looks at an object destroyed near it (real seconds; ours). */
const REACT_SECONDS = 3;

/**
 * React To Destroyed Object: it turns to the object destroyed (its target) and looks at it a
 * while. TODO(M13): the engine's start (ours: those near that see it), its length and idle.
 */
export const reactToDestroyedObject: EngineRunner = async (run) => {
  const here = run.body.position();
  const there = run.target === undefined ? undefined : run.mind.livePosition?.(run.target);
  if (!here || !there) return;
  run.body.face(headingTo(here, there));
  await run.wait(REACT_SECONDS);
};

/** Within this of the surface its head is out (units; ours). */
const SURFACE_REACH = 32;

// Surface, its start observed in the original (behaviour only, in our words): an NPC whose
// head is under water (at least HEAD_UNDER of it submerged) and who does not breathe water
// (WaterBreathing 0) uses up its breath, fActorSwimBreathBase + fActorSwimBreathMult × 50
// seconds (35) at the most. Each update, once the breath left is less than one and a half times
// the time it takes to rise to the surface at its speed (its depth: the water's height over its
// feet) plus a second, it is given Surface, unless it runs that already. Only the player drowns
// (the engine's damage and drowning sound are the player's): an NPC surfaces first.
// Inferred, TODO(M13): its breath refills at once with its head out (the engine sets it
// elsewhere); its speed is its run's (the engine asks its movement speed).

/** At least this share of the actor under water, its head is under (the engine's). */
export const HEAD_UNDER = 0.875;
/** The skill the engine weighs an NPC's breath by (fActorSwimBreathMult × this). */
const NPC_BREATH_SKILL = 50;

/** An NPC's breath under water: when it must surface. */
export class Breath {
  #left: number | undefined;

  /** The breath left (seconds; undefined: full). */
  get left(): number | undefined {
    return this.#left;
  }

  /**
   * One update of `seconds`: `under` its head is under water (and it does not breathe water),
   * `depth` below the surface (its feet), rising at `speed` (units per second). True: it must
   * surface now (asked again every update while it does not).
   */
  step(
    seconds: number,
    under: boolean,
    depth: number,
    speed: number,
    settings: Pick<AiSettings, 'swimBreathBase' | 'swimBreathMult'>,
  ): boolean {
    const most = NPC_BREATH_SKILL * settings.swimBreathMult + settings.swimBreathBase;
    if (!under) {
      this.#left = undefined;
      return false;
    }
    const left = Math.max(0, Math.min(most, this.#left ?? most) - seconds);
    this.#left = left;
    const rise = speed > 0 ? Math.max(0, depth) / speed : Infinity;
    return left < rise * 1.5 + 1;
  }
}

/**
 * Surface: a swimmer under water rises straight up to the surface (`surface`: the water's
 * height above it), then its package goes on. TODO(M13): whether the engine heads for air
 * elsewhere (under a ceiling of ice).
 */
export function surfaceTo(surface: (actor: number) => number | undefined): EngineRunner {
  return async (run) => {
    const here = run.body.position();
    const top = surface(run.actor);
    if (!here || top === undefined || here[2] >= top - SURFACE_REACH) return;
    await run.body.travel([here[0], here[1], top], 'run', SURFACE_REACH);
  };
}

/**
 * Movement Blocked (only while bUseMovementBlockedPackage:General is on; its built-in value is
 * off, so vanilla never makes it): it stands while others keep it from going on, `seconds`
 * (fMaxTimeBlockedByActors), then its package goes on and searches its way again. TODO(M13):
 * what the engine's procedure does beyond standing.
 */
export function movementBlocked(seconds: number): EngineRunner {
  return async (run) => {
    run.body.stop();
    await run.wait(seconds);
  };
}
