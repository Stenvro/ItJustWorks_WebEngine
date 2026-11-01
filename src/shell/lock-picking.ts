// What picking a lock does in the game, apart from showing it (the lockpicking menu,
// lockpicking-menu.ts, draws the lock and takes the mouse and keys; the headless simulation
// drives the same pick without a screen): whether the player may pick a lock at all (its key,
// a lock only its key opens, guards in pursuit, no lockpicks), the lock's shape for the
// player's skill and perks, the pick's sweep and the lock's turn as the rotate keys are held
// (src/gameplay/lockpicking.ts), and what opening the lock and breaking a pick do: the lock
// opens (OnLockStateChanged), Lockpicking is used (fSkillUsageLockPick<level>,
// fSkillUsageLockPickBroken), Locks Picked counts, an owned lock picked in sight is a crime and
// the story manager hears of it (crime-engine.ts lockPicked: Pick Lock), Wax Key may give the
// lock's key. Notes: docs/ui.md ("Lockpicking").

import {
  BROKEN_PICK_SKILL_USE,
  lockDifficulty,
  lockLevelMaxima,
  lockLevelSetting,
  LOCK_OPEN_ANGLE,
  LOCKPICK,
  LOCKPICK_SKILL_USES,
  lockpickSettings,
  lockpickSkillUseSetting,
  lockShape,
  lockTurnLimit,
  PICK_RANGE,
  SKELETON_KEY,
  type LockShape,
} from '../gameplay/lockpicking.ts';
import { EntryPoint } from '../gameplay/perk-entry-points.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { lockBroken } from '../scripting/runtime/natives/reference.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ActorValue } from '../world/actor-values.ts';
import type { GameSettings } from '../world/game-settings.ts';

/** Lockpicking's actor value. */
export const LOCKPICKING = ActorValue.firstSkill + 8;

/** GetPlayerAction's values for picking (those near may react). */
const PlayerAction = { lockpickSuccess: 3, lockpickBroken: 4 } as const;

/** What happens as the player opens a locked reference. */
export type LockAttempt =
  /** It is not locked. */
  | { readonly kind: 'open' }
  /** Opened with its key (sOpenWithKey). */
  | { readonly kind: 'key'; readonly key: number }
  /** Not to be picked: the game setting of the message the HUD shows. */
  | {
      readonly kind: 'refused';
      readonly setting: 'sImpossibleLock' | 'sNoLockPickIfCrimeAlert' | 'sOutOfLockpicks';
    }
  /** The lockpicking menu opens. */
  | { readonly kind: 'pick' };

/**
 * A lock the player opens: with its key if they carry it (it opens), else by picking it,
 * unless only its key opens it or it is broken (ObjectReference.IsLockBroken), guards pursue
 * the player (`pursued`), or they have no lockpick (the Skeleton Key is one), as observed in
 * the original.
 */
export async function tryLock(
  runtime: ScriptRuntime,
  reference: number,
  pursued: boolean,
): Promise<LockAttempt> {
  const lock = await runtime.lock(reference);
  if (!lock.locked) return { kind: 'open' };
  if (lock.key !== undefined && (await runtime.itemCount(PLAYER_REF, lock.key)) > 0) {
    runtime.state.reference(reference).locked = false;
    runtime.events.emit('lockChanged', { reference });
    return { kind: 'key', key: lock.key };
  }
  const tries = runtime.state.references.get(reference)?.lockTries ?? 0;
  const broken =
    tries > 0 &&
    lockBroken(tries, await runtime.perks.apply(EntryPoint.ignoreBrokenLock, PLAYER_REF, 0));
  if (lockDifficulty(lock.level) === undefined || broken)
    return { kind: 'refused', setting: 'sImpossibleLock' };
  if (pursued) return { kind: 'refused', setting: 'sNoLockPickIfCrimeAlert' };
  const picks =
    (await runtime.itemCount(PLAYER_REF, LOCKPICK)) +
    (await runtime.itemCount(PLAYER_REF, SKELETON_KEY));
  if (picks <= 0) return { kind: 'refused', setting: 'sOutOfLockpicks' };
  return { kind: 'pick' };
}

/** A lock as the player picks it: its shape and what the perks and the pick make of it. */
export interface PickSetup {
  readonly reference: number;
  /** 1 (Novice) .. 5 (Master). */
  readonly difficulty: number;
  readonly shape: LockShape;
  /** The pick is the Skeleton Key (its own model; it never breaks). */
  readonly skeletonKey: boolean;
  readonly unbreakable: boolean;
  /** The arc (degrees) about the opening the pick starts in (0: the middle of its sweep). */
  readonly startArc: number;
  /** The lock's level name (sLockVeryEasy ..). */
  readonly levelName: string;
  /** Lockpicking skill uses of opening the lock and of a pick breaking. */
  readonly skillUses: { readonly opened: number; readonly broken: number };
}

/**
 * The lock of a reference as the menu opens on it; undefined if only its key opens it. The
 * sweet spot is placed anew each time (`random`: 0..1), as observed in the original.
 */
export async function pickSetup(
  runtime: ScriptRuntime,
  settings: GameSettings,
  reference: number,
  random: () => number = Math.random,
): Promise<PickSetup | undefined> {
  const lock = await runtime.lock(reference);
  const difficulty = lockDifficulty(
    lock.level,
    lockLevelMaxima((name) => settings.number(name)),
  );
  if (difficulty === undefined) return undefined;
  const skeletonKey = (await runtime.itemCount(PLAYER_REF, SKELETON_KEY)) > 0;
  const skill = (await runtime.actors.value(PLAYER_REF, LOCKPICKING)).current;
  // The perks (Mod Lockpick Sweet Spot: the lock levels' perks by GetLockLevel on the lock,
  // Fortify Lockpicking through the skill boost perks; Make Lockpicks Unbreakable; Set
  // Lockpick Starting Arc: Locksmith).
  const perks = runtime.perks;
  const perk = await perks.apply(EntryPoint.modLockpickSweetSpot, PLAYER_REF, 1, [reference]);
  const unbreakable = (await perks.apply(EntryPoint.makeLockpicksUnbreakable, PLAYER_REF, 0)) !== 0;
  const startArc = await perks.apply(EntryPoint.setLockpickStartingArc, PLAYER_REF, 0);
  const shape = lockShape(difficulty, skill, {
    perk,
    random: random(),
    settings: lockpickSettings((name) => settings.number(name)),
    // The original counts the picks broken in the menu itself (a count of its own, not the
    // lock's), from none as it opens, and sets the sweet spot (widened by
    // fLockpickBrokenPicksMult per pick) as it shows: so with none. Breaking picks does not
    // add to the lock's own failed tries (ObjectReference.IsLockBroken).
    brokenPicks: 0,
  });
  return {
    reference,
    difficulty,
    shape,
    skeletonKey,
    unbreakable: skeletonKey || unbreakable,
    startArc,
    levelName: settings.string(lockLevelSetting(difficulty)) ?? '',
    skillUses: {
      opened:
        settings.number(lockpickSkillUseSetting(difficulty)) ??
        LOCKPICK_SKILL_USES[difficulty - 1] ??
        0,
      broken: settings.number('fSkillUsageLockPickBroken') ?? BROKEN_PICK_SKILL_USE,
    },
  };
}

/** What a step of the pick came to. */
export type PickStep = 'opened' | 'broken' | undefined;

/**
 * The pick in the lock: its angle in its sweep (0..PICK_RANGE), the lock's turn (degrees) and
 * the strain on the pick (0..1). Held, the rotate keys turn the lock at fLockRotationSpeed as
 * far as the pick allows; let go, it turns back twice as fast. Held against a pick that cannot
 * turn it further, the pick strains and breaks after the lock's time (unless unbreakable);
 * turned all the way, the lock opens.
 */
export class LockPick {
  readonly setup: PickSetup;
  pick = PICK_RANGE / 2;
  turn = 0;
  strain = 0;
  /** The lock is held at the pick's limit (the pick strains). */
  straining = false;
  opened = false;

  constructor(setup: PickSetup, random: () => number = Math.random) {
    this.setup = setup;
    if (setup.startArc > 0) {
      // Near the opening position (Locksmith: 45°): anywhere within the arc on either side of
      // it, kept where the sweet spot's middle could lie (observed in the original).
      const { center, sweetSpot } = setup.shape;
      const low = Math.max(center - setup.startArc, sweetSpot / 2);
      const high = Math.min(center + setup.startArc, PICK_RANGE - sweetSpot / 2);
      this.pick = clampPick(low + random() * Math.max(0, high - low));
    }
  }

  /** The pick moved to an angle of its sweep (the mouse); false if it stayed. */
  sweep(angle: number): boolean {
    const before = this.pick;
    this.pick = clampPick(angle);
    return this.pick !== before;
  }

  /** `seconds` of the rotate keys held (`holding`) or not, at `speed` degrees a second. */
  step(seconds: number, holding: boolean, speed: number): PickStep {
    if (this.opened) return undefined;
    const limit = lockTurnLimit(this.setup.shape, this.pick);
    this.turn = holding
      ? Math.min(limit, this.turn + speed * seconds)
      : Math.max(0, this.turn - speed * 2 * seconds);
    if (this.turn >= LOCK_OPEN_ANGLE - 0.01) {
      this.opened = true;
      this.straining = false;
      return 'opened';
    }
    this.straining = holding && this.turn >= limit - 0.01;
    if (!this.straining || this.setup.unbreakable) return undefined;
    this.strain += seconds / Math.max(0.05, this.setup.shape.breakSeconds);
    if (this.strain < 1) return undefined;
    // The next pick starts in the middle of the sweep (observed in the original).
    this.strain = 0;
    this.turn = 0;
    this.pick = PICK_RANGE / 2;
    this.straining = false;
    return 'broken';
  }
}

/**
 * The lock turned all the way: it opens (OnLockStateChanged), Lockpicking is used, Locks
 * Picked counts, an owned lock picked in sight is a crime and the story manager's Pick Lock is
 * told (crime-engine.ts lockPicked), and Wax Key may give its key.
 */
export async function lockOpened(runtime: ScriptRuntime, setup: PickSetup): Promise<void> {
  const { reference } = setup;
  runtime.playerActed(PlayerAction.lockpickSuccess);
  runtime.state.reference(reference).locked = false;
  runtime.events.emit('lockChanged', { reference });
  runtime.detach(runtime.progression.useSkill(PLAYER_REF, LOCKPICKING, setup.skillUses.opened));
  runtime.incrementStat('Locks Picked');
  await runtime.crime.lockPicked(PLAYER_REF, reference);
  await waxKey(runtime, reference);
}

/** A pick broke: one lockpick fewer, Lockpicking used; the lockpicks left. */
export async function pickBroke(runtime: ScriptRuntime, setup: PickSetup): Promise<number> {
  runtime.playerActed(PlayerAction.lockpickBroken);
  await runtime.removeItem(PLAYER_REF, runtime.formHandle(LOCKPICK), 1, true, undefined);
  await runtime.progression.useSkill(PLAYER_REF, LOCKPICKING, setup.skillUses.broken);
  return runtime.itemCount(PLAYER_REF, LOCKPICK);
}

/**
 * A lock picked open may give its key (Mod Lockpicking Key Reward Chance, percent: Wax Key,
 * always), if the player has none of it.
 */
async function waxKey(runtime: ScriptRuntime, reference: number): Promise<void> {
  const { key } = await runtime.lock(reference);
  if (key === undefined || (await runtime.itemCount(PLAYER_REF, key)) > 0) return;
  const chance = await runtime.perks.apply(
    EntryPoint.modLockpickingKeyRewardChance,
    PLAYER_REF,
    0,
    [reference],
  );
  if (Math.random() * 100 < chance)
    await runtime.addItem(PLAYER_REF, runtime.formHandle(key), 1, false);
}

function clampPick(angle: number): number {
  return Math.max(0, Math.min(PICK_RANGE, angle));
}
