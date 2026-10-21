import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { COMBAT_AI_DEFAULTS } from './combat-ai.ts';
import { CombatStyleFlag, parseCombatStyle, type CombatStyle } from './combat-style-records.ts';
import {
  avoidsThreat,
  chooseAttack,
  chooseEquipment,
  chooseManeuver,
  choosesBlock,
  dodgeDirection,
  maneuverDirection,
  rangeFit,
  threatens,
  type AttackInput,
  type EquipOption,
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

describe('combat tactics: what it fights with', () => {
  it('fits melee within reach and ranged at a distance', () => {
    expect(rangeFit(sword, 100, settings)).toBe(1);
    expect(rangeFit(sword, 2000, settings)).toBeLessThan(0.2);
    expect(rangeFit(bow, 1000, settings)).toBe(1);
    expect(rangeFit(bow, 50, settings)).toBeLessThan(0.5);
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
  const input = { distance: 120, reach: 141, ranged: false, targetAttacking: false, allies: 0 };

  it('advances from afar', () => {
    expect(chooseManeuver(melee, { ...input, distance: 2000 }, randoms(0), settings)).toBe(
      'advance',
    );
  });

  it('dueling: falls back or circles by its close range mults', () => {
    const duel = style([0.5, 0.5, 1, 1, 1, 1, 1, 1, 1, 0.2], undefined, [0.8, 0.6, 0.2, 0.2]);
    // Fallback chance 0.6 × 0.5 (no swing) = 0.3: 0.2 falls back.
    expect(chooseManeuver(duel, input, randoms(0.2), settings)).toBe('fallback');
    // Circle chance 0.8 × 0.5 = 0.4: past the fallback, 0.3 circles.
    expect(chooseManeuver(duel, input, randoms(0.9, 0.3), settings)).toBe('circle');
    expect(chooseManeuver(duel, input, randoms(0.9, 0.9), settings)).toBe('advance');
    // A swing coming: fallback 0.6 × 1.5 = 0.9.
    expect(chooseManeuver(duel, { ...input, targetAttacking: true }, randoms(0.85), settings)).toBe(
      'fallback',
    );
  });

  it('flanking: flanks with allies on the target, stalks near', () => {
    const wolf = style(
      [0.75, 0.09, 0.74, 1, 1, 1, 1, 1, 1, 0.2],
      undefined,
      [0, 0.15, 0.5, 0.4],
      CombatStyleFlag.flanking,
    );
    expect(
      chooseManeuver(wolf, { ...input, distance: 800, allies: 2 }, randoms(0.3), settings),
    ).toBe('flank');
    expect(chooseManeuver(wolf, { ...input, distance: 800 }, randoms(0.3), settings)).toBe(
      'advance',
    );
    expect(chooseManeuver(wolf, input, randoms(0.9, 0.2), settings)).toBe('stalk');
  });

  it('at range keeps its distance and strafes', () => {
    const ranged = { ...input, ranged: true, reach: 4096 };
    expect(chooseManeuver(archer, { ...ranged, distance: 5000 }, randoms(0), settings)).toBe(
      'advance',
    );
    expect(chooseManeuver(archer, { ...ranged, distance: 300 }, randoms(0.1), settings)).toBe(
      'fallback',
    );
    expect(chooseManeuver(archer, { ...ranged, distance: 1500 }, randoms(0.1), settings)).toBe(
      'strafe',
    );
    expect(chooseManeuver(archer, { ...ranged, distance: 1500 }, randoms(0.9), settings)).toBe(
      'hold',
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
    const [fx, fy] = maneuverDirection('flank', from, target, -1);
    expect(fx).toBeCloseTo(-Math.SQRT1_2);
    expect(fy).toBeCloseTo(Math.SQRT1_2);
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
  };
  const brute = style([0.8, 0.2, 1, 1, 1, 1, 1, 1, 1, 0.2], [2, 1, 0.5, 2, 1, 2, 1, 0.1]);

  it('attacks by its offensive mult, power attacks by its attack data', () => {
    expect(chooseAttack(brute, attack, randoms(0.9))).toBe('none');
    expect(chooseAttack(brute, attack, randoms(0.5, 0.9))).toBe('attack');
    expect(chooseAttack(brute, attack, randoms(0.5, 0.2))).toBe('power');
    const timid = style([0, 0.5, 1, 1, 1, 1, 1, 1, 1, 0.2]);
    expect(chooseAttack(timid, attack, randoms(0))).toBe('none');
  });

  it('presses a staggered target and spares power attacks on a blocking one', () => {
    // Attack staggered mult 2: offensive 0.8 → 1.6, any roll attacks.
    expect(chooseAttack(brute, { ...attack, targetStaggered: true }, randoms(0.95, 0.9))).toBe(
      'attack',
    );
    // Power attack blocking mult 0.5: chance 0.25.
    expect(chooseAttack(brute, { ...attack, targetBlocking: true }, randoms(0.1, 0.3))).toBe(
      'attack',
    );
  });

  it('bashes from a block, more as the target swings', () => {
    const blocking = { ...attack, blocking: true };
    // Bash chance 0.25 × bash mult 2 = 0.5; as the target swings × bash attack mult 2 = 1.
    expect(chooseAttack(brute, blocking, randoms(0.6))).toBe('none');
    expect(chooseAttack(brute, { ...blocking, targetAttacking: true }, randoms(0.6, 0.9))).toBe(
      'bash',
    );
    expect(chooseAttack(brute, { ...blocking, canBash: false }, randoms(0))).toBe('none');
  });

  it('blocks by its defensive mult, less with a weapon than a shield', () => {
    const guard = style([0.5, 0.8, 1, 1, 1, 1, 1, 1, 1, 0.2]);
    expect(choosesBlock(guard, true, randoms(0.7), settings)).toBe(true);
    // fCombatBlockChanceWeaponMult 0.25: 0.2.
    expect(choosesBlock(guard, false, randoms(0.3), settings)).toBe(false);
    expect(choosesBlock(guard, false, randoms(0.1), settings)).toBe(true);
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
    expect(avoidsThreat(melee, randoms(0.1))).toBe(true);
    expect(avoidsThreat(melee, randoms(0.3))).toBe(false);
  });
});
