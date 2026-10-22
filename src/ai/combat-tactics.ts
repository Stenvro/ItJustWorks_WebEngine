// How an actor fights, by its combat style (CSTY: src/ai/combat-style-records.ts; docs/ai.md,
// "Combat AI"): what it fights with (its equipment scored by the style's melee, ranged, magic,
// staff, unarmed and shout multipliers and by the range to its target), how it moves near its
// target (dueling: circling and falling back; flanking: flanking and stalking; at range: keeping
// its distance and strafing), when it attacks, power attacks and bashes (the offensive mult and
// the melee mults against a staggered, blocking, attacking or recoiling target), when it blocks
// (the defensive mult) and when it gets out of a threat's way (avoid threat chance).
//
// The style's values are what the Creation Kit edits (UESP "Skyrim Mod:Mod File Format/CSTY").
// The melee attack decision follows the engine's (docs/ai.md, "The attack decision"); the other
// rules read each multiplier as the chance or weight its name gives, at the scale its vanilla
// values have (TODO(M13)). Platform-independent.

import type { CombatAiSettings } from './combat-ai.ts';
import { CombatStyleFlag, type CombatStyle } from './combat-style-records.ts';

type Vec3 = readonly [number, number, number];

// --- What it fights with ----------------------------------------------------------------------

/** The kinds of equipment the combat style scores (CSGD equipment score mults). */
export type EquipKind = 'melee' | 'ranged' | 'magic' | 'staff' | 'unarmed' | 'shout';

/** Something an actor may fight with. */
export interface EquipOption {
  readonly kind: EquipKind;
  /** The weapon, spell or shout (undefined: its fists). */
  readonly id: number | undefined;
  /** What a blow, shot or cast deals (its damage as the menus show it). */
  readonly damage: number;
  /** How far it reaches (a melee weapon's reach, a shot's or spell's range; units). */
  readonly range: number;
  /** It is in hand (or the voice) now. */
  readonly equipped: boolean;
}

/** An option in hand is kept over one barely better (fCombatInventoryEquippedScoreBonus). */
const EQUIPPED_BONUS = 1.25;
/** A ranged option counts this little (at the least) with its target at its feet. */
const RANGED_CLOSE_FIT = 0.1;
/** An option that cannot reach its target counts this little (it would have to close). */
const OUT_OF_RANGE_FIT = 0.1;

/** The style's multiplier for a kind of equipment. */
export function equipmentMult(style: CombatStyle, kind: EquipKind): number {
  return style.general.equipmentScoreMult[kind];
}

/**
 * How well an option suits the distance to its target (0..1): a melee weapon or fists fully
 * within their reach, less the farther beyond it (to fCombatAbsoluteMaxRangeMult × the reach,
 * then little); a ranged one within its range (the one in hand fCombatCurrentWeaponAbsolute-
 * MaxRangeMult farther), less with its target closer than fCombatAdvanceOuterRadiusMax.
 */
export function rangeFit(
  option: EquipOption,
  distance: number,
  settings: CombatAiSettings,
): number {
  const range = Math.max(1, option.range);
  if (option.kind === 'melee' || option.kind === 'unarmed') {
    if (distance <= range) return 1;
    return Math.max(
      OUT_OF_RANGE_FIT,
      Math.min(1, (range * settings.absoluteMaxRangeMult) / distance) ** 2,
    );
  }
  const reach = range * (option.equipped ? settings.currentWeaponAbsoluteMaxRangeMult : 1);
  if (distance > reach) return OUT_OF_RANGE_FIT;
  const close = settings.advanceOuterRadiusMax;
  if (distance >= close) return 1;
  return RANGED_CLOSE_FIT + (1 - RANGED_CLOSE_FIT) * (distance / close) ** 2;
}

/** An option's score: its damage × the style's mult for its kind × its fit to the range. */
export function equipmentScore(
  option: EquipOption,
  distance: number,
  style: CombatStyle,
  settings: CombatAiSettings,
): number {
  return (
    Math.max(1, option.damage) *
    equipmentMult(style, option.kind) *
    rangeFit(option, distance, settings) *
    (option.equipped ? EQUIPPED_BONUS : 1)
  );
}

/** The option it fights with now: the best scored (undefined: none scores above 0). */
export function chooseEquipment(
  options: readonly EquipOption[],
  distance: number,
  style: CombatStyle,
  settings: CombatAiSettings,
): EquipOption | undefined {
  let best: { option: EquipOption; score: number } | undefined;
  for (const option of options) {
    const score = equipmentScore(option, distance, style, settings);
    if (score > 0 && (!best || score > best.score)) best = { option, score };
  }
  return best?.option;
}

// --- How it moves ---------------------------------------------------------------------------------

/**
 * What it does about the distance to its target for a while: close in (advance), circle round
 * it, fall back from it, come at it from the side (flank), keep just out of its reach before
 * closing (stalk), stand (hold), sidestep while it shoots (strafe).
 */
export type Maneuver = 'advance' | 'circle' | 'fallback' | 'flank' | 'stalk' | 'hold' | 'strafe';

export interface ManeuverInput {
  /** Horizontal distance to its target (units). */
  readonly distance: number;
  /** Its reach (melee) or the range it shoots from (ranged). */
  readonly reach: number;
  /** It fights with a bow, a spell, a staff or its voice. */
  readonly ranged: boolean;
  /** The target attacks (swings at it). */
  readonly targetAttacking: boolean;
  /** Others of its combat group fight the same target. */
  readonly allies: number;
}

/** A maneuver lasts this long (seconds, at random between). TODO(M13): the engine's times. */
export const MANEUVER_SECONDS = [1, 3] as const;

/**
 * The maneuver it takes (CSTY close range for melee, long range for ranged; the dueling and
 * flanking flags): beyond the advance radius it advances (flanking styles, with allies on the
 * target, by its flank distance's chance from the side); near, dueling styles circle (circle
 * mult) or fall back (fallback mult, more as the target swings: × the defensive mult), flanking
 * ones flank or stalk (stalk time); at range it keeps beyond fCombatAdvanceOuterRadiusMax
 * (falling back by the fallback mult) and strafes (strafe mult).
 */
export function chooseManeuver(
  style: CombatStyle,
  input: ManeuverInput,
  random: () => number,
  settings: CombatAiSettings,
): Maneuver {
  const close = style.closeRange;
  const flanking = (style.flags & CombatStyleFlag.flanking) !== 0;
  if (input.ranged) {
    if (input.distance > input.reach) return 'advance';
    if (input.distance < settings.advanceOuterRadiusMax && random() < close.fallbackMult) {
      return 'fallback';
    }
    return random() < style.longRange.strafeMult ? 'strafe' : 'hold';
  }
  const outer = input.reach + settings.advanceOuterRadiusMid;
  if (input.distance > outer) {
    if (flanking && input.allies > 0 && random() < close.flankDistance) return 'flank';
    return 'advance';
  }
  if (flanking) {
    if (random() < close.flankDistance) return 'flank';
    if (random() < close.stalkTime) return 'stalk';
    return 'advance';
  }
  const fallback =
    close.fallbackMult * (input.targetAttacking ? 1 + style.general.defensiveMult : 0.5);
  if (random() < fallback) return 'fallback';
  if (random() < close.circleMult * 0.5) return 'circle';
  return 'advance';
}

/**
 * Where a maneuver has it go now (a horizontal direction, unit or zero) from where it stands
 * towards its target: `side` (+1 clockwise, −1 the other way) for circling, flanking and
 * strafing.
 */
export function maneuverDirection(
  maneuver: Maneuver,
  from: Vec3,
  target: Vec3,
  side: number,
): readonly [number, number] {
  const dx = target[0] - from[0];
  const dy = target[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;
  const fx = dx / length;
  const fy = dy / length;
  // Clockwise seen from above: (x, y) → (y, −x).
  const rx = fy * side;
  const ry = -fx * side;
  switch (maneuver) {
    case 'advance':
      return [fx, fy];
    case 'fallback':
      return [-fx, -fy];
    case 'circle':
    case 'strafe':
      return [rx, ry];
    case 'flank': {
      const x = fx + rx;
      const y = fy + ry;
      const l = Math.hypot(x, y) || 1;
      return [x / l, y / l];
    }
    case 'stalk': {
      // Round it, drifting neither in nor out.
      return [rx, ry];
    }
    default:
      return [0, 0];
  }
}

// --- Attacks, blocks, threats ---------------------------------------------------------------------

export interface AttackInput {
  readonly targetStaggered: boolean;
  readonly targetBlocking: boolean;
  readonly targetAttacking: boolean;
  readonly targetPowerAttacking: boolean;
  readonly targetRecoiling: boolean;
  /** It blocks now (a bash is its attack from a block). */
  readonly blocking: boolean;
  /** Its race and hands can bash (its attack data has a bash). */
  readonly canBash: boolean;
  /** Its power attacks' chance (their attack data's ATKD chance; 0: none). */
  readonly powerChance: number;
  /** Others of its combat group fight the same target. */
  readonly allies: number;
  /** Its target is the player. */
  readonly targetIsPlayer: boolean;
  /** Seconds since its last attack (undefined: none yet in this fight). */
  readonly sinceLastAttack: number | undefined;
}

export type AttackChoice = 'none' | 'attack' | 'power' | 'bash' | 'powerBash';

/** A melee attack is decided this often: the combat tree's "Attack Idle" (seconds). */
export const ATTACK_DECISION_SECONDS = 0.25;

const lerp = (t: number, from: number, to: number): number => from + (to - from) * t;

/**
 * The chance it attacks at a decision (docs/ai.md, "The attack decision"): its offensive mult
 * mapped onto fCombatAttackChanceMin .. Max (against the player with others on them too, × the
 * group offensive mult per other, not below fCombatGroupOffensiveMultMin); against a staggered
 * or recoiling target × the larger of the attack and power attack staggered mults, else while it
 * blocks × fCombatAttackChanceBlockingSwingMult if the target swings, else × its defensive mult
 * mapped onto fCombatAttackChanceBlockingMultMax .. Min; and × 1 .. the last attack bonus as up
 * to fCombatAttackChanceLastAttackBonusTime passes since its last attack.
 */
export function attackChance(
  style: CombatStyle,
  input: AttackInput,
  settings: CombatAiSettings,
): number {
  const general = style.general;
  let offensive = general.offensiveMult;
  if (input.targetIsPlayer && input.allies > 0 && general.groupOffensiveMult < 1) {
    offensive *= Math.max(
      general.groupOffensiveMult ** input.allies,
      settings.groupOffensiveMultMin,
    );
  }
  let chance = lerp(offensive, settings.attackChanceMin, settings.attackChanceMax);
  if (input.targetStaggered || input.targetRecoiling) {
    chance *= Math.max(style.melee.attackStaggeredMult, style.melee.powerAttackStaggeredMult);
  } else if (input.blocking) {
    // TODO(M13): the engine skips the blocking mult for a target in one more state (unnamed).
    chance *= input.targetAttacking
      ? settings.attackChanceBlockingSwingMult
      : lerp(
          general.defensiveMult,
          settings.attackChanceBlockingMultMax,
          settings.attackChanceBlockingMultMin,
        );
  }
  if (input.sinceLastAttack !== undefined) {
    const passed = input.sinceLastAttack / settings.attackChanceLastAttackBonusTime;
    chance *= lerp(Math.min(1, Math.max(0, passed)), 1, settings.attackChanceLastAttackBonus);
  }
  return chance;
}

/** A bash from a block is tried this often (× the bash mults). TODO(M13). */
const BASH_CHANCE = 0.25;

/**
 * Whether and how it attacks now (a decision every ATTACK_DECISION_SECONDS): blocking, it may
 * bash by the bash mult (× bash attack mult as the target swings, bash power attack mult as it
 * power attacks, bash recoil mult as it recoils); else it attacks by attackChance; a power
 * attack by its attack data's chance (× power attack staggered mult on a staggered, power
 * attack blocking mult on a blocking target).
 */
export function chooseAttack(
  style: CombatStyle,
  input: AttackInput,
  random: () => number,
  settings: CombatAiSettings,
): AttackChoice {
  const melee = style.melee;
  const power = (): boolean =>
    random() <
    input.powerChance *
      (input.targetStaggered
        ? melee.powerAttackStaggeredMult
        : input.targetBlocking
          ? melee.powerAttackBlockingMult
          : 1);
  if (input.blocking && input.canBash) {
    const reason = input.targetPowerAttacking
      ? melee.bashPowerAttackMult
      : input.targetAttacking
        ? melee.bashAttackMult
        : input.targetRecoiling
          ? melee.bashRecoilMult
          : 1;
    if (random() < BASH_CHANCE * melee.bashMult * reason) return power() ? 'powerBash' : 'bash';
  }
  if (random() >= attackChance(style, input, settings)) return 'none';
  return power() ? 'power' : 'attack';
}

/**
 * Seconds between a shot's or a cast's decisions: the more offensive, the sooner. TODO(M13):
 * the combat tree's ranged and magic idles (melee: ATTACK_DECISION_SECONDS).
 */
export function attackInterval(style: CombatStyle, random: () => number): number {
  const offensive = Math.min(1, Math.max(0, style.general.offensiveMult));
  return (0.4 + random() * 0.8) * (1.5 - offensive);
}

/**
 * Whether it blocks a blow coming (the target swings at it within reach): by the defensive mult,
 * × fCombatBlockChanceWeaponMult blocking with a weapon rather than a shield.
 */
export function choosesBlock(
  style: CombatStyle,
  shield: boolean,
  random: () => number,
  settings: CombatAiSettings,
): boolean {
  const chance = style.general.defensiveMult * (shield ? 1 : settings.blockChanceWeaponMult);
  return random() < chance;
}

/** Something coming at an actor: a shot's or a breath's line. */
export interface Threat {
  /** The same object for the same threat from frame to frame (each is weighed once). */
  readonly key: object;
  /** Where it is now and the way it goes (units a second). */
  readonly position: Vec3;
  readonly velocity: Vec3;
  /** How wide it is (units). */
  readonly radius: number;
  /** Whose it is (an actor does not dodge its own). */
  readonly source: number | undefined;
}

/** A threat is dodged when it would arrive within this (seconds). TODO(M13). */
const THREAT_HORIZON = 1.2;

/**
 * Whether a threat comes at an actor (a body of `radius` standing at `feet`, `height` tall):
 * its line passes within the body and arrives within THREAT_HORIZON. Returns the seconds until
 * it does (undefined: it does not).
 */
export function threatens(
  threat: Threat,
  feet: Vec3,
  radius: number,
  height: number,
): number | undefined {
  const [vx, vy, vz] = threat.velocity;
  const speed2 = vx * vx + vy * vy + vz * vz;
  if (speed2 < 1) return undefined;
  const center: Vec3 = [feet[0], feet[1], feet[2] + height / 2];
  const wx = center[0] - threat.position[0];
  const wy = center[1] - threat.position[1];
  const wz = center[2] - threat.position[2];
  const t = (wx * vx + wy * vy + wz * vz) / speed2;
  if (t < 0 || t > THREAT_HORIZON) return undefined;
  const cx = threat.position[0] + vx * t - center[0];
  const cy = threat.position[1] + vy * t - center[1];
  const cz = threat.position[2] + vz * t - center[2];
  const miss = Math.hypot(cx, cy, Math.max(0, Math.abs(cz) - height / 2));
  return miss <= radius + threat.radius ? t : undefined;
}

/** Whether it gets out of a threat's way (CSGD avoid threat chance). */
export function avoidsThreat(style: CombatStyle, random: () => number): boolean {
  return random() < style.general.avoidThreatChance;
}

/** The way out of a threat's line: sideways from it, to the side the actor already is on. */
export function dodgeDirection(threat: Threat, feet: Vec3): readonly [number, number] {
  const [vx, vy] = threat.velocity;
  const length = Math.hypot(vx, vy) || 1;
  const ux = vx / length;
  const uy = vy / length;
  // The side of the line the actor is on (cross product's sign).
  const wx = feet[0] - threat.position[0];
  const wy = feet[1] - threat.position[1];
  const side = ux * wy - uy * wx >= 0 ? 1 : -1;
  return [-uy * side, ux * side];
}

// --- Its other casting and its potions ---------------------------------------------------------

/** What an actor in combat can do for itself now (read from its spells, items and state). */
export interface SupportState {
  /** Its health, magicka and stamina as shares of their maximum. */
  readonly health: number;
  readonly magicka: number;
  readonly stamina: number;
  /** Seconds since it last healed itself or drank a potion. */
  readonly sinceRestore: number;
  /** It has a healing spell it has the magicka for. */
  readonly canHeal: boolean;
  /** It carries a potion restoring Health, Magicka, Stamina. */
  readonly potions: {
    readonly health: boolean;
    readonly magicka: boolean;
    readonly stamina: boolean;
  };
  /** It fights with magic and has no attack spell it has the magicka for. */
  readonly outOfMagicka: boolean;
  /** It has a summoning spell it can cast, and none of its summons stands. */
  readonly canSummon: boolean;
  /** It has a buff (a Self spell: armour, cloak) it can cast that is not on it. */
  readonly canBuff: boolean;
  /** A spell or breath comes at it, and it has a ward it can cast. */
  readonly canWard: boolean;
}

/** One thing it does for itself: a ward, a heal, a potion, a summons or a buff. */
export type SupportChoice =
  | { readonly kind: 'ward' | 'heal' | 'summon' | 'buff' }
  | { readonly kind: 'potion'; readonly value: 'health' | 'magicka' | 'stamina' };

/**
 * What an actor in combat does for itself now, if anything, in this order: a ward against a
 * spell coming at it; below iAICombatRestoreHealthPercentage of its health its healing spell,
 * else a Health potion, and a Magicka potion below iAICombatRestoreMagickaPercentage of its
 * magicka or when its magic fails it for want of magicka (at most one restore every
 * fCombatItemRestoreTimer seconds); a summons when none of its stands;
 * a buff not on it. TODO(M13): the engine's order and its thresholds for magicka and stamina
 * (a Stamina potion here below the same share as health) are not documented.
 */
export function chooseSupport(
  state: SupportState,
  settings: Pick<
    CombatAiSettings,
    'restoreHealthPercent' | 'restoreMagickaPercent' | 'itemRestoreTime'
  >,
): SupportChoice | undefined {
  if (state.canWard) return { kind: 'ward' };
  const threshold = settings.restoreHealthPercent / 100;
  const restore = state.sinceRestore >= settings.itemRestoreTime;
  if (restore && state.health < threshold) {
    if (state.canHeal) return { kind: 'heal' };
    if (state.potions.health) return { kind: 'potion', value: 'health' };
  }
  const magickaLow = state.magicka < settings.restoreMagickaPercent / 100;
  if (restore && (state.outOfMagicka || magickaLow) && state.potions.magicka)
    return { kind: 'potion', value: 'magicka' };
  if (restore && state.stamina < threshold && state.potions.stamina)
    return { kind: 'potion', value: 'stamina' };
  if (state.canSummon) return { kind: 'summon' };
  if (state.canBuff) return { kind: 'buff' };
  return undefined;
}
