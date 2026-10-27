import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { COMBAT_AI_DEFAULTS, readCombatAiSettings } from './combat-ai.ts';
import { CombatStyleFlag, parseCombatStyle, type CombatStyle } from './combat-style-records.ts';
import {
  advanceRadii,
  attackChance,
  avoidsThreat,
  bashChance,
  blockAttackChance,
  blockChance,
  blockTime,
  bowHoldTime,
  castChance,
  chooseAttack,
  chooseEquipment,
  chooseManeuver,
  leftHandSpell,
  chooseSupport,
  choosesBlock,
  circleChance,
  circleDistantChance,
  curve,
  dodgeChance,
  dodgeDirection,
  fallbackChance,
  flankDistance,
  maneuverDirection,
  maneuverTime,
  maxOptimalRange,
  minEquipTime,
  offensiveBashChance,
  offensiveMult,
  rangedAttackChance,
  rangeFit,
  restoreShare,
  specialAttackChance,
  stalkTime,
  strafeChance,
  threatens,
  type AttackInput,
  type EquipOption,
  type ManeuverInput,
  type SupportState,
  type Threat,
} from './combat-tactics.ts';

const settings = COMBAT_AI_DEFAULTS;
const f32s = (...values: number[]): Uint8Array => new Uint8Array(Float32Array.from(values).buffer);
const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);

/** A combat style from its general, melee and close range values (CSGD, CSME, CSCR, CSLR). */
function style(
  general: number[],
  melee: number[] = [1, 1, 1, 1, 1, 1, 1, 0.1],
  close: number[] = [0.2, 0.2, 0.2, 0.2],
  flags: number = CombatStyleFlag.dueling,
  strafe = 0.2,
): CombatStyle {
  return parseCombatStyle({
    formId: 1,
    editorId: 'csTest',
    flags: 0,
    fields: new Fields([
      { type: 'CSGD', data: f32s(...general) },
      { type: 'CSME', data: f32s(...melee) },
      { type: 'CSCR', data: f32s(...close) },
      { type: 'CSLR', data: f32s(strafe) },
      { type: 'DATA', data: u32s(flags) },
    ]),
  });
}

// csHumanMeleeLvl1 and csHumanMissile's general values (Skyrim.esm), the order of CSGD:
// offensive, defensive, group offensive, melee, magic, ranged, shout, unarmed, staff, avoid.
const melee = style([0.32, 0.11, 0.41, 1, 1, 1, 1, 1, 1, 0.2]);
const archer = style([0.34, 0.24, 0.61, 0.83, 1, 3.2, 1, 1, 1, 0.2]);
const duel = style([0.5, 0.5, 1, 1, 1, 1, 1, 1, 1, 0.2], undefined, [0.8, 0.6, 0.2, 0.2]);
const wolf = style(
  [0.75, 0.09, 0.74, 1, 1, 1, 1, 1, 1, 0.2],
  undefined,
  [0, 0.15, 0.5, 0.4],
  CombatStyleFlag.flanking,
);
const guard = style([0.2, 0.8, 1, 1, 1, 1, 1, 1, 1, 0.2]);
const alone = { targetIsPlayer: false, allies: 0 };

/** A random source that gives these values in turn (then 0.5). */
const randoms = (...values: number[]): (() => number) => {
  let i = 0;
  return () => values[i++] ?? 0.5;
};

const sword: EquipOption = { kind: 'melee', id: 1, damage: 10, range: 141, equipped: true };
const bow: EquipOption = { kind: 'ranged', id: 2, damage: 10, range: 4096, equipped: false };
const fists: EquipOption = {
  kind: 'unarmed',
  id: undefined,
  damage: 4,
  range: 96,
  equipped: false,
};

describe('combat tactics: style values on the engine’s scale', () => {
  it('reads a three-point curve: least at −1, middle at 0, most at 1', () => {
    expect(curve(-1, 1, 2, 4)).toBe(1);
    expect(curve(-0.5, 1, 2, 4)).toBe(1.5);
    expect(curve(0, 1, 2, 4)).toBe(2);
    expect(curve(0.5, 1, 2, 4)).toBe(3);
    expect(curve(1, 1, 2, 4)).toBe(4);
  });

  it('maps each chance onto its fCombat…ChanceMin .. Max', () => {
    // Circle 0.8 on 0 .. 0.75, circle distant on 0.25 .. 0.75, fallback 0.6 on 0 .. 0.5.
    expect(circleChance(duel, settings)).toBeCloseTo(0.6);
    expect(circleDistantChance(duel, settings)).toBeCloseTo(0.65);
    expect(fallbackChance(duel, settings)).toBeCloseTo(0.3);
    // Strafe 0.2 on 0 .. 0.75; avoid threat 0.2 on 0 .. 1; special attack 0.1 on 0 .. 1.
    expect(strafeChance(archer, settings)).toBeCloseTo(0.15);
    expect(dodgeChance(melee, settings)).toBeCloseTo(0.2);
    expect(specialAttackChance(melee, settings)).toBeCloseTo(0.1);
    // Block and block attack: the defensive mult on 0 .. 1.
    expect(blockChance(guard, true, settings)).toBeCloseTo(0.8);
    expect(blockChance(guard, false, settings)).toBeCloseTo(0.2);
    expect(blockAttackChance(guard, settings)).toBeCloseTo(0.8);
    // A load order's setting moves the scale.
    const narrow = readCombatAiSettings((name) =>
      name === 'fCombatCircleChanceMax' ? 0.5 : undefined,
    );
    expect(circleChance(duel, narrow)).toBeCloseTo(0.4);
  });

  it('reads flank distance as a distance and stalk time as a time', () => {
    // Flank distance 0.5 on fCombatFlankingDistanceMin 0 .. Max 1024.
    expect(flankDistance(wolf, settings)).toBeCloseTo(512);
    // Stalk time 0.4 on fCombatFlankingStalkTimeMin 0.01 .. Max 10 s.
    expect(stalkTime(wolf, settings)).toBeCloseTo(0.01 + 0.4 * 9.99);
    expect(maneuverTime(wolf, 'stalk', randoms(0), settings)).toBeCloseTo(4.006);
    expect(maneuverTime(wolf, 'advance', randoms(0.5), settings)).toBe(2);
  });

  it('times a block by its defensive mult on the curve 4, 8, 10000 s', () => {
    // Defensive 0.8: 0.6 on the curve, 8 + 9992 × 0.6; defensive 0.11: −0.78, 4 + 4 × 0.22.
    expect(blockTime(guard, settings)).toBeCloseTo(6003.2);
    expect(blockTime(melee, settings)).toBeCloseTo(4.88);
  });

  it('weighs the offensive mult by the group against a crowded player', () => {
    const pack = style([0.8, 0.2, 0.5, 1, 1, 1, 1, 1, 1, 0.2]);
    expect(offensiveMult(pack, alone, settings)).toBe(pack.general.offensiveMult);
    // Two others on the player: × 0.5², not below fCombatGroupOffensiveMultMin 0.1.
    expect(offensiveMult(pack, { targetIsPlayer: true, allies: 2 }, settings)).toBeCloseTo(0.2);
    expect(offensiveMult(pack, { targetIsPlayer: true, allies: 5 }, settings)).toBeCloseTo(0.08);
    expect(offensiveMult(pack, { targetIsPlayer: false, allies: 2 }, settings)).toBeCloseTo(0.8);
  });

  it('puts the advance radii and the optimal range on the defensive − offensive curves', () => {
    const near = { ...alone, targetStaggered: false, reach: 141, targetReach: 141 };
    // Offensive styles: inner 0 (Min = Mid = 0), outer between 128 and 256 (Skyrim.esm's).
    const pressing = advanceRadii(melee, { ...near, sinceDamaged: undefined }, settings);
    expect(pressing.inner).toBe(0);
    expect(pressing.outer).toBeCloseTo(128 + 128 * (1 - 0.21));
    // A defensive one keeps its wider radii while it was hurt lately and the reaches match.
    const hurt = advanceRadii(guard, { ...near, sinceDamaged: 2 }, settings);
    expect(hurt.inner).toBeCloseTo(256 * 0.6);
    expect(hurt.outer).toBeCloseTo(256 + 256 * 0.6);
    const middle = { inner: 0, outer: 256 };
    expect(advanceRadii(guard, { ...near, sinceDamaged: 11 }, settings)).toEqual(middle);
    expect(advanceRadii(guard, { ...near, sinceDamaged: undefined }, settings)).toEqual(middle);
    expect(advanceRadii(guard, { ...near, targetReach: 400, sinceDamaged: 2 }, settings)).toEqual(
      middle,
    );
    // A staggered target: its defensive mult × 0, it presses.
    const pressed = advanceRadii(
      guard,
      { ...near, targetStaggered: true, sinceDamaged: 2 },
      settings,
    );
    expect(pressed.inner).toBe(0);
    expect(pressed.outer).toBeCloseTo(128 + 128 * 0.8);
    // The archer: 0.24 − 0.34 on 1024, 1280, 1536.
    expect(maxOptimalRange(archer, alone, settings)).toBeCloseTo(1024 + 256 * 0.9);
  });

  it('keeps what it took up by its kind’s fCombatInventoryMinEquipTime*', () => {
    expect(minEquipTime('melee', settings)).toBe(5);
    expect(minEquipTime('ranged', settings)).toBe(5);
    expect(minEquipTime('magic', settings)).toBe(3);
    expect(minEquipTime('shout', settings)).toBe(3);
    expect(minEquipTime('staff', settings)).toBe(5);
    expect(minEquipTime('unarmed', settings)).toBe(0);
  });
});

describe('combat tactics: what it fights with', () => {
  it('fits melee within reach and ranged at a distance', () => {
    expect(rangeFit(sword, 100, settings)).toBe(1);
    expect(rangeFit(sword, 2000, settings)).toBeLessThan(0.2);
    expect(rangeFit(bow, 1000, settings)).toBe(1);
    expect(rangeFit(bow, 50, settings)).toBeLessThan(0.5);
    // Beyond its range: fCombatInventoryMaxRangeScoreMult.
    expect(rangeFit(bow, 9000, settings)).toBe(0.1);
  });

  it('chooses a sword close and a bow far for an even style', () => {
    expect(chooseEquipment([sword, bow, fists], 100, melee, settings)?.id).toBe(1);
    expect(chooseEquipment([sword, bow, fists], 2000, melee, settings)?.id).toBe(2);
  });

  it('weighs the style: an archer shoots from closer, a melee style closes', () => {
    // At 400 units: the melee style keeps its sword, the archer (ranged 3.2) its bow.
    expect(chooseEquipment([sword, bow], 400, melee, settings)?.id).toBe(1);
    expect(chooseEquipment([sword, bow], 400, archer, settings)?.id).toBe(2);
    // Face to face even the archer draws its sword.
    expect(chooseEquipment([sword, bow], 60, archer, settings)?.id).toBe(1);
  });

  it('leaves out what its style scores 0, and falls back to fists', () => {
    const noMelee = style([0.5, 0.5, 0.5, 0, 1, 0, 1, 1, 1, 0.2]);
    expect(chooseEquipment([sword, bow, fists], 100, noMelee, settings)?.kind).toBe('unarmed');
    const nothing = style([0.5, 0.5, 0.5, 0, 0, 0, 0, 0, 0, 0.2]);
    expect(chooseEquipment([sword, bow, fists], 100, nothing, settings)).toBeUndefined();
  });
});

describe('combat tactics: how it moves', () => {
  const input: ManeuverInput = {
    distance: 120,
    reach: 141,
    ranged: false,
    allies: 0,
    previous: 'advance',
  };

  it('advances from beyond its outer advance radius', () => {
    expect(chooseManeuver(melee, { ...input, distance: 2000 }, randoms(0), settings)).toBe(
      'advance',
    );
    // The middle radius (256) past its reach: 441 is out of range; with an outer 512 it is in.
    expect(chooseManeuver(duel, { ...input, distance: 441 }, randoms(0.2), settings)).toBe(
      'advance',
    );
    const wide = { ...input, distance: 441, radii: { inner: 0, outer: 512 } };
    expect(chooseManeuver(duel, wide, randoms(0.2), settings)).toBe('fallback');
  });

  it('dueling: falls back or circles by its chances on the engine’s scale', () => {
    // Fallback chance 0.6 on 0 .. 0.5 = 0.3; circle 0.8 on 0 .. 0.75 = 0.6.
    expect(chooseManeuver(duel, input, randoms(0.2), settings)).toBe('fallback');
    expect(chooseManeuver(duel, input, randoms(0.9, 0.5), settings)).toBe('circle');
    expect(chooseManeuver(duel, input, randoms(0.9, 0.7), settings)).toBe('advance');
  });

  it('flanking: stalks for its stalk time, then flanks with allies on the target', () => {
    expect(chooseManeuver(wolf, { ...input, distance: 800, allies: 2 }, randoms(), settings)).toBe(
      'flank',
    );
    expect(chooseManeuver(wolf, { ...input, distance: 800 }, randoms(), settings)).toBe('advance');
    expect(chooseManeuver(wolf, input, randoms(), settings)).toBe('stalk');
    const stalked = { ...input, previous: 'stalk' as const };
    expect(chooseManeuver(wolf, { ...stalked, allies: 1 }, randoms(), settings)).toBe('flank');
    expect(chooseManeuver(wolf, stalked, randoms(), settings)).toBe('advance');
    expect(chooseManeuver(wolf, { ...input, previous: 'flank' }, randoms(), settings)).toBe(
      'advance',
    );
  });

  it('at range keeps within its optimal range, falls back and strafes by its chances', () => {
    const optimalRange = maxOptimalRange(archer, alone, settings);
    const ranged = { ...input, ranged: true, reach: 4096, optimalRange };
    expect(chooseManeuver(archer, { ...ranged, distance: 5000 }, randoms(0), settings)).toBe(
      'advance',
    );
    // Beyond 1254 units it closes in.
    expect(chooseManeuver(archer, { ...ranged, distance: 1300 }, randoms(0), settings)).toBe(
      'advance',
    );
    // Fallback chance 0.2 on 0 .. 0.5: 0.1 within fCombatAdvanceOuterRadiusMax.
    expect(chooseManeuver(archer, { ...ranged, distance: 300 }, randoms(0.05), settings)).toBe(
      'fallback',
    );
    // Strafe chance 0.2 on 0 .. 0.75: 0.15.
    expect(chooseManeuver(archer, { ...ranged, distance: 1000 }, randoms(0.1), settings)).toBe(
      'strafe',
    );
    // The Strafe Selector's Circle: its circle chance once it does not strafe.
    expect(chooseManeuver(archer, { ...ranged, distance: 1000 }, randoms(0.2, 0), settings)).toBe(
      'circle',
    );
    expect(
      chooseManeuver(archer, { ...ranged, distance: 1000 }, randoms(0.2, 0.99), settings),
    ).toBe('hold');
  });

  it('a free left hand beside a one-handed weapon takes up its best spell', () => {
    const flames: EquipOption = { kind: 'magic', id: 7, damage: 8, range: 600, equipped: false };
    const sparks: EquipOption = { kind: 'magic', id: 8, damage: 12, range: 600, equipped: false };
    const hands = { weaponType: 1, shield: false, leftWeapon: false };
    expect(leftHandSpell(hands, [flames, sparks], 300, melee, settings)).toBe(8);
    expect(leftHandSpell({ ...hands, shield: true }, [flames], 300, melee, settings)).toBe(
      undefined,
    );
    // A two-handed sword fills both hands.
    expect(leftHandSpell({ ...hands, weaponType: 5 }, [flames], 300, melee, settings)).toBe(
      undefined,
    );
  });

  it('turns maneuvers into ways to go', () => {
    const from = [0, 0, 0] as const;
    const target = [0, 100, 0] as const;
    expect(maneuverDirection('advance', from, target, 1)).toEqual([0, 1]);
    expect(maneuverDirection('fallback', from, target, 1)).toEqual([-0, -1]);
    const [x, y] = maneuverDirection('circle', from, target, 1);
    expect(x).toBeCloseTo(1);
    expect(y).toBeCloseTo(0);
    // A flank makes for the point a quarter round the target ahead, at its flank radius.
    const [fx, fy] = maneuverDirection('flank', from, target, -1, 100);
    expect(fx).toBeCloseTo(-Math.SQRT1_2);
    expect(fy).toBeCloseTo(Math.SQRT1_2);
    // Farther out, it heads in towards that radius as it goes round.
    const [wx, wy] = maneuverDirection('flank', [0, -300, 0], target, -1, 100);
    expect(wx).toBeCloseTo(-100 / Math.hypot(100, 400));
    expect(wy).toBeCloseTo(400 / Math.hypot(100, 400));
  });
});

describe('combat tactics: attacks, blocks, threats', () => {
  const attack: AttackInput = {
    targetStaggered: false,
    targetBlocking: false,
    targetAttacking: false,
    targetPowerAttacking: false,
    targetRecoiling: false,
    blocking: false,
    canBash: true,
    powerChance: 0.5,
    allies: 0,
    targetIsPlayer: false,
    sinceLastAttack: undefined,
  };
  const brute = style([0.8, 0.2, 1, 1, 1, 1, 1, 1, 1, 0.2], [2, 1, 0.5, 2, 1, 2, 1, 0.1]);

  it('attacks by its offensive mult on fCombatAttackChanceMin .. Max, power attacks by its data', () => {
    // Offensive 0.8: 0.05 + 0.95 × 0.8 = 0.81.
    expect(attackChance(brute, attack, settings)).toBeCloseTo(0.81);
    expect(chooseAttack(brute, attack, randoms(0.9), settings)).toBe('none');
    expect(chooseAttack(brute, attack, randoms(0.5, 0.9), settings)).toBe('attack');
    expect(chooseAttack(brute, attack, randoms(0.5, 0.2), settings)).toBe('power');
    // Offensive 0 still attacks at fCombatAttackChanceMin 0.05.
    const timid = style([0, 0.5, 1, 1, 1, 1, 1, 1, 1, 0.2]);
    expect(chooseAttack(timid, attack, randoms(0.06), settings)).toBe('none');
    expect(chooseAttack(timid, attack, randoms(0.04, 0.9), settings)).toBe('attack');
  });

  it('attacks more the longer since its last attack, less in a crowd on the player', () => {
    // × 1 .. fCombatAttackChanceLastAttackBonus 1.5 over fCombatAttackChanceLastAttackBonusTime 5.
    expect(attackChance(brute, { ...attack, sinceLastAttack: 0 }, settings)).toBeCloseTo(0.81);
    expect(attackChance(brute, { ...attack, sinceLastAttack: 2.5 }, settings)).toBeCloseTo(1.0125);
    expect(attackChance(brute, { ...attack, sinceLastAttack: 9 }, settings)).toBeCloseTo(1.215);
    // Group offensive mult 0.5, two others on the player: offensive 0.8 × 0.25 = 0.2.
    const pack = style([0.8, 0.2, 0.5, 1, 1, 1, 1, 1, 1, 0.2]);
    const crowd = { ...attack, allies: 2, targetIsPlayer: true };
    expect(attackChance(pack, crowd, settings)).toBeCloseTo(0.05 + 0.95 * 0.2);
    expect(attackChance(pack, { ...crowd, targetIsPlayer: false }, settings)).toBeCloseTo(0.81);
  });

  it('presses a staggered target and spares power attacks on a blocking one', () => {
    // Attack staggered mult 2: 0.81 → 1.62, any roll attacks.
    expect(
      chooseAttack(brute, { ...attack, targetStaggered: true }, randoms(0.95, 0.9), settings),
    ).toBe('attack');
    // Power attack blocking mult 0.5: chance 0.25.
    expect(
      chooseAttack(brute, { ...attack, targetBlocking: true }, randoms(0.1, 0.3), settings),
    ).toBe('attack');
  });

  it('bashes from a block by its defensive mult, more as the target swings; attacks less', () => {
    const blocking = { ...attack, blocking: true };
    // Bash chance: defensive 0.2 on fCombatBashChanceMin 0.025 .. Max 0.2 (0.06) × bash mult 2;
    // as the target swings × bash attack mult 2.
    expect(bashChance(brute, blocking, settings)).toBeCloseTo(0.12);
    expect(bashChance(brute, { ...blocking, targetAttacking: true }, settings)).toBeCloseTo(0.24);
    // Its recoil counts first (bash recoil mult 1); a blocking target never
    // (fCombatBashTargetBlockingMult 0).
    const recoiling = { ...blocking, targetAttacking: true, targetRecoiling: true };
    expect(bashChance(brute, recoiling, settings)).toBeCloseTo(0.12);
    expect(bashChance(brute, { ...blocking, targetBlocking: true }, settings)).toBe(0);
    // The offensive bash: offensive 0.8 on 0 .. 0.05 × bash mult 2.
    expect(offensiveBashChance(brute, attack, settings)).toBeCloseTo(0.08);
    // No bash: an attack at 0.81 × (defensive 0.2 on 0.67 .. 0.2: 0.576) = 0.467.
    expect(attackChance(brute, blocking, settings)).toBeCloseTo(0.81 * 0.576);
    expect(chooseAttack(brute, blocking, randoms(0.6, 0.6), settings)).toBe('none');
    expect(chooseAttack(brute, blocking, randoms(0.6, 0.4, 0.9), settings)).toBe('attack');
    expect(
      chooseAttack(brute, { ...blocking, targetAttacking: true }, randoms(0.2, 0.9), settings),
    ).toBe('bash');
    // Without a bash, never into a swing (fCombatAttackChanceBlockingSwingMult 0).
    const swung = { ...blocking, canBash: false, targetAttacking: true };
    expect(chooseAttack(brute, swung, randoms(0), settings)).toBe('none');
  });

  it('shoots and casts by its offensive mult on their own scales', () => {
    // Offensive 0.34 on fCombatRangedAttackChanceMin 0.05 .. Max 1: 0.373, then up to half again
    // over fCombatRangedAttackChanceLastAttackBonusTime 10 s.
    const shot = { ...alone, sinceLastAttack: undefined };
    expect(rangedAttackChance(archer, shot, settings)).toBeCloseTo(0.373);
    expect(rangedAttackChance(archer, { ...shot, sinceLastAttack: 5 }, settings)).toBeCloseTo(
      0.373 * 1.25,
    );
    expect(rangedAttackChance(archer, { ...shot, sinceLastAttack: 20 }, settings)).toBeCloseTo(
      0.373 * 1.5,
    );
    // An immediate spell on 0.05 .. 0.75, a concentration spell on 0.25 .. 1.
    expect(castChance(archer, alone, false, settings)).toBeCloseTo(0.05 + 0.7 * 0.34);
    expect(castChance(archer, alone, true, settings)).toBeCloseTo(0.25 + 0.75 * 0.34);
  });

  it('holds its bow from 0.1 s up to its offensive mult on 1.5 .. 0.25 s, shortest up close', () => {
    const far = { ...alone, distance: 1000, radii: 40 };
    expect(bowHoldTime(archer, far, () => 1, settings)).toBeCloseTo(1.5 - 1.25 * 0.34);
    expect(bowHoldTime(archer, far, () => 0, settings)).toBeCloseTo(0.1);
    // Within fCombatRangedAttackHoldTimeMinDistance (256) past the radii: up to 0.25 s.
    expect(bowHoldTime(archer, { ...far, distance: 200 }, () => 1, settings)).toBeCloseTo(0.25);
  });

  it('blocks by its block chance, less with a weapon than a shield', () => {
    const shieldBearer = style([0.5, 0.8, 1, 1, 1, 1, 1, 1, 1, 0.2]);
    expect(choosesBlock(shieldBearer, true, randoms(0.7), settings)).toBe(true);
    // fCombatBlockChanceWeaponMult 0.25: 0.2.
    expect(choosesBlock(shieldBearer, false, randoms(0.3), settings)).toBe(false);
    expect(choosesBlock(shieldBearer, false, randoms(0.1), settings)).toBe(true);
  });

  it('sees an arrow coming and steps out of its line', () => {
    const arrow: Threat = {
      key: {},
      position: [0, -1000, 100],
      velocity: [0, 3600, 0],
      radius: 8,
      source: 7,
    };
    expect(threatens(arrow, [0, 0, 0], 20, 128)).toBeCloseTo(1000 / 3600);
    expect(threatens(arrow, [200, 0, 0], 20, 128)).toBeUndefined();
    expect(threatens({ ...arrow, velocity: [0, -3600, 0] }, [0, 0, 0], 20, 128)).toBeUndefined();
    // Standing right of the line, it steps further right.
    const [x, y] = dodgeDirection(arrow, [5, 0, 0]);
    expect(x).toBeCloseTo(1);
    expect(y).toBeCloseTo(0);
    expect(avoidsThreat(melee, randoms(0.1), settings)).toBe(true);
    expect(avoidsThreat(melee, randoms(0.3), settings)).toBe(false);
  });
});

describe('combat tactics: what it does for itself', () => {
  const base: SupportState = {
    health: 1,
    magicka: 1,
    sinceHealthRestore: Infinity,
    sinceMagickaRestore: Infinity,
    canHeal: false,
    potions: { health: false, magicka: false },
    canSummon: false,
    canBuff: false,
    canWard: false,
  };

  it('restores below its defensive mult on fCombatRestore…PercentMin .. Max', () => {
    // Defensive 0.8: health below 0.8 × 0.5, magicka below 0.25 + 0.8 × 0.15.
    expect(restoreShare(guard, 'health', settings)).toBeCloseTo(0.4);
    expect(restoreShare(guard, 'magicka', settings)).toBeCloseTo(0.37);
    expect(settings.restoreHealthRestrictTime).toBe(15);
    expect(settings.restoreMagickaRestrictTime).toBe(10);
    expect(settings.drinkPotionWaitTime).toBe(3);
  });

  it('wards a spell coming at it before anything else', () => {
    expect(
      chooseSupport({ ...base, canWard: true, health: 0.1, canHeal: true }, guard, settings),
    ).toEqual({ kind: 'ward' });
  });

  it('heals below its restore share, by spell first, else a potion, not too often', () => {
    const hurt = { ...base, health: 0.3, potions: { ...base.potions, health: true } };
    expect(chooseSupport({ ...hurt, canHeal: true }, guard, settings)).toEqual({ kind: 'heal' });
    expect(chooseSupport(hurt, guard, settings)).toEqual({ kind: 'potion', value: 'health' });
    expect(chooseSupport({ ...hurt, sinceHealthRestore: 10 }, guard, settings)).toBeUndefined();
    expect(chooseSupport({ ...hurt, health: 0.45 }, guard, settings)).toBeUndefined();
    // A bold style (defensive 0.11) waits until 5.5% of its health.
    expect(chooseSupport(hurt, melee, settings)).toBeUndefined();
    expect(chooseSupport({ ...hurt, health: 0.05 }, melee, settings)).toEqual({
      kind: 'potion',
      value: 'health',
    });
  });

  it('drinks for magicka below its share, summons and buffs when it may', () => {
    const potions = { ...base.potions, magicka: true };
    expect(chooseSupport({ ...base, magicka: 0.3, potions }, guard, settings)).toEqual({
      kind: 'potion',
      value: 'magicka',
    });
    expect(
      chooseSupport({ ...base, magicka: 0.3, potions, sinceMagickaRestore: 5 }, guard, settings),
    ).toBeUndefined();
    expect(chooseSupport({ ...base, magicka: 0.4, potions }, guard, settings)).toBeUndefined();
    expect(chooseSupport({ ...base, canSummon: true, canBuff: true }, guard, settings)).toEqual({
      kind: 'summon',
    });
    expect(chooseSupport({ ...base, canBuff: true }, guard, settings)).toEqual({ kind: 'buff' });
    expect(chooseSupport(base, guard, settings)).toBeUndefined();
  });
});
