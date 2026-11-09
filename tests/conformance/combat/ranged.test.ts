// Conformance: ranged combat (engine map: Combat > Ranged). When an archer looses, how long it
// draws, and its line of fire.
//
// Sources: observed in the original (docs/ai.md, Style values): the shot's chance is the
// offensive mult on fCombatRangedAttackChanceMin (0.05) .. Max (1), gaining up to
// fCombatRangedAttackChanceLastAttackBonus (half of itself) over …BonusTime (10 s); the draw is
// held at random from fCombatRangedAttackHoldTimeAbsoluteMin (0.1 s) to the offensive mult on
// …HoldTimeMax (1.5) .. Min (0.25); it looses only within fCombatRangedProjectileFiringArc (30°)
// and holds at most fCombatRangedAttackMaximumHoldTime (10 s). the engine's defaults.

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import {
  aimGivenUp,
  bowHoldTime,
  lineOfFire,
  lineOfFireBlocker,
  rangedAttackChance,
} from '../../../src/ai/combat-tactics.ts';
import {
  allyAttackPlaces,
  attackLocationKey,
  attackLocationKeyHolds,
  attackLocationPlaces,
  COMBAT_SUBTREE_DEFAULTS,
  firstClearPlace,
  lateralAttackPlaces,
} from '../../../src/ai/combat-subtrees.ts';
import type { NavmeshSet } from '../../../src/ai/pathfinding.ts';
import { type Navmesh } from '../../../src/world/navmesh.ts';
import { COMBAT_TREES } from '../../../src/ai/combat-tree.ts';
import { AIM_DEFAULTS, leadPoint } from '../../../src/gameplay/combat/aim.ts';
import { ENGINE } from './settings.ts';
import { styleWith } from './style.ts';

const settings = COMBAT_AI_DEFAULTS;
const opponent = { targetIsPlayer: false, allies: 0 };

describe('the shot (formula)', () => {
  it('its chance: the offensive mult on fCombatRangedAttackChanceMin .. Max', () => {
    const shot = { ...opponent, sinceLastAttack: undefined };
    expect(rangedAttackChance(styleWith({ offensiveMult: 0 }), shot, settings)).toBeCloseTo(
      ENGINE.fCombatRangedAttackChanceMin,
    );
    expect(rangedAttackChance(styleWith({ offensiveMult: 1 }), shot, settings)).toBe(
      ENGINE.fCombatRangedAttackChanceMax,
    );
  });

  it('half again after 10 s since the last attack', () => {
    const style = styleWith({ offensiveMult: 0.5 });
    const base = rangedAttackChance(style, { ...opponent, sinceLastAttack: undefined }, settings);
    expect(rangedAttackChance(style, { ...opponent, sinceLastAttack: 10 }, settings)).toBeCloseTo(
      base * 1.5,
    );
  });

  it('the draw: from 0.1 s to the offensive mult on 1.5 .. 0.25 s', () => {
    const style = styleWith({ offensiveMult: 1 });
    const far = { ...opponent, distance: 2000, radii: 0 };
    expect(bowHoldTime(style, far, () => 0, settings)).toBeCloseTo(
      ENGINE.fCombatRangedAttackHoldTimeAbsoluteMin,
    );
    expect(bowHoldTime(style, far, () => 1, settings)).toBeCloseTo(
      ENGINE.fCombatRangedAttackHoldTimeMin,
    );
  });

  it('looses within the firing arc (30°), holds at most 10 s', () => {
    expect(settings.rangedProjectileFiringArc).toBe(ENGINE.fCombatRangedProjectileFiringArc);
    expect(settings.rangedAttackMaximumHoldTime).toBe(ENGINE.fCombatRangedAttackMaximumHoldTime);
  });

  const body = (reference: number, x: number) => ({
    reference,
    feet: [x, 0, 0] as [number, number, number],
    radius: 30,
    height: 120,
  });

  it('the line of fire: an actor in the way holds the shot  [original]', () => {
    const from: [number, number, number] = [0, 0, 90];
    const to: [number, number, number] = [1000, 0, 90];
    expect(lineOfFireBlocker(from, to, [body(1, 500)])).toBe(1);
    // The nearest of two; none beside the line, behind the target or behind the shooter.
    expect(lineOfFireBlocker(from, to, [body(1, 700), body(2, 300)])).toBe(2);
    const beside = { ...body(1, 500), feet: [500, 100, 0] as [number, number, number] };
    expect(lineOfFireBlocker(from, to, [beside])).toBeUndefined();
    expect(lineOfFireBlocker(from, to, [body(1, 1200), body(2, -100)])).toBeUndefined();
    // Over one's head.
    expect(lineOfFireBlocker([0, 0, 400], [1000, 0, 400], [body(1, 500)])).toBeUndefined();
  });

  it('fCombatAimProjectileBlockedTime (1.5 s): a blocked aim is given up', () => {
    expect(settings.aimProjectileBlockedTime).toBe(ENGINE.fCombatAimProjectileBlockedTime);
    expect(aimGivenUp(undefined, settings)).toBe(false);
    expect(aimGivenUp(1.5, settings)).toBe(false);
    expect(aimGivenUp(1.6, settings)).toBe(true);
  });

  it('cover: Find Cover, Attack From Cover, Wait Behind Cover  [original]', () => {
    const tree = JSON.stringify(COMBAT_TREES.UseCover);
    for (const action of ['findCover', 'waitBehindCover', 'attackFromCover']) {
      expect(tree).toContain(`"action":"${action}"`);
    }
  });

  it('the aim leads a moving target (projectile speed, gravity)  [original]', () => {
    // Crossing at 300 units a second, a shot of 1500 a second over 1500 units takes 1 s.
    const point = leadPoint([0, 0, 0], [0, 1500, 0], [300, 0, 0], 1500, 0, AIM_DEFAULTS);
    expect(point[0]).toBeGreaterThan(280);
    // Under gravity the aim rises above the point.
    const falling = leadPoint([0, 0, 0], [0, 1500, 0], [0, 0, 0], 1500, 500, AIM_DEFAULTS);
    expect(falling[2]).toBeGreaterThan(0);
  });

  it('an archer looses only with its target inside the firing arc  [original]', () => {
    // The tree's Release needs shotInArc while the bow is held; shotOverheld lets it down.
    const tree = JSON.stringify(COMBAT_TREES);
    expect(tree).toContain('"shotInArc"');
    expect(tree).toContain('"shotOverheld"');
  });
});

// --- The line of fire against the world; Find Attack Location -----------------------------------

type P = readonly [number, number, number];

/** A flat square navmesh of `cells` × `cells` squares of 100 units from `x0`, two triangles each. */
function grid(formId: number, x0: number, cells: number): Navmesh {
  const vertices: number[] = [];
  for (let j = 0; j <= cells; j++) {
    for (let i = 0; i <= cells; i++) vertices.push(x0 + i * 100, j * 100, 0);
  }
  const v = (i: number, j: number) => j * (cells + 1) + i;
  const t = (i: number, j: number, k: 0 | 1) =>
    i < 0 || j < 0 || i >= cells || j >= cells ? -1 : (j * cells + i) * 2 + k;
  const triangles: Navmesh['triangles'][number][] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      triangles.push({
        vertices: [v(i, j), v(i + 1, j), v(i, j + 1)],
        edges: [t(i, j - 1, 1), t(i, j, 1), t(i - 1, j, 1)],
        flags: 0,
        cover: 0,
      });
      triangles.push({
        vertices: [v(i + 1, j), v(i + 1, j + 1), v(i, j + 1)],
        edges: [t(i + 1, j, 0), t(i, j + 1, 0), t(i, j, 0)],
        flags: 0,
        cover: 0,
      });
    }
  }
  const size = cells * 100;
  return {
    formId,
    world: 0,
    cell: 0,
    vertices: new Float32Array(vertices),
    triangles,
    links: [],
    doors: [],
    coverTriangles: [],
    grid: {
      divisor: 1,
      cellSize: [size, size],
      min: [x0, 0, 0],
      max: [x0 + size, size, 0],
      cells: [],
    },
  };
}

/** Navmeshes side by side, unlinked: one reaches nothing of the other. */
function navmeshes(...meshes: Navmesh[]): NavmeshSet {
  return {
    navmesh: (formId) => meshes.find((mesh) => mesh.formId === formId),
    locate: (point) => {
      for (const mesh of meshes) {
        const [x0, y0] = mesh.grid.min;
        const [x1, y1] = mesh.grid.max;
        const [x, y] = point;
        if (x < x0 || y < y0 || x >= x1 || y >= y1) continue;
        const cells = Math.round((x1 - x0) / 100);
        const i = Math.floor((x - x0) / 100);
        const j = Math.floor((y - y0) / 100);
        const upper = x - x0 - i * 100 + (y - y0 - j * 100) > 100 ? 1 : 0;
        return { navmesh: mesh, triangle: (j * cells + i) * 2 + upper };
      }
      return undefined;
    },
  };
}

const flat = (a: P, b: P) => Math.hypot(a[0] - b[0], a[1] - b[1]);

describe('the line of fire and Find Attack Location', () => {
  const S = COMBAT_SUBTREE_DEFAULTS;

  it('the Find Attack Location settings: the engine’s defaults', () => {
    expect(S.findAttackLocationDistance).toBe(ENGINE.fCombatFindAttackLocationDistance);
    expect(S.findAttackLocationAvoidTargetRadius).toBe(
      ENGINE.fCombatFindAttackLocationAvoidTargetRadius,
    );
    expect(S.findAttackLocationKeyAngle).toBe(ENGINE.fCombatFindAttackLocationKeyAngle);
    expect(S.findAttackLocationKeyHeight).toBe(ENGINE.fCombatFindAttackLocationKeyHeight);
    expect(S.findLateralAttackLocationDistance).toBe(
      ENGINE.fCombatFindLateralAttackLocationDistance,
    );
    expect(S.findLateralAttackLocationIntervalMin).toBe(
      ENGINE.fCombatFindLateralAttackLocationIntervalMin,
    );
    expect(S.findLateralAttackLocationIntervalMax).toBe(
      ENGINE.fCombatFindLateralAttackLocationIntervalMax,
    );
    expect(S.findAllyAttackLocationDistanceMin).toBe(
      ENGINE.fCombatFindAllyAttackLocationDistanceMin,
    );
    expect(S.findAllyAttackLocationDistanceMax).toBe(
      ENGINE.fCombatFindAllyAttackLocationDistanceMax,
    );
    expect(S.findAllyAttackLocationAllyRadius).toBe(ENGINE.fCombatFindAllyAttackLocationAllyRadius);
  });

  it('a wall blocks the line of fire as an actor in the way does', () => {
    const from: P = [0, 0, 90];
    const to: P = [1000, 0, 90];
    const actor = { reference: 1, feet: [500, 0, 0] as P, radius: 30, height: 120 };
    expect(lineOfFire(from, to, [actor], () => true)).toBe('actor');
    expect(lineOfFire(from, to, [], () => false)).toBe('world');
    expect(lineOfFire(from, to, [], () => true)).toBeUndefined();
    // The world not to be asked now: the line counts as clear.
    expect(lineOfFire(from, to, [], () => undefined)).toBeUndefined();
    expect(lineOfFire(from, to, [])).toBeUndefined();
  });

  it('Find Lateral Attack Location: beside it, square to its line, out to 512 units', () => {
    const feet: P = [500, 500, 0];
    const target: P = [500, 1500, 0];
    // The shortest step each time (fCombatFindLateralAttackLocationIntervalMin, 64): 8 a side,
    // its right (east of a line north) first at each.
    const places = lateralAttackPlaces(feet, target, 1, () => 0);
    expect(places).toHaveLength(16);
    expect(places[0]).toEqual([564, 500, 0]);
    expect(places[1]).toEqual([436, 500, 0]);
    expect(places.at(-2)).toEqual([1012, 500, 0]);
    expect(places.every((place) => place[1] === 500)).toBe(true);
    // The longest (…IntervalMax, 128): 4 a side; its left first when asked.
    const wide = lateralAttackPlaces(feet, target, -1, () => 1);
    expect(wide).toHaveLength(8);
    expect(wide[0]).toEqual([372, 500, 0]);
  });

  it('Find Lateral Attack Location: only where its way reaches over the navmeshes', () => {
    const set = navmeshes(grid(1, 0, 10), grid(2, 1000, 10));
    const places = lateralAttackPlaces([500, 500, 0], [500, 1500, 0], 1, () => 0, set);
    // 1012 lies on the other navmesh, which its way does not reach; −12 off the navmeshes.
    expect(places.some((place) => place[0] > 1000 || place[0] < 0)).toBe(false);
    expect(places).toHaveLength(14);
  });

  it('Find Attack Location: over the navmeshes within 1024, off the target, within range', () => {
    const set = navmeshes(grid(1, 0, 30));
    const feet: P = [1500, 300, 0];
    const target: P = [1500, 1300, 0];
    const range = 1200;
    const places = attackLocationPlaces(set, feet, target, range);
    expect(places.length).toBeGreaterThan(0);
    expect(places.length).toBeLessThanOrEqual(24);
    for (const place of places) {
      expect(flat(place, feet)).toBeLessThanOrEqual(S.findAttackLocationDistance);
      expect(flat(place, target)).toBeGreaterThanOrEqual(S.findAttackLocationAvoidTargetRadius);
      expect(flat(place, target)).toBeLessThanOrEqual(range);
    }
    // Spread: none within fCombatFindLateralAttackLocationIntervalMin of another.
    for (const [i, a] of places.entries()) {
      for (const b of places.slice(i + 1)) {
        expect(flat(a, b)).toBeGreaterThanOrEqual(S.findLateralAttackLocationIntervalMin);
      }
    }
    // The first clear one is taken: here, with a wall west of x = 1700, the first east of it.
    const clear = firstClearPlace(places, (place) => place[0] > 1700);
    expect(clear?.[0]).toBeGreaterThan(1700);
    expect(firstClearPlace(places, () => false)).toBeUndefined();
  });

  it('Find Ally Attack Location: beside an ally with a clear line, 256 .. 4096 off the target', () => {
    const target: P = [0, 0, 0];
    const feet: P = [400, 1000, 0];
    const ally = { feet: [0, 1000, 0] as P, radius: 30 };
    const places = allyAttackPlaces(feet, target, [ally]);
    // Its radius and fCombatFindAllyAttackLocationAllyRadius out, either side; the shooter's first.
    expect(places).toEqual([
      [94, 1000, 0],
      [-94, 1000, 0],
    ]);
    // Too near the target, or too far from it: none.
    expect(allyAttackPlaces(feet, target, [{ feet: [0, 200, 0], radius: 30 }])).toEqual([]);
    expect(allyAttackPlaces(feet, target, [{ feet: [0, 5000, 0], radius: 30 }])).toEqual([]);
  });

  it('a failed search stands while its target stays within 5° and 128 units of where it was', () => {
    const feet: P = [0, 0, 0];
    const failed = attackLocationKey(feet, [0, 1000, 0]);
    expect(attackLocationKeyHolds(failed, attackLocationKey(feet, [50, 1000, 100]))).toBe(true);
    // Its target moved round it past 5°, or up past 128 units: it looks again.
    expect(attackLocationKeyHolds(failed, attackLocationKey(feet, [100, 1000, 0]))).toBe(false);
    expect(attackLocationKeyHolds(failed, attackLocationKey(feet, [0, 1000, 200]))).toBe(false);
    // It moved itself (strafing): the same.
    expect(attackLocationKeyHolds(failed, attackLocationKey([-200, 0, 0], [0, 1000, 0]))).toBe(
      false,
    );
  });
});
