import { describe, expect, it } from 'vitest';
import {
  DestructionStageFlag as Flag,
  type DestructionData,
  type DestructionStage,
} from '../world/destruction-records.ts';
import { damageDestructible, debrisPieces } from './destruction.ts';

const stage = (healthPercent: number, flags = 0, selfDamagePerSecond = 0): DestructionStage => ({
  healthPercent,
  index: 0,
  modelDamageStage: 0,
  flags,
  selfDamagePerSecond,
  explosion: undefined,
  debris: undefined,
  debrisCount: 0,
  model: undefined,
  alternateTextures: [],
});
const data = (health: number, ...stages: DestructionStage[]): DestructionData => ({
  health,
  flags: 0,
  stages,
});
const external = { external: true };
const script = { external: false };

describe('destruction stages', () => {
  // StockadeBarricade01Activator: health 125, stages at 75, 50, 25 and 0 %.
  const barricade = data(125, stage(75), stage(50), stage(25), stage(0));

  it('reaches each stage as the health falls to its percent', () => {
    let standing = { health: 125, stage: 0 };
    let step = damageDestructible(barricade, standing, 20, external);
    expect(step).toEqual({ health: 105, stage: 0, reached: [] });
    standing = step;
    step = damageDestructible(barricade, standing, 11.25, external);
    expect(step).toEqual({ health: 93.75, stage: 1, reached: [1] });
    // One blow through two stages (no cap).
    step = damageDestructible(barricade, step, 70, external);
    expect(step).toEqual({ health: 23.75, stage: 3, reached: [2, 3] });
    step = damageDestructible(barricade, step, 100, external);
    expect(step).toEqual({ health: 0, stage: 4, reached: [4] });
    // Past its last stage nothing more is reached.
    expect(damageDestructible(barricade, step, 10, external).reached).toEqual([]);
  });

  it('stops a blow at a stage with Cap Damage (a web: two blows)', () => {
    // FXspiderWebKitDestructible: health 10, [99% cap] [0%].
    const web = data(10, stage(99, Flag.capDamage), stage(0));
    const first = damageDestructible(web, { health: 10, stage: 0 }, 50, external);
    expect(first).toEqual({ health: 9.9, stage: 1, reached: [1] });
    const second = damageDestructible(web, first, 50, external);
    expect(second).toEqual({ health: 0, stage: 2, reached: [2] });
  });

  it("takes only its own and scripts' damage in a stage ignoring external damage", () => {
    // MineOreIron01: health 100, [50% cap, ignore external]: DamageObject(50) depletes it.
    const ore = data(100, stage(50, Flag.capDamage | Flag.ignoreExternalDamage));
    const depleted = damageDestructible(ore, { health: 100, stage: 0 }, 50, script);
    expect(depleted).toEqual({ health: 50, stage: 1, reached: [1] });
    expect(damageDestructible(ore, depleted, 50, external)).toEqual({
      health: 50,
      stage: 1,
      reached: [],
    });
    // An external blow stops at a stage that ignores external damage.
    const mill = data(100, stage(100, Flag.ignoreExternalDamage), stage(0));
    expect(damageDestructible(mill, { health: 100, stage: 0 }, 100, external)).toEqual({
      health: 100,
      stage: 1,
      reached: [1],
    });
    expect(damageDestructible(mill, { health: 100, stage: 1 }, 100, script)).toEqual({
      health: 0,
      stage: 2,
      reached: [2],
    });
  });

  it('takes no external damage once destroyed; BlowUp goes through every stage', () => {
    const urn = data(100, stage(66), stage(33), stage(0, Flag.destroy));
    expect(
      damageDestructible(urn, { health: 100, stage: 0 }, 50, { external: true, destroyed: true })
        .reached,
    ).toEqual([]);
    const oil = data(100, stage(99, Flag.capDamage | Flag.destroy, 16), stage(94, Flag.capDamage));
    expect(
      damageDestructible(oil, { health: 100, stage: 0 }, 0, { external: false, blowUp: true }),
    ).toEqual({ health: 0, stage: 2, reached: [1, 2] });
  });

  it('caps self damage too (the oil pool burns down stage by stage)', () => {
    const oil = data(
      100,
      stage(99, Flag.capDamage | Flag.destroy, 16),
      stage(94, Flag.capDamage | Flag.ignoreExternalDamage, 12),
      stage(7, Flag.disable | Flag.ignoreExternalDamage),
    );
    let step = damageDestructible(oil, { health: 100, stage: 0 }, 5, external);
    expect(step).toEqual({ health: 99, stage: 1, reached: [1] });
    step = damageDestructible(oil, step, 16 * 0.5, script);
    expect(step).toEqual({ health: 94, stage: 2, reached: [2] });
    step = damageDestructible(oil, step, 12 * 8, script);
    expect(step).toEqual({ health: 0, stage: 3, reached: [3] });
  });
});

describe('debris pieces', () => {
  it("picks each piece by the models' percentages", () => {
    const models = [
      { percentage: 30, model: 'a' },
      { percentage: 70, model: 'b' },
    ];
    const values = [0.1, 0.29, 0.31, 0.99];
    const pieces = debrisPieces(models, 4, () => values.shift() ?? 0);
    expect(pieces.map((piece) => piece.model)).toEqual(['a', 'a', 'b', 'b']);
    expect(debrisPieces(models, 0, Math.random)).toEqual([]);
    expect(debrisPieces([], 5, Math.random)).toEqual([]);
  });
});
