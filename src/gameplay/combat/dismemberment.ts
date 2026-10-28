// Dismemberment's rules (docs/animation.md, "Dismemberment"), observed in the original: which
// limbs are gone (the engine's ExtraDismemberedLimbs), which partitions the cut piece and the body
// keep, the way a cut head flies off, and the roll a fatal hit on a limb makes. The stage cuts
// and draws (src/shell/actor-dismemberment.ts). Platform-independent.

import { BodyPartFlag, BodyPartType, type BodyPart } from '../../world/body-part-data.ts';
import type { Vec3 } from '../../render/math.ts';

/** The limb a decapitation takes (the body part data's head part). */
export const HEAD_LIMB = BodyPartType.head;

/** A limb cut off an actor, as the engine keeps it on the actor (ExtraDismemberedLimbs). */
export interface DismemberedLimb {
  /** Its body part type (BodyPartType). */
  readonly limb: number;
  /** What the actor wore as it came off (the engine's DismemberedLimb objects). */
  readonly worn: readonly number[];
}

/** Whether a limb is gone (the condition IsLimbGone). */
export function limbGone(limbs: readonly DismemberedLimb[] | undefined, limb: number): boolean {
  return limbs?.some((entry) => entry.limb === limb) === true;
}

/**
 * How a dismembered actor is dressed again as its 3D loads (docs/animation.md, Dismemberment:
 * Persistence): the engine compares what it wears with what its last cut limb's record says it
 * wore then and, if they differ, dresses it as the record says: what the record has and it does
 * not wear is put on (the decapitation armor its outfit lost; the stage only what it still
 * has, not what was looted), what it wears beyond the record is taken off. Undefined: nothing to do (no limb gone, or dressed as recorded). TODO(M13): the
 * engine's helper's exact rule (which limb's record wins, whether it takes off) is not read.
 */
export function redressing(
  limbs: readonly DismemberedLimb[] | undefined,
  worn: readonly number[],
): { readonly equip: readonly number[]; readonly unequip: readonly number[] } | undefined {
  const recorded = limbs?.at(-1)?.worn;
  if (!recorded) return undefined;
  const equip = recorded.filter((form) => !worn.includes(form));
  const unequip = worn.filter((form) => !recorded.includes(form));
  return equip.length > 0 || unequip.length > 0 ? { equip, unequip } : undefined;
}

// --- The cut piece -------------------------------------------------------------------------

/**
 * Whether the cut piece shows a partition of a worn shape cloned with it: the 100s (101-199: a
 * helmet's 130 and 131, the decapitation armor's 150, the head's cut), whatever its slots'
 * owners say; the biped slots below stay on the body, the 200s nowhere.
 */
export function pieceShowsPartition(bodyPart: number): boolean {
  return bodyPart > 100 && bodyPart < 200;
}

/**
 * Whether the head's own shapes (its FaceGen node, moved to the piece rather than cloned) keep
 * a partition there: the engine only hides on them, the partitions below 100 and the 200s (the
 * 230 neck), and leaves the others as they were drawn.
 */
export function faceKeepsPartition(bodyPart: number): boolean {
  return bodyPart >= 100 && bodyPart < 200;
}

// --- The head's flight ---------------------------------------------------------------------

/**
 * How a cut head flies off (game units a second): from the neck through the head (the head
 * node's parent to the head node), bent towards the way the killer's weapon moves (each made a
 * unit vector, added and made one again), at fDecapInitialSpeed. The head spins about that same
 * line at the same number in Havok units (speed / 69.99 radians a second). Undefined: the head
 * and neck are one point and no weapon moves.
 */
export function decapitationLaunch(
  head: Vec3,
  neck: Vec3,
  weaponVelocity: Vec3 | undefined,
  speed: number,
): Vec3 | undefined {
  const away = unit([head[0] - neck[0], head[1] - neck[1], head[2] - neck[2]]);
  const swing = weaponVelocity ? unit(weaponVelocity) : [0, 0, 0];
  const way = unit([away[0] + swing[0], away[1] + swing[1], away[2] + swing[2]]);
  if (way[0] === 0 && way[1] === 0 && way[2] === 0) return undefined;
  return [way[0] * speed, way[1] * speed, way[2] * speed];
}

function unit([x, y, z]: Vec3): Vec3 {
  const length = Math.hypot(x, y, z);
  return length <= 1e-6 ? [0, 0, 0] : [x / length, y / length, z / length];
}

// --- A fatal hit on a limb -----------------------------------------------------------------

/** WEAP DNAM's hit behavior: what a killing blow may do to a limb. */
export const WeaponHitBehavior = {
  normal: 0,
  dismemberOnly: 1,
  explodeOnly: 2,
  noDismemberOrExplode: 3,
} as const;

/** The game settings of the limb roll. */
export interface LimbRollSettings {
  /** iCombatDismemberPartChance (25). */
  readonly dismemberPartChance: number;
  /** iCombatExplodePartChance (5). */
  readonly explodePartChance: number;
}

export const LIMB_ROLL_DEFAULTS: LimbRollSettings = {
  dismemberPartChance: 25,
  explodePartChance: 5,
};

/** What a killing blow does to the limb it hit. */
export interface LimbRoll {
  readonly dismember: boolean;
  readonly explode: boolean;
}

/**
 * A killing blow on a limb (the hit's targeted part): observed in the original, only a part
 * flagged explodable rolls. An "absolute" part (its to-hit-chance-absolute flag) with an explosion
 * chance of 100 or more explodes for sure; otherwise a roll of 0-99 explodes it under its
 * explosion chance (absolute: the chance itself; else (iCombatExplodePartChance) × chance %) and
 * else dismembers it under iCombatDismemberPartChance; the weapon's hit behavior then keeps only
 * dismembering, only exploding, or neither. The engine marks the hit so and nothing more: the only
 * way a limb comes off in the executable is the Decapitate graph event, and Skyrim's hits never
 * target a part (the VATS command that would set one is Fallout's), nor does any vanilla body part
 * carry the explodable flag. Kept for the hit's flags as the engine computes them.
 */
export function rollLimb(
  part: Pick<BodyPart, 'flags' | 'explosionChance'>,
  hitBehavior: number,
  roll: number,
  settings: LimbRollSettings = LIMB_ROLL_DEFAULTS,
): LimbRoll {
  if ((part.flags & BodyPartFlag.explodable) === 0) return { dismember: false, explode: false };
  const absolute = (part.flags & BodyPartFlag.toHitChanceAbsolute) !== 0;
  if (absolute && part.explosionChance >= 100) return { dismember: false, explode: true };
  const explodeChance = absolute
    ? part.explosionChance
    : Math.trunc(settings.explodePartChance * part.explosionChance * 0.01);
  const value = Math.trunc(roll) % 100;
  let explode = value < explodeChance;
  let dismember = !explode && value < settings.dismemberPartChance;
  if (explode || dismember) {
    if (hitBehavior === WeaponHitBehavior.dismemberOnly) {
      explode = false;
      dismember = true;
    } else if (hitBehavior === WeaponHitBehavior.explodeOnly) {
      explode = true;
      dismember = false;
    } else if (hitBehavior === WeaponHitBehavior.noDismemberOrExplode) {
      explode = false;
      dismember = false;
    }
  }
  return { dismember, explode };
}
