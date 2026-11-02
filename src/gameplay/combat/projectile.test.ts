import { describe, expect, it } from 'vitest';
import {
  expiredArrows,
  fly,
  homeOn,
  launch,
  nearestToLine,
  segmentEntersCylinder,
  standInReach,
  WORLD_GRAVITY,
} from './projectile.ts';

describe('arrows stuck in actors', () => {
  it('go when old, when their actor is gone, and past each actor’s most', () => {
    const arrows = [
      { target: 1, until: 5 },
      { target: 1, until: 40 },
      { target: 1, until: 41 },
      { target: 1, until: 42 },
      { target: 2, until: 43 },
      { target: 3, until: 44 },
    ];
    const gone = expiredArrows(arrows, 10, 3, (target) => target !== 3);
    expect(gone.map((arrow) => arrow.until)).toEqual([44, 5]);
    expect(expiredArrows(arrows.slice(1, 5), 10, 2, () => true)).toEqual([arrows[1]]);
  });
});

describe('arrows in flight', () => {
  it('falls under gravity from where it was loosed', () => {
    const flight = launch([0, 0, 100], [0, 1, 0], 3000);
    for (let i = 0; i < 30; i++) fly(flight, 1 / 60, WORLD_GRAVITY);
    expect(flight.position[1]).toBeCloseTo(1500, 0);
    expect(flight.position[2]).toBeLessThan(100);
  });

  it('flies onto a moving target when it always hits (Always Hit)', () => {
    const flight = launch([0, 0, 100], [0, 1, 0], 3000);
    // The target runs across the aim: the shot meets it all the same.
    let target: [number, number, number] = [0, 1500, 100];
    let nearest = Infinity;
    for (let i = 0; i < 90; i++) {
      target = [target[0] + 300 / 60, target[1], target[2]];
      homeOn(flight, target);
      fly(flight, 1 / 60, 0);
      const [x, y, z] = flight.position;
      nearest = Math.min(nearest, Math.hypot(x - target[0], y - target[1], z - target[2]));
    }
    expect(nearest).toBeLessThan(60);
    // At its own speed.
    expect(Math.hypot(...flight.velocity)).toBeCloseTo(3000, 3);
  });
});

describe('a shot meeting a character controller', () => {
  const dragon = { feet: [0, 0, 1000] as const, radius: 320, height: 384 };

  it('enters it through its side, its bottom or its top', () => {
    // Level, from the side: where it reaches the radius.
    expect(segmentEntersCylinder([-1000, 0, 1200], [1, 0, 0], 2000, dragon)).toBeCloseTo(680);
    // Straight up from under it (a flier overhead): at its bottom.
    expect(segmentEntersCylinder([0, 100, 0], [0, 0, 1], 2000, dragon)).toBeCloseTo(1000);
    // Steeply up from beside it: through the bottom, inside the radius.
    const up = Math.SQRT1_2;
    expect(segmentEntersCylinder([-900, 0, 200], [up, 0, up], 2000, dragon)).toBeCloseTo(800 / up);
    // Straight down onto its top.
    expect(segmentEntersCylinder([0, 0, 2000], [0, 0, -1], 1000, dragon)).toBeCloseTo(616);
  });

  it('misses it beside, under, over, beyond the step, and starts inside it at 0', () => {
    expect(segmentEntersCylinder([-1000, 400, 1200], [1, 0, 0], 2000, dragon)).toBeUndefined();
    expect(segmentEntersCylinder([-1000, 0, 900], [1, 0, 0], 2000, dragon)).toBeUndefined();
    expect(segmentEntersCylinder([-1000, 0, 1500], [1, 0, 0], 2000, dragon)).toBeUndefined();
    expect(segmentEntersCylinder([-1000, 0, 1200], [1, 0, 0], 600, dragon)).toBeUndefined();
    expect(segmentEntersCylinder([0, 0, 1100], [1, 0, 0], 50, dragon)).toBe(0);
  });
});

describe('a shot through a flier’s stand-in shape', () => {
  const dragon = { feet: [0, 0, 1000] as const, radius: 320, height: 384 };

  it('looks on through the cylinder’s widest way past where it entered', () => {
    const entered = segmentEntersCylinder([-1000, 0, 1100], [1, 0, 0], 2000, dragon) ?? 0;
    expect(entered).toBeCloseTo(680);
    expect(standInReach(entered, dragon)).toBeCloseTo(680 + Math.hypot(640, 384));
  });

  it('lies at the line’s point nearest the skeleton node nearest it, not on the cylinder', () => {
    // A level shot 30 units beside a node: the arrow lies there, 320 units past the cylinder's
    // side where the shot entered.
    const nodes: [number, number, number][] = [
      [0, 0, 1000],
      [0, 30, 1100],
      [150, 0, 1250],
    ];
    const from: [number, number, number] = [-1000, 0, 1100];
    const near = nearestToLine(nodes, from, [1, 0, 0], standInReach(680, dragon));
    expect(near?.index).toBe(1);
    expect(near?.gap).toBeCloseTo(30);
    expect(near?.point[0]).toBeCloseTo(0);
    // Beyond its reach the line ends there.
    expect(nearestToLine([[5000, 0, 1100]], from, [1, 0, 0], 2000)?.point[0]).toBeCloseTo(1000);
    expect(nearestToLine([], from, [1, 0, 0], 2000)).toBeUndefined();
  });
});
