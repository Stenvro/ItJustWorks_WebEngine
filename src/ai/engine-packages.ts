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
import { sameSpace } from './package-start.ts';
import type { EngineRun, EnginePackage, EngineRunner } from './package-runtime.ts';
import { fleeSafe } from './procedure-runs.ts';

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
 * get it up first. The engine puts a created package with a flag allowing it from furniture
 * (Actor::PutCreatedPackage's allowFromFurniture, CommonLibSSE).
 * TODO(M13): which packages it allows was not read.
 */
const FROM_FURNITURE: ReadonlySet<EnginePackage> = new Set([
  'reactToDestroyedObject',
  'getUpFromChairBed',
]);

/**
 * The Get Up package's maker: whether putting an engine package on an actor in furniture puts
 * Get Up From Chair Or Bed in front of it first (the package asked for runs once it stands, as
 * an engine package of its own). Inferred, TODO(M13): no other maker of the Get Up package was
 * found among the package factory's callers (observed in the original), so it is taken to be
 * made where a created package not allowed from furniture is put on a seated actor; the actor's
 * own packages leave furniture as their procedures start, and combat as it starts to fight.
 */
export function getsUpFirst(kind: EnginePackage): boolean {
  return !FROM_FURNITURE.has(kind);
}

// --- Feeding: Vampire Feed and Cannibal ------------------------------------------------------------

/** The feeding packages (CommonLibSSE PACKAGE_TYPE kVampireFeed, kCannibal). */
export type FeedingPackage = 'vampireFeed' | 'cannibal';

/** What a feeding procedure does to the game: its start, whether it lasts, its end. */
export interface Feeding {
  /** It feeds now: GetVampireFeed (GetCannibal) holds, the feeding idle plays on the target. */
  begin(): void;
  /** Whether it still feeds (its graph's end, or its longest, ends it). */
  feeding(): boolean;
  /** It feeds no more (the package ended or was left). */
  end(): void;
}

/** A feeding asks this often whether it is over (real seconds; ours). */
const FEED_STEP = 0.1;

/**
 * Vampire Feed and Cannibal: the packages Actor.StartVampireFeed and Actor.StartCannibal make
 * and put in front of the feeder's own (CommonLibSSE PACKAGE_TYPE kVampireFeed and kCannibal:
 * created packages, as Avoid Player). The feeder gets up first (no feeding from furniture),
 * turns to its target and feeds: the feeding idle plays on the target, and the package runs
 * as long as the feeding lasts, ending with it. Inferred, TODO(M13): the procedures' own steps
 * (turning to the target; no walk to it: the perks offer the feed within activation reach) and
 * when the original ends them (ours: the feeder's clip's NPCVampireFeedEnd, else the longest
 * feeding: natives/actor.ts).
 */
export function feedOn(feeding: Feeding): EngineRunner {
  return async (run) => {
    const here = run.body.position();
    const there = run.target === undefined ? undefined : run.mind.livePosition?.(run.target);
    if (here && there) run.body.face(headingTo(here, there));
    feeding.begin();
    try {
      while (!run.stopped() && feeding.feeding()) await run.wait(FEED_STEP);
    } finally {
      feeding.end();
    }
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
  /** How long its head has been under water (seconds). */
  under = 0;

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
      this.under = 0;
      return false;
    }
    this.under += seconds;
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

// --- Summons ---------------------------------------------------------------------------------------
//
// Follow Commander: an actor someone commands (a summon, a raised corpse, a commanded creature:
// the magic system's commander) and that fights no one follows its commander, as summons do in
// the original (UESP "Skyrim:Conjuration": the summoned creature follows its caster). Most summons
// carry no package of their own (the vanilla summon bases: no PKID, or their template's), so the
// engine's own following moves them. The band is fSummonedCreatureMinFollowDist (250) to
// fSummonedCreatureMaxFollowDist (400).
//
// Inferred, TODO(M13): how the engine uses the band (ours: farther than the maximum it makes for a
// spot the minimum from its commander, on its own side, running; within it stands facing them),
// and whether a commanded actor's own packages run instead where it has some.

/** It looks again this often while near enough (real seconds; ours). */
const FOLLOW_LOOK = 0.5;

/** The spot `reach` from the leader toward the follower (on the follower's side). */
export function followSpot(here: Vec3, leader: Vec3, reach: number): Vec3 {
  const dx = here[0] - leader[0];
  const dy = here[1] - leader[1];
  const length = Math.hypot(dx, dy);
  const [ux, uy] = length > 1e-6 ? [dx / length, dy / length] : [0, -1];
  return [leader[0] + ux * reach, leader[1] + uy * reach, leader[2]];
}

/**
 * Whether a follower `distance` from its commander makes for it: beyond
 * fSummonedCreatureMaxFollowDist.
 */
export function followsUp(
  distance: number,
  settings: Pick<AiSettings, 'summonedMaxFollowDist'>,
): boolean {
  return distance > settings.summonedMaxFollowDist;
}

/** Follow Commander: near its commander (the target) while it fights no one. */
export const followCommander: EngineRunner = async (run) => {
  const leader = run.target;
  if (leader === undefined) return;
  while (!run.stopped()) {
    const here = run.body.position();
    const there = run.mind.livePosition?.(leader);
    if (!here || !there) return;
    if (!followsUp(flat(here, there), run.settings)) {
      run.body.face(headingTo(here, there));
      await run.wait(FOLLOW_LOOK);
      continue;
    }
    const spot = followSpot(here, there, run.settings.summonedMinFollowDist);
    const walkable = run.mind.walkable ? run.mind.walkable(run.actor, spot) : spot;
    await run.body.travel(walkable ?? [there[0], there[1], there[2]], 'run', ARRIVE);
    await run.wait(STEP);
  }
};

// --- Crime: Alarm and the criminal's Flee ----------------------------------------------------------
//
// A crime the guards answer (docs/gameplay.md, "Crimes and witnesses"; the stage:
// src/shell/actor-crime.ts). An NPC's: each guard that answers it (one that witnessed it, else
// the first guard of the crime's faction or its crime group to hear the alarm;
// iNumberGuardsCrimeResponse at most) is given Alarm aimed at the criminal, and the criminal,
// fighting no one, is given Flee aimed at the first of them (the engine's own kAlarm and kFlee
// packages, CommonLibSSE PACKAGE_TYPE). The player's: the guard that arrests them, and one that
// is to attack them but only heard the alarm, are given Alarm aimed at them.
// - **Alarm.** It runs to where the criminal is now, heading anew as the criminal gets away from
//   the spot it heads for, and calls after it now and then (the topic subtype PursueIdleTopic:
//   DialogueCrimeGuards' "Stop, in the name of the Jarl!", the orc strongholds' "Halt,
//   outlander!"). Once it has the criminal before it (it detects it; for an arrest also within
//   the greeting distance, fAIMinGreetingDistance) it confronts it: it starts combat with it
//   (the combat AI takes it on) and the package ends, or it arrests the player with its force
//   greet (the dialogue quest's ForceGreet topic, whose lines ask GetAlarmed: an actor on its
//   Alarm is alarmed) and stays on the package until the arrest is over. It gives up once the
//   criminal is dead, in another cell or worldspace, gone from the stage, or not confronted in
//   ALARM_SECONDS.
// - **Flee.** The criminal runs from the guard, counting as fleeing (IsFleeing), until it has
//   been beyond fFleeDoneDistanceExterior (inside: fFleeDoneDistanceInterior) of it for
//   fFleeIsSafeTimer (the Flee procedure's rule: procedure-runs.ts fleeSafe), running off again
//   whenever the guard comes nearer; the guard dead or in another space, it is over. Caught, the
//   guard's combat takes it on (it fights or flees by its confidence, the combat AI's).
//
// Inferred, TODO(M13): the original's two procedures were not followed: the Alarm's way to the
// criminal (ours: its live position, as the alarm tells where the crime was), its giving up
// (ALARM_SECONDS), how often it calls (ALARM_CALL_SECONDS), that a fight starts from wherever it
// detects the criminal and that the force greet is the package's own step, Flee's spot (ours: on the far side of the guard, the done distance from it,
// turned up to 60° where the straight one is not walkable) and whether it flees only a guard it
// detects (ours: as the guard answers).

/** The Alarm runs to within this of the criminal (units; ours). */
const ALARM_REACH = 128;
/** The criminal this far from the spot the Alarm heads for, it heads anew (units; ours). */
const ALARM_RETARGET = 256;
/** The Alarm gives up after this long without confronting the criminal (real seconds; ours). */
export const ALARM_SECONDS = 60;
/** A pursuing guard calls after the criminal this often (real seconds; ours). */
export const ALARM_CALL_SECONDS = 8;
/** The pursuit's lines: the topic subtype PursueIdleTopic. */
const PURSUE_IDLE = 'PURS';
/** A fleeing criminal looks again this often whether it is safe (real seconds; ours). */
const FLEE_LOOK = 0.5;
/** It runs off again at most this often in one flight before it holds where it got to (ours). */
const FLEE_TRIES = 8;

/** Where a reference is now for one going after it or away from it: undefined if dead or elsewhere. */
async function presentAt(run: EngineRun, reference: number): Promise<Vec3 | undefined> {
  if (run.mind.alive && !(await run.mind.alive(reference))) return undefined;
  const [self, other] = await Promise.all([
    run.mind.placement(run.actor),
    run.mind.placement(reference),
  ]);
  if (self?.space && other?.space && !sameSpace(self.space, other.space)) return undefined;
  return run.mind.livePosition?.(reference) ?? other?.position;
}

/** What the Alarm asks the stage: detection, and what the guard does about the criminal. */
export interface AlarmHooks {
  /** Whether the actor detects the other now. */
  detects(actor: number, other: number): boolean;
  /**
   * How near the criminal the guard has to be to confront it (units): an arrest's force greet
   * needs it within the greeting distance; undefined: from wherever it detects it (a fight).
   */
  reach?(actor: number, other: number): number | undefined;
  /**
   * The guard has the criminal before it: it fights it (the combat AI takes it from here) or
   * arrests it (its force greet). The package lasts as long as this does: the guard stays on
   * its Alarm through the arrest's conversation.
   */
  confront(actor: number, other: number): void | Promise<void>;
}

/** Whether the Alarm has the criminal before it: detected, and within the reach asked for. */
export function alarmConfronts(
  detects: boolean,
  distance: number,
  reach: number | undefined,
): boolean {
  return detects && (reach === undefined || distance <= reach);
}

/**
 * Alarm: the guard goes after the criminal (its target), calling out as it pursues
 * (PursueIdleTopic), and confronts it once it has it before it.
 */
export function alarmPackage(hooks: AlarmHooks): EngineRunner {
  return async (run) => {
    const criminal = run.target;
    if (criminal === undefined) return;
    let leg: { goal: Vec3; done: boolean } | undefined;
    const halt = (): void => {
      if (leg && !leg.done && !run.stopped()) run.body.stop();
    };
    let called = 0;
    for (let searched = 0; !run.stopped(); searched += STEP) {
      const there = await presentAt(run, criminal);
      const here = run.body.position();
      if (!there || !here || searched >= ALARM_SECONDS || run.stopped()) {
        halt();
        return;
      }
      const distance = flat(here, there);
      const reach = hooks.reach?.(run.actor, criminal);
      if (alarmConfronts(hooks.detects(run.actor, criminal), distance, reach)) {
        halt();
        run.body.face(headingTo(here, there));
        await hooks.confront(run.actor, criminal);
        return;
      }
      const arrive = Math.min(ALARM_REACH, reach ?? ALARM_REACH);
      const near = distance <= arrive;
      if (!near && (!leg || leg.done || flat(leg.goal, there) > ALARM_RETARGET)) {
        halt();
        const current = { goal: there, done: false };
        leg = current;
        const arrived = (): void => {
          current.done = true;
        };
        void run.body.travel([there[0], there[1], there[2]], 'run', arrive).then(arrived, arrived);
      } else if (near) {
        run.body.face(headingTo(here, there));
      }
      // It calls after the one it pursues, now and then.
      if (!near && searched >= called) {
        called = searched + ALARM_CALL_SECONDS;
        void run.body.say(PURSUE_IDLE, { target: criminal });
      }
      await run.wait(STEP);
    }
  };
}

/** Flee: the criminal runs from the guard answering its crime (its target) until it is safe. */
export const fleeFrom: EngineRunner = async (run) => {
  const threat = run.target;
  if (threat === undefined) return;
  run.body.fleeing?.(true);
  try {
    const own = await run.mind.placement(run.actor);
    const interior = own?.space?.kind === 'interior';
    const done = interior
      ? run.settings.fleeDoneDistanceInterior
      : run.settings.fleeDoneDistanceExterior;
    let safeFor = 0;
    let tries = 0;
    while (!run.stopped()) {
      const here = run.body.position();
      const from = await presentAt(run, threat);
      if (!here || !from) return;
      const distance = flat(here, from);
      if (fleeSafe(distance, safeFor, interior, run.settings)) return;
      if (distance >= done) {
        await run.wait(FLEE_LOOK);
        safeFor += FLEE_LOOK;
        continue;
      }
      safeFor = 0;
      let spot: Vec3 | undefined;
      if (tries < FLEE_TRIES) {
        tries++;
        for (const turn of TURNS) {
          const point = awayFrom(here, from, done + ARRIVE, turn);
          spot = run.mind.walkable ? run.mind.walkable(run.actor, point) : point;
          if (spot) break;
        }
      }
      if (spot) await run.body.travel(spot, 'run', ARRIVE);
      else await run.wait(FLEE_LOOK);
    }
  } finally {
    run.body.fleeing?.(false);
  }
};
