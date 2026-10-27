// How an actor fights, by its combat style (CSTY: src/ai/combat-style-records.ts; docs/ai.md,
// "Combat AI"): what it fights with (its equipment scored by the style's melee, ranged, magic,
// staff, unarmed and shout multipliers and by the range to its target), how it moves near its
// target (dueling: circling and falling back; flanking: flanking and stalking; at range: keeping
// its distance and strafing), when it attacks, power attacks and bashes (the offensive mult and
// the melee mults against a staggered, blocking, attacking or recoiling target), when it blocks
// (the defensive mult) and when it gets out of a threat's way (avoid threat chance).
//
// The style's values are what the Creation Kit edits (UESP "Skyrim Mod:Mod File Format/CSTY").
// The engine reads each on a scale of its own game settings (docs/ai.md, "Style values"): a
// chance, distance or time is its Min + the value × (Max − Min), the advance radii, the optimal
// range and the block time a three-point curve of the defensive mult against the offensive one.
// The melee attack decision follows the engine's (docs/ai.md, "The attack decision"); where a
// rule's conditions are not known yet (the combat tree's selectors) it is marked TODO(M13).
// Platform-independent.

import type { CombatAiSettings } from './combat-ai.ts';
import { CombatStyleFlag, type CombatStyle } from './combat-style-records.ts';

type Vec3 = readonly [number, number, number];

const lerp = (t: number, from: number, to: number): number => from + (to - from) * t;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

// --- Style values on the engine's scale -------------------------------------------------------

/**
 * A value on the engine's three-point curve (the advance radii, the optimal range, the block
 * time): `min` at −1, `mid` at 0, `max` at 1, linear between (and beyond, unclamped).
 */
export function curve(t: number, min: number, mid: number, max: number): number {
  return t > 0 ? mid + (max - mid) * t : min + (mid - min) * (t + 1);
}

/** Whom it fights, as the group offensive mult weighs it. */
export interface Opponent {
  /** Its target is the player. */
  readonly targetIsPlayer: boolean;
  /** Others of its combat group fight the same target. */
  readonly allies: number;
}

/**
 * Its offensive mult as the engine weighs it: the style's; against the player while others
 * attack them too, × the style's group offensive mult once per other (when below 1), not below
 * fCombatGroupOffensiveMultMin.
 */
export function offensiveMult(
  style: CombatStyle,
  opponent: Opponent,
  settings: CombatAiSettings,
): number {
  const general = style.general;
  if (!opponent.targetIsPlayer || opponent.allies <= 0 || general.groupOffensiveMult >= 1) {
    return general.offensiveMult;
  }
  return (
    general.offensiveMult *
    Math.max(general.groupOffensiveMult ** opponent.allies, settings.groupOffensiveMultMin)
  );
}

/** Its chance to circle its target in reach (CSCR circle mult on fCombatCircleChanceMin .. Max). */
export function circleChance(style: CombatStyle, settings: CombatAiSettings): number {
  return lerp(style.closeRange.circleMult, settings.circleChanceMin, settings.circleChanceMax);
}

/**
 * Its chance to circle its target from afar (the combat tree's Circle Distant: the circle mult on
 * fCombatCircleDistantChanceMin .. Max). TODO(M13): phase 5, the behaviour itself.
 */
export function circleDistantChance(style: CombatStyle, settings: CombatAiSettings): number {
  return lerp(
    style.closeRange.circleMult,
    settings.circleDistantChanceMin,
    settings.circleDistantChanceMax,
  );
}

/** Its chance to fall back (CSCR fallback mult on fCombatFallbackChanceMin .. Max). */
export function fallbackChance(style: CombatStyle, settings: CombatAiSettings): number {
  return lerp(
    style.closeRange.fallbackMult,
    settings.fallbackChanceMin,
    settings.fallbackChanceMax,
  );
}

/** How far beyond its reach a flanking actor goes round its target (CSCR flank distance, units). */
export function flankDistance(style: CombatStyle, settings: CombatAiSettings): number {
  return lerp(
    style.closeRange.flankDistance,
    settings.flankingDistanceMin,
    settings.flankingDistanceMax,
  );
}

/** How long a flanking actor stalks its target (CSCR stalk time, seconds). */
export function stalkTime(style: CombatStyle, settings: CombatAiSettings): number {
  return lerp(
    style.closeRange.stalkTime,
    settings.flankingStalkTimeMin,
    settings.flankingStalkTimeMax,
  );
}

/** Its chance to strafe while it shoots (CSLR strafe mult on fCombatStrafeChanceMin .. Max). */
export function strafeChance(style: CombatStyle, settings: CombatAiSettings): number {
  return lerp(style.longRange.strafeMult, settings.strafeChanceMin, settings.strafeChanceMax);
}

/** Its chance to dodge a threat (CSGD avoid threat chance on fCombatDodgeChanceMin .. Max). */
export function dodgeChance(style: CombatStyle, settings: CombatAiSettings): number {
  return lerp(style.general.avoidThreatChance, settings.dodgeChanceMin, settings.dodgeChanceMax);
}

/**
 * Its chance of a special attack (CSME special attack mult on fCombatSpecialAttackChanceMin ..
 * Max). TODO(M13): phase 5, the combat tree's Special Attack.
 */
export function specialAttackChance(style: CombatStyle, settings: CombatAiSettings): number {
  return lerp(
    style.melee.specialAttackMult,
    settings.specialAttackChanceMin,
    settings.specialAttackChanceMax,
  );
}

/**
 * Its chance to block (the defensive mult on fCombatBlockChanceMin .. Max), ×
 * fCombatBlockChanceWeaponMult blocking with a weapon rather than a shield.
 */
export function blockChance(
  style: CombatStyle,
  shield: boolean,
  settings: CombatAiSettings,
): number {
  const chance = lerp(
    style.general.defensiveMult,
    settings.blockChanceMin,
    settings.blockChanceMax,
  );
  return shield ? chance : chance * settings.blockChanceWeaponMult;
}

/**
 * Its chance to block an attack coming (the defensive mult on fCombatBlockAttackChanceMin ..
 * Max). TODO(M13): phase 5, the combat tree's Block Attack (a block timed to a swing).
 */
export function blockAttackChance(style: CombatStyle, settings: CombatAiSettings): number {
  return lerp(
    style.general.defensiveMult,
    settings.blockAttackChanceMin,
    settings.blockAttackChanceMax,
  );
}

/**
 * How long a block lasts (seconds): the defensive mult (0 .. 1 read as −1 .. 1) on the curve
 * fCombatBlockTimeMin, Mid, Max (4, 8, 10000: a defensive style holds its block).
 */
export function blockTime(style: CombatStyle, settings: CombatAiSettings): number {
  return curve(
    style.general.defensiveMult * 2 - 1,
    settings.blockTimeMin,
    settings.blockTimeMid,
    settings.blockTimeMax,
  );
}

/**
 * The farthest it wants to shoot from (units): the defensive mult less the offensive one on the
 * curve fCombatMaximumOptimalRangeMin, Mid, Max (a cautious archer keeps farther).
 */
export function maxOptimalRange(
  style: CombatStyle,
  opponent: Opponent,
  settings: CombatAiSettings,
): number {
  return curve(
    style.general.defensiveMult - offensiveMult(style, opponent, settings),
    settings.maximumOptimalRangeMin,
    settings.maximumOptimalRangeMid,
    settings.maximumOptimalRangeMax,
  );
}

/** How far beyond its reach it advances from (outer) and closes to (inner) (units). */
export interface AdvanceRadii {
  readonly inner: number;
  readonly outer: number;
}

export interface AdvanceInput extends Opponent {
  readonly targetStaggered: boolean;
  /** Its own melee reach and its target's (units). */
  readonly reach: number;
  readonly targetReach: number;
  /** Seconds since it was last hurt (undefined: not in this fight). */
  readonly sinceDamaged: number | undefined;
}

/** The advance radii of a style that neither hangs back nor presses (the curves' middle). */
export function middleRadii(settings: CombatAiSettings): AdvanceRadii {
  return { inner: settings.advanceInnerRadiusMid, outer: settings.advanceOuterRadiusMid };
}

/**
 * Its advance radii: the defensive mult (× fCombatAdvanceRadiusStaggerMult against a staggered
 * target: 0, it presses) less the offensive one on the curves fCombatAdvanceInnerRadiusMin, Mid,
 * Max and fCombatAdvanceOuterRadiusMin, Mid, Max. A defensive one keeps its wider radii only
 * while it was hurt within fCombatAdvanceLastDamagedThreshold and the two reaches differ by no
 * more than its inner radius; else the middle ones. (The engine compares the target's reach
 * with one of the attacker's distances, read here as its reach: inferred.)
 */
export function advanceRadii(
  style: CombatStyle,
  input: AdvanceInput,
  settings: CombatAiSettings,
): AdvanceRadii {
  const defensive =
    style.general.defensiveMult * (input.targetStaggered ? settings.advanceRadiusStaggerMult : 1);
  const t = defensive - offensiveMult(style, input, settings);
  const inner = curve(
    t,
    settings.advanceInnerRadiusMin,
    settings.advanceInnerRadiusMid,
    settings.advanceInnerRadiusMax,
  );
  const outer = curve(
    t,
    settings.advanceOuterRadiusMin,
    settings.advanceOuterRadiusMid,
    settings.advanceOuterRadiusMax,
  );
  if (t > 0) {
    const unhurt =
      input.sinceDamaged === undefined || input.sinceDamaged > settings.advanceLastDamagedThreshold;
    if (unhurt || Math.abs(input.reach - input.targetReach) > inner) return middleRadii(settings);
  }
  return { inner, outer };
}

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
  /** A spell or staff cast as long as it is held (MGEF casting type concentration). */
  readonly concentration?: boolean;
}

/**
 * An option in hand is kept over one barely better. The engine adds
 * fCombatInventoryEquippedScoreBonus (0.1) to its own score; ours is on another scale (damage
 * × the style's mult), so this is ours. TODO(M13): phase 5, the engine's equipment score.
 */
const EQUIPPED_BONUS = 1.25;

/** The style's multiplier for a kind of equipment. */
export function equipmentMult(style: CombatStyle, kind: EquipKind): number {
  return style.general.equipmentScoreMult[kind];
}

/**
 * How long what it took up is kept before it weighs again (fCombatInventoryMinEquipTime*:
 * Weapon for a melee weapon or a bow, Magic, Shout, Staff, Default for its fists).
 */
export function minEquipTime(kind: EquipKind | undefined, settings: CombatAiSettings): number {
  switch (kind) {
    case 'melee':
    case 'ranged':
      return settings.minEquipTimeWeapon;
    case 'magic':
      return settings.minEquipTimeMagic;
    case 'shout':
      return settings.minEquipTimeShout;
    case 'staff':
      return settings.minEquipTimeStaff;
    default:
      return settings.minEquipTimeDefault;
  }
}

/**
 * How well an option suits the distance to its target (0..1): a melee weapon or fists fully
 * within their reach, less the farther beyond it (to fCombatAbsoluteMaxRangeMult × the reach,
 * then fCombatInventoryMaxRangeScoreMult); a ranged one within its range (the one in hand
 * fCombatCurrentWeaponAbsoluteMaxRangeMult farther; beyond it
 * fCombatInventoryMaxRangeScoreMult), less with its target closer than
 * fCombatAdvanceOuterRadiusMax (down to fCombatInventoryMinRangeScoreMult at its feet).
 * TODO(M13): phase 5, the engine's curve (its ranges' bonuses, its least range).
 */
export function rangeFit(
  option: EquipOption,
  distance: number,
  settings: CombatAiSettings,
): number {
  const range = Math.max(1, option.range);
  const beyond = settings.inventoryMaxRangeScoreMult;
  if (option.kind === 'melee' || option.kind === 'unarmed') {
    if (distance <= range) return 1;
    return Math.max(beyond, Math.min(1, (range * settings.absoluteMaxRangeMult) / distance) ** 2);
  }
  const reach = range * (option.equipped ? settings.currentWeaponAbsoluteMaxRangeMult : 1);
  if (distance > reach) return beyond;
  const close = settings.advanceOuterRadiusMax;
  if (distance >= close) return 1;
  const least = settings.inventoryMinRangeScoreMult;
  return least + (1 - least) * (distance / close) ** 2;
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

/**
 * The spell its left hand takes up beside a one-handed weapon (the engine's equip choice fills
 * a free left hand): with a one-handed weapon (WeaponType 1..4) in its right hand and its left
 * hand free (no shield, no weapon there), the best scored of its spells (equipmentScore);
 * undefined to leave the hand be. TODO(M13): whether the engine weighs the left hand's spell on
 * its own scale (ours: the same score as the right hand's options).
 */
export function leftHandSpell(
  hands: {
    readonly weaponType: number;
    readonly shield: boolean;
    readonly leftWeapon: boolean;
  },
  spells: readonly EquipOption[],
  distance: number,
  style: CombatStyle,
  settings: CombatAiSettings,
): number | undefined {
  const oneHanded = hands.weaponType >= 1 && hands.weaponType <= 4;
  if (!oneHanded || hands.shield || hands.leftWeapon) return undefined;
  let best: { id: number; score: number } | undefined;
  for (const option of spells) {
    if (option.kind !== 'magic' || option.id === undefined) continue;
    const score = equipmentScore(option, distance, style, settings);
    if (score > 0 && (!best || score > best.score)) best = { id: option.id, score };
  }
  return best?.id;
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
  /** Where its blow reaches the target (melee: its reach and the target's radius), or its range. */
  readonly reach: number;
  /** It fights with a bow, a spell, a staff or its voice. */
  readonly ranged: boolean;
  /** Others of its combat group fight the same target. */
  readonly allies: number;
  /** Its maneuver until now. */
  readonly previous: Maneuver;
  /** Melee: its advance radii (advanceRadii; else the middle ones). */
  readonly radii?: AdvanceRadii;
  /** Ranged: the farthest it wants to shoot from (maxOptimalRange; else its range). */
  readonly optimalRange?: number;
}

/**
 * A maneuver lasts this long (seconds, at random between); a stalk its style's stalk time.
 * TODO(M13): phase 5, the combat tree's behaviours end by their own rules.
 */
export const MANEUVER_SECONDS = [1, 3] as const;

/** How long a maneuver lasts (seconds). */
export function maneuverTime(
  style: CombatStyle,
  maneuver: Maneuver,
  random: () => number,
  settings: CombatAiSettings,
): number {
  if (maneuver === 'stalk') return stalkTime(style, settings);
  return lerp(random(), MANEUVER_SECONDS[0], MANEUVER_SECONDS[1]);
}

/**
 * The maneuver it takes (CSTY close range for melee, long range for ranged; the dueling and
 * flanking flags). Melee: beyond its outer advance radius past its reach it advances (flanking
 * styles with allies on the target flank); within, dueling styles fall back (fallbackChance) or
 * circle (circleChance), else advance; flanking ones stalk (for their stalk time), then flank
 * with allies on the target, else advance. Ranged: beyond the farthest it wants to shoot from it
 * advances; closer than fCombatAdvanceOuterRadiusMax it may fall back (fallbackChance); else it
 * strafes (strafeChance) or holds. TODO(M13): phase 5, the conditions of the combat tree's
 * close, flanking and ranged movement selectors.
 */
export function chooseManeuver(
  style: CombatStyle,
  input: ManeuverInput,
  random: () => number,
  settings: CombatAiSettings,
): Maneuver {
  const flanking = (style.flags & CombatStyleFlag.flanking) !== 0;
  if (input.ranged) {
    if (input.distance > Math.min(input.reach, input.optimalRange ?? input.reach)) return 'advance';
    if (
      input.distance < settings.advanceOuterRadiusMax &&
      random() < fallbackChance(style, settings)
    ) {
      return 'fallback';
    }
    // The Strafe Selector (observed in the original: Strafe, Circle, else Ranged Movement Idle).
    if (random() < strafeChance(style, settings)) return 'strafe';
    return random() < circleChance(style, settings) ? 'circle' : 'hold';
  }
  const radii = input.radii ?? middleRadii(settings);
  if (input.distance > input.reach + radii.outer) {
    return flanking && input.allies > 0 ? 'flank' : 'advance';
  }
  if (flanking) {
    if (input.previous !== 'stalk' && input.previous !== 'flank') return 'stalk';
    return input.previous === 'stalk' && input.allies > 0 ? 'flank' : 'advance';
  }
  if (random() < fallbackChance(style, settings)) return 'fallback';
  if (random() < circleChance(style, settings)) return 'circle';
  return 'advance';
}

/**
 * Where a maneuver has it go now (a horizontal direction, unit or zero) from where it stands
 * towards its target: `side` (+1 clockwise, −1 the other way) for circling, flanking and
 * strafing; a flank makes for the point a quarter round the target ahead of it, `flankRadius`
 * from the target (so it swings round its side at that distance).
 */
export function maneuverDirection(
  maneuver: Maneuver,
  from: Vec3,
  target: Vec3,
  side: number,
  flankRadius = 0,
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
      const x = target[0] + rx * flankRadius - from[0];
      const y = target[1] + ry * flankRadius - from[1];
      const l = Math.hypot(x, y);
      return l < 1 ? [0, 0] : [x / l, y / l];
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

export interface AttackInput extends Opponent {
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
  /** Seconds since its last attack (undefined: none yet in this fight). */
  readonly sinceLastAttack: number | undefined;
}

export type AttackChoice =
  'none' | 'attack' | 'power' | 'bash' | 'powerBash' | 'special' | 'offensiveBash';

/** An attack is decided this often: the combat tree's "Attack Idle" (and its ranged and cast idles; seconds). */
export const ATTACK_DECISION_SECONDS = 0.25;

/**
 * The chance it attacks at a decision (docs/ai.md, "The attack decision"): its offensive mult
 * (offensiveMult) mapped onto fCombatAttackChanceMin .. Max; against a staggered or recoiling
 * target × the larger of the attack and power attack staggered mults, else while it blocks ×
 * fCombatAttackChanceBlockingSwingMult if the target swings, else × its defensive mult mapped
 * onto fCombatAttackChanceBlockingMultMax .. Min; and × 1 .. the last attack bonus as up to
 * fCombatAttackChanceLastAttackBonusTime passes since its last attack.
 */
export function attackChance(
  style: CombatStyle,
  input: AttackInput,
  settings: CombatAiSettings,
): number {
  let chance = lerp(
    offensiveMult(style, input, settings),
    settings.attackChanceMin,
    settings.attackChanceMax,
  );
  if (input.targetStaggered || input.targetRecoiling) {
    chance *= Math.max(style.melee.attackStaggeredMult, style.melee.powerAttackStaggeredMult);
  } else if (input.blocking) {
    // TODO(M13): the engine skips the blocking mult for a target in one more state (unnamed).
    chance *= input.targetAttacking
      ? settings.attackChanceBlockingSwingMult
      : lerp(
          style.general.defensiveMult,
          settings.attackChanceBlockingMultMax,
          settings.attackChanceBlockingMultMin,
        );
  }
  if (input.sinceLastAttack !== undefined) {
    const passed = input.sinceLastAttack / settings.attackChanceLastAttackBonusTime;
    chance *= lerp(clamp01(passed), 1, settings.attackChanceLastAttackBonus);
  }
  return chance;
}

/**
 * The style's bash mult for what the target does: × bash recoil mult as it recoils, else × bash
 * power attack mult as it power attacks, × bash attack mult as it swings, ×
 * fCombatBashTargetBlockingMult (0) as it blocks. TODO(M13): the engine also asks that the
 * blocking target faces it.
 */
function bashMult(style: CombatStyle, input: AttackInput, settings: CombatAiSettings): number {
  const melee = style.melee;
  if (input.targetRecoiling) return melee.bashMult * melee.bashRecoilMult;
  if (input.targetPowerAttacking) return melee.bashMult * melee.bashPowerAttackMult;
  if (input.targetAttacking) return melee.bashMult * melee.bashAttackMult;
  if (input.targetBlocking) return melee.bashMult * settings.bashTargetBlockingMult;
  return melee.bashMult;
}

/** Its chance to bash from a block: its defensive mult on fCombatBashChanceMin .. Max × bashMult. */
export function bashChance(
  style: CombatStyle,
  input: AttackInput,
  settings: CombatAiSettings,
): number {
  return (
    lerp(style.general.defensiveMult, settings.bashChanceMin, settings.bashChanceMax) *
    bashMult(style, input, settings)
  );
}

/**
 * Its chance of an offensive bash (the block raised to bash): its offensive mult on
 * fCombatOffensiveBashChanceMin .. Max × bashMult. TODO(M13): phase 5, the combat tree's
 * Offensive Bash.
 */
export function offensiveBashChance(
  style: CombatStyle,
  input: AttackInput,
  settings: CombatAiSettings,
): number {
  return (
    lerp(
      offensiveMult(style, input, settings),
      settings.offensiveBashChanceMin,
      settings.offensiveBashChanceMax,
    ) * bashMult(style, input, settings)
  );
}

/**
 * Whether and how it attacks now (a decision every ATTACK_DECISION_SECONDS): blocking, it may
 * bash (bashChance); else it attacks by attackChance; a power attack by its attack data's chance
 * (× power attack staggered mult on a staggered, power attack blocking mult on a blocking target).
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
  if (input.blocking && input.canBash && random() < bashChance(style, input, settings)) {
    return power() ? 'powerBash' : 'bash';
  }
  if (random() >= attackChance(style, input, settings)) return 'none';
  if (power()) return 'power';
  // Else the offensive bash (not blocking: its block raised to bash, offensiveBashChance), the
  // special attack (the tree's Special Attack, by its chance) or a normal attack.
  // TODO(M13): which attack data the special attack plays (here a power attack).
  if (!input.blocking && input.canBash && random() < offensiveBashChance(style, input, settings)) {
    return 'offensiveBash';
  }
  if (random() < specialAttackChance(style, settings) * SPECIAL_ATTACK_SHARE) return 'special';
  return 'attack';
}

/**
 * The share of the special attack chance one attack decision takes (ours: the style's chance
 * spread over its attacks; TODO(M13): the engine's).
 */
export const SPECIAL_ATTACK_SHARE = 0.1;

/**
 * The angle (radians) its target may be off its facing for an attack to start: the attack's own
 * angle (its attack data's ATKD strike angle, degrees; 0: none, the default below) ×
 * fCombatAttackStrikeAngleMult, × fCombatAttackMovingStrikeAngleMult while it moves.
 */
export function attackStrikeAngle(
  strikeAngle: number,
  moving: boolean,
  settings: CombatAiSettings,
): number {
  const degrees = strikeAngle > 0 ? strikeAngle : DEFAULT_STRIKE_ANGLE;
  return (
    ((degrees * Math.PI) / 180) *
    settings.attackStrikeAngleMult *
    (moving ? settings.attackMovingStrikeAngleMult : 1)
  );
}

/** Degrees: an attack without attack data's strike angle (TODO(M13): the engine's default). */
const DEFAULT_STRIKE_ANGLE = 45;

/**
 * The wait before its next attack decision after an attack (its attack data's recovery time,
 * at least the attack idle). TODO(M13): the engine's per-attack cooldown rule.
 */
export function attackCooldown(recoveryTime: number): number {
  return Math.max(ATTACK_DECISION_SECONDS, recoveryTime);
}

// --- Blocking -------------------------------------------------------------------------------------

/** How near (the gap past the attacker's reach, units) a blow starts a block: by its defensive mult. */
export function blockStartDistance(style: CombatStyle, settings: CombatAiSettings): number {
  return lerp(
    style.general.defensiveMult,
    settings.blockStartDistanceMin,
    settings.blockStartDistanceMax,
  );
}

/** Its block is held while its target stays within this (units): by its defensive mult. */
export function blockStopDistance(style: CombatStyle, settings: CombatAiSettings): number {
  return lerp(
    style.general.defensiveMult,
    settings.blockStopDistanceMin,
    settings.blockStopDistanceMax,
  );
}

/**
 * The sustained block: once up, a block is held (its block time not run out) while its target
 * stays within the stop distance and does not back off faster than
 * fCombatBlockMaxTargetRetreatVelocity, even between the blows.
 */
export function holdsBlock(
  input: { readonly distance: number; readonly targetRetreatSpeed: number },
  style: CombatStyle,
  settings: CombatAiSettings,
): boolean {
  return (
    input.distance <= blockStopDistance(style, settings) &&
    input.targetRetreatSpeed <= settings.blockMaxTargetRetreatVelocity
  );
}

/**
 * The block attack's opening (the shield bash out of a block): its target within the bash reach
 * × fCombatBlockAttackReachMult and within the strike angle × fCombatBlockAttackStrikeAngleMult.
 */
export function blockAttackOpening(
  input: { readonly distance: number; readonly off: number; readonly strikeAngle: number },
  settings: CombatAiSettings,
): boolean {
  return (
    input.distance <= settings.bashReach * settings.blockAttackReachMult &&
    input.off <= input.strikeAngle * settings.blockAttackStrikeAngleMult
  );
}

export interface ShotInput extends Opponent {
  /** Seconds since its last attack (undefined: none yet in this fight). */
  readonly sinceLastAttack: number | undefined;
}

/**
 * The chance it draws its bow at a decision: its offensive mult on fCombatRangedAttackChanceMin
 * .. Max, after its first attack plus up to fCombatRangedAttackChanceLastAttackBonus of itself
 * as fCombatRangedAttackChanceLastAttackBonusTime passes since the last.
 */
export function rangedAttackChance(
  style: CombatStyle,
  input: ShotInput,
  settings: CombatAiSettings,
): number {
  const chance = lerp(
    offensiveMult(style, input, settings),
    settings.rangedAttackChanceMin,
    settings.rangedAttackChanceMax,
  );
  if (input.sinceLastAttack === undefined) return chance;
  const passed = clamp01(input.sinceLastAttack / settings.rangedAttackChanceLastAttackBonusTime);
  return chance + chance * settings.rangedAttackChanceLastAttackBonus * passed;
}

/**
 * The chance it casts its offensive spell (or staff) at a decision: its offensive mult on
 * fCombatCastImmediateOffensiveMagicChanceMin .. Max, a concentration spell's on
 * fCombatCastConcentrationOffensiveMagicChanceMin .. Max.
 */
export function castChance(
  style: CombatStyle,
  opponent: Opponent,
  concentration: boolean,
  settings: CombatAiSettings,
): number {
  const offensive = offensiveMult(style, opponent, settings);
  return concentration
    ? lerp(offensive, settings.castConcentrationChanceMin, settings.castConcentrationChanceMax)
    : lerp(offensive, settings.castImmediateChanceMin, settings.castImmediateChanceMax);
}

/**
 * How long it holds its bow drawn before it looses (seconds): at random from
 * fCombatRangedAttackHoldTimeAbsoluteMin up to its offensive mult on
 * fCombatRangedAttackHoldTimeMax .. Min (the more offensive, the sooner); a target within
 * fCombatRangedAttackHoldTimeMinDistance past the two bodies' radii gets the shortest.
 */
export function bowHoldTime(
  style: CombatStyle,
  input: Opponent & { readonly distance: number; readonly radii: number },
  random: () => number,
  settings: CombatAiSettings,
): number {
  const close = input.distance < settings.rangedAttackHoldTimeMinDistance + input.radii;
  const most = lerp(
    close ? 1 : offensiveMult(style, input, settings),
    settings.rangedAttackHoldTimeMax,
    settings.rangedAttackHoldTimeMin,
  );
  return lerp(random(), settings.rangedAttackHoldTimeAbsoluteMin, most);
}

/** Whether it blocks a blow coming (the target swings at it within reach): blockChance. */
export function choosesBlock(
  style: CombatStyle,
  shield: boolean,
  random: () => number,
  settings: CombatAiSettings,
): boolean {
  return random() < blockChance(style, shield, settings);
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

/**
 * A threat is dodged when it would arrive within this (seconds). TODO(M13): phase 5, the
 * engine's threat model (its fCombatThreat* settings: view cone, reaction, anticipation).
 */
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

/** Whether it gets out of a threat's way (dodgeChance). */
export function avoidsThreat(
  style: CombatStyle,
  random: () => number,
  settings: CombatAiSettings,
): boolean {
  return random() < dodgeChance(style, settings);
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

/**
 * The share of its health (magicka) below which it restores it: its defensive mult on
 * fCombatRestoreHealthPercentMin .. Max (fCombatRestoreMagickaPercentMin .. Max). The engine
 * restores no other value (no stamina potions in combat).
 */
export function restoreShare(
  style: CombatStyle,
  value: 'health' | 'magicka',
  settings: CombatAiSettings,
): number {
  const defensive = style.general.defensiveMult;
  return value === 'health'
    ? lerp(defensive, settings.restoreHealthPercentMin, settings.restoreHealthPercentMax)
    : lerp(defensive, settings.restoreMagickaPercentMin, settings.restoreMagickaPercentMax);
}

/** What an actor in combat can do for itself now (read from its spells, items and state). */
export interface SupportState {
  /** Its health and magicka as shares of their maximum. */
  readonly health: number;
  readonly magicka: number;
  /** Seconds since it last restored its health, its magicka. */
  readonly sinceHealthRestore: number;
  readonly sinceMagickaRestore: number;
  /** It has a healing spell it has the magicka for. */
  readonly canHeal: boolean;
  /** It carries a potion restoring Health, Magicka. */
  readonly potions: {
    readonly health: boolean;
    readonly magicka: boolean;
  };
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
  | { readonly kind: 'potion'; readonly value: 'health' | 'magicka' };

/**
 * What an actor in combat does for itself now, if anything, in this order: a ward against a
 * spell coming at it; below its health's restore share (restoreShare) its healing spell, else a
 * Health potion, not within fCombatRestoreHealthRestrictTime of the last; below its magicka's a
 * Magicka potion, not within fCombatRestoreMagickaRestrictTime; a summons when none of its
 * stands; a buff not on it. TODO(M13): phase 5, the order of the combat tree's casters.
 */
export function chooseSupport(
  state: SupportState,
  style: CombatStyle,
  settings: CombatAiSettings,
): SupportChoice | undefined {
  if (state.canWard) return { kind: 'ward' };
  if (
    state.health < restoreShare(style, 'health', settings) &&
    state.sinceHealthRestore >= settings.restoreHealthRestrictTime
  ) {
    if (state.canHeal) return { kind: 'heal' };
    if (state.potions.health) return { kind: 'potion', value: 'health' };
  }
  if (
    state.potions.magicka &&
    state.magicka < restoreShare(style, 'magicka', settings) &&
    state.sinceMagickaRestore >= settings.restoreMagickaRestrictTime
  ) {
    return { kind: 'potion', value: 'magicka' };
  }
  if (state.canSummon) return { kind: 'summon' };
  if (state.canBuff) return { kind: 'buff' };
  return undefined;
}
