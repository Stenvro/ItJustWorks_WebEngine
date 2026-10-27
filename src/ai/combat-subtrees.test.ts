import { describe, expect, it } from 'vitest';
import { NavmeshFlag, type Navmesh } from '../world/navmesh.ts';
import { CombatSearch } from './combat-search.ts';
import {
  COMBAT_SUBTREE_DEFAULTS as S,
  chooseCaster,
  coverSpots,
  coverTimes,
  doorSpots,
  dualCastHold,
  exitWaterPoint,
  holdsRestore,
  lowCombatBlow,
  pickCover,
  pickFleeDoor,
  pickWeapon,
  searchRadius,
  type CasterState,
} from './combat-subtrees.ts';
import type { NavmeshSet } from './pathfinding.ts';

type Vec3 = readonly [number, number, number];

// A strip of three triangles along x: two in the water, the last dry, with full cover along its
// far edge and a door in it.
const mesh: Navmesh = {
  formId: 1,
  world: 0,
  cell: 0,
  vertices: new Float32Array([0, 0, 0, 0, 100, 0, 100, 0, 0, 100, 100, 0, 200, 0, 0]),
  triangles: [
    { vertices: [0, 1, 2], edges: [-1, 1, -1], flags: NavmeshFlag.water, cover: 0 },
    { vertices: [1, 3, 2], edges: [-1, 2, 0], flags: NavmeshFlag.water, cover: 0 },
    { vertices: [2, 3, 4], edges: [1, -1, -1], flags: 0, cover: 15 << 6 },
  ],
  links: [],
  doors: [{ triangle: 2, type: 0, door: 0xd00 }],
  coverTriangles: [2],
  grid: { divisor: 1, cellSize: [200, 100], min: [0, 0, 0], max: [200, 100, 0], cells: [] },
};
const set: NavmeshSet = {
  navmesh: (formId) => (formId === 1 ? mesh : undefined),
  locate: () => ({ navmesh: mesh, triangle: 0 }),
};
const swimmer: Vec3 = [20, 20, 0];

describe('the combat subtrees', () => {
  it('Exit Water: the nearest dry ground of the navmeshes', () => {
    const shore = exitWaterPoint(set, swimmer);
    expect(shore?.[0]).toBeCloseTo(133.3, 1);
    expect(shore?.[1]).toBeCloseTo(33.3, 1);
  });

  it('Find Cover: a cover edge between it and the threat, within its range', () => {
    const spots = coverSpots(set, swimmer, 1000);
    expect(spots).toHaveLength(1);
    const need = { minRange: 100, maxRange: 2000, height: S.coverCheckHeightMin, avoid: 0 };
    expect(pickCover(spots, swimmer, { ...need, threat: [400, 300, 0] })).toBe(spots[0]);
    // The threat on the other side: the edge keeps nothing off.
    expect(pickCover(spots, swimmer, { ...need, threat: [-400, -300, 0] })).toBeUndefined();
    // Too near the threat (fCombatCoverMinimumRange).
    expect(
      pickCover(spots, swimmer, { ...need, minRange: S.coverMinimumRange, threat: [400, 300, 0] }),
    ).toBeUndefined();
  });

  it('Flee Through Door: by its chance, a door away from the enemy, not again too soon', () => {
    const doors = doorSpots(set, swimmer, S.fleeDoorDistanceMax);
    expect(doors.map((door) => door.door)).toEqual([0xd00]);
    const enemy: Vec3 = [-500, 0, 0];
    expect(pickFleeDoor(doors, swimmer, enemy, Infinity, () => 0)?.door).toBe(0xd00);
    expect(pickFleeDoor(doors, swimmer, enemy, Infinity, () => 0.9)).toBeUndefined();
    expect(pickFleeDoor(doors, swimmer, enemy, 1, () => 0)).toBeUndefined();
    // The enemy beyond the door: not that way.
    expect(pickFleeDoor(doors, swimmer, [500, 50, 0], Infinity, () => 0)).toBeUndefined();
  });

  it('Acquire Weapon: the best weapon near enough that beats its fists', () => {
    const situation = { feet: [0, 0, 0] as Vec3, target: [3000, 0, 0] as Vec3, disarmed: false };
    const sword = { reference: 1, at: [300, 0, 0] as Vec3, damage: 8, ranged: false };
    const bow = { reference: 2, at: [0, 400, 0] as Vec3, damage: 10, ranged: true };
    const far = { reference: 3, at: [0, 2500, 0] as Vec3, damage: 50, ranged: false };
    expect(pickWeapon([sword, bow, far], { ...situation, currentScore: 2 })?.reference).toBe(2);
    // Not worth fCombatAcquireWeaponMinimumScoreMult times what it has.
    expect(pickWeapon([sword], { ...situation, currentScore: 3 })).toBeUndefined();
    // Not beside its target.
    expect(
      pickWeapon([sword], { ...situation, target: [350, 0, 0], currentScore: 1 }),
    ).toBeUndefined();
  });

  it('Low Combat: blows land by fCombatLowTargetHitPercent within reach', () => {
    expect(lowCombatBlow(1000, false, () => 0.4)).toBe(true);
    expect(lowCombatBlow(1000, true, () => 0.4)).toBe(false);
    expect(lowCombatBlow(S.lowMaxAttackDistance + 1, false, () => 0)).toBeUndefined();
  });

  it('casters by purpose: ward, restore, summon, reanimate, buff', () => {
    const idle: CasterState = {
      health: 1,
      magicka: 1,
      restoreHealthBelow: 0.5,
      wardThreat: false,
      sinceWard: Infinity,
      canHeal: true,
      sinceHealthRestore: Infinity,
      restoreHealthRestrictTime: 15,
      canSummon: false,
      sinceSummon: Infinity,
      corpseDistance: 500,
      canReanimate: true,
      sinceReanimate: Infinity,
      canBuff: true,
    };
    expect(chooseCaster({ ...idle, wardThreat: true })).toBe('ward');
    // Too little magicka for a ward (fCombatMagicWardMagickaCastLimit).
    expect(chooseCaster({ ...idle, wardThreat: true, magicka: 0.1, canReanimate: false })).toBe(
      'buff',
    );
    expect(chooseCaster({ ...idle, health: 0.3 })).toBe('restore');
    expect(chooseCaster({ ...idle, canSummon: true })).toBe('summon');
    expect(chooseCaster({ ...idle, canSummon: true, sinceSummon: 10 })).toBe('reanimate');
    expect(chooseCaster({ ...idle, sinceReanimate: 10 })).toBe('buff');
  });

  it('the held healing spell stops fCombatRestoreStopCastThreshold past its share', () => {
    expect(holdsRestore(0.6, 0.5)).toBe(true);
    expect(holdsRestore(0.76, 0.5)).toBe(false);
  });

  it('Prepare Dual Cast: held while it charges, broken off after its interrupt time', () => {
    expect(dualCastHold(0.5, 1)).toBe('charging');
    expect(dualCastHold(1.2, 1)).toBe('release');
    expect(dualCastHold(S.dualCastInterruptTime, Infinity)).toBe('interrupt');
  });

  it('Search and Use Cover take their settings', () => {
    expect(searchRadius(true, () => 0)).toBe(S.searchInteriorRadiusMin);
    expect(searchRadius(false, () => 1)).toBe(S.searchExteriorRadiusMax);
    const times = coverTimes({ offensiveMult: 1, defensiveMult: 0.5 });
    expect(times).toEqual({ wait: S.coverWaitTimeMid, attack: S.coverAttackTimeMax });
  });

  it('Wait to Start Search: the searcher stands first', () => {
    const trips: Vec3[] = [];
    const search = new CombatSearch(
      [500, 0, 0],
      {
        position: () => [0, 0, 0],
        travel: (to) => {
          trips.push(to);
          return new Promise(() => undefined);
        },
        face: () => undefined,
        stop: () => undefined,
      },
      {
        searchInvestigateDistance: 256,
        searchInvestigateTime: 2.5,
        stateExpireTime: 30,
        searchStartWaitTime: S.searchStartWaitTime,
      },
      () => 0.5,
    );
    search.update(0.5);
    search.update(0.4);
    expect(trips).toHaveLength(0);
    search.update(0.2);
    search.update(0.1);
    expect(trips).toEqual([[500, 0, 0]]);
  });
});
