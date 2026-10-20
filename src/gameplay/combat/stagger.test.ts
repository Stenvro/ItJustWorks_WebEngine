import { describe, expect, it } from 'vitest';
import { COMBAT_DEFAULTS } from './combat-settings.ts';
import { healthOut, bleedoutRecovered, bleedoutRegain } from './bleedout.ts';
import { blockStagger, recoilOf, staggerMagnitude } from './stagger.ts';

const settings = COMBAT_DEFAULTS;
const hit = {
  weaponStagger: 1,
  attackStagger: 1,
  perkMult: 1,
  targetMass: 1,
  targetIsPlayer: false,
};

describe('staggers', () => {
  it('come from power attacks and bashes, not plain attacks (ATKD stagger 0)', () => {
    expect(staggerMagnitude({ ...hit, attackStagger: 0 }, settings)).toBe(0);
    // A warhammer's power attack on a human.
    expect(staggerMagnitude({ ...hit, weaponStagger: 1.25 }, settings)).toBe(1);
    // A sword's (0.75).
    expect(staggerMagnitude({ ...hit, weaponStagger: 0.75 }, settings)).toBeCloseTo(0.75);
    // A bash (0.5).
    expect(staggerMagnitude({ ...hit, attackStagger: 0.5 }, settings)).toBeCloseTo(0.5);
  });

  it('weigh the target: trolls and giants less, the player by fStaggerPlayerMassMult', () => {
    const troll = staggerMagnitude({ ...hit, weaponStagger: 0.75, targetMass: 3.5 }, settings);
    const giant = staggerMagnitude({ ...hit, weaponStagger: 0.75, targetMass: 4 }, settings);
    expect(troll).toBeLessThan(0.75);
    expect(giant).toBeLessThan(troll);
    const player = staggerMagnitude(
      { ...hit, weaponStagger: 0.75, targetIsPlayer: true },
      settings,
    );
    expect(player).toBeLessThan(0.75);
    expect(player).toBeGreaterThan(0);
  });

  it('stagger a blocker by the damage of a power attack it blocked', () => {
    expect(blockStagger(false, 30, settings)).toBe(0);
    expect(blockStagger(true, 30, settings)).toBeCloseTo(0.151);
  });

  it('recoil plain attacks that meet a block or a wall', () => {
    expect(recoilOf({ power: false, bash: false }, 'block', undefined, settings)).toBe('recoil');
    expect(recoilOf({ power: false, bash: false }, 'wall', undefined, settings)).toBe('large');
    expect(recoilOf({ power: true, bash: false }, 'block', 24, settings)).toBe('none');
    expect(recoilOf({ power: false, bash: true }, 'wall', undefined, settings)).toBe('none');
  });
});

describe('bleedout', () => {
  it('takes the essential always and the protected but by the player', () => {
    expect(healthOut({ essential: true, protected: false, byPlayer: true })).toBe('bleeds-out');
    expect(healthOut({ essential: false, protected: true, byPlayer: false })).toBe('bleeds-out');
    expect(healthOut({ essential: false, protected: true, byPlayer: true })).toBe('dies');
    expect(healthOut({ essential: false, protected: false, byPlayer: false })).toBe('dies');
  });

  it('regains fBleedoutRecover of the health a second, up after fBleedoutDefault of it', () => {
    expect(bleedoutRegain(0, 100, 1, settings)).toBeCloseTo(5);
    expect(bleedoutRegain(98, 100, 1, settings)).toBe(100);
    expect(bleedoutRecovered({ health: 15, max: 100, down: 3, noRecovery: false }, settings)).toBe(
      false,
    );
    expect(bleedoutRecovered({ health: 15, max: 100, down: 6, noRecovery: false }, settings)).toBe(
      true,
    );
    expect(bleedoutRecovered({ health: 10, max: 100, down: 6, noRecovery: false }, settings)).toBe(
      false,
    );
    expect(bleedoutRecovered({ health: 90, max: 100, down: 60, noRecovery: true }, settings)).toBe(
      false,
    );
  });
});
