import { describe, expect, it } from 'vitest';
import { boltAlpha, growBolts, layOutBolts, scaleArc } from './lightning.ts';
import { random } from './particle-sim.ts';

const SHAPE = {
  length: 512,
  lengthVariation: 0,
  width: 4,
  childWidthMultiplier: 0.5,
  arcOffset: 20,
};

describe('procedural lightning bolts', () => {
  it('grow a main bolt with between branches − variation and branches + variation branches', () => {
    const next = random(7);
    for (let i = 0; i < 50; i++) {
      const bolts = growBolts(6, 2, 1, next);
      const main = bolts[0];
      expect(main).toMatchObject({ parent: -1, level: 6, depth: 0 });
      const children = bolts.filter((bolt) => bolt.parent === 0);
      expect(children.length).toBeGreaterThanOrEqual(1);
      expect(children.length).toBeLessThanOrEqual(3);
      for (const child of children) expect(child).toMatchObject({ level: 5, depth: 1 });
      // Branches of branches get half the branches (1 ± 0).
      for (const bolt of bolts.filter((b) => b.depth === 2)) expect(bolt.level).toBe(4);
    }
    expect(growBolts(6, 0, 0, next)).toHaveLength(1);
  });

  it('lay out along Y, their ends on the line, astray within the arc offset', () => {
    const next = random(3);
    const bolts = growBolts(6, 1, 0, next);
    layOutBolts(bolts, SHAPE, next);
    const main = bolts[0];
    if (!main) throw new Error('no main bolt');
    const points = main.points;
    expect(points).toHaveLength(65 * 3);
    expect([points[0], points[1], points[2]]).toEqual([0, 0, 0]);
    expect(points[64 * 3]).toBeCloseTo(0);
    expect(points[64 * 3 + 1]).toBeCloseTo(512);
    expect(points[64 * 3 + 2]).toBeCloseTo(0);
    let farthest = 0;
    for (let k = 0; k <= 64; k++) {
      farthest = Math.max(farthest, Math.hypot(points[k * 3] ?? 0, points[k * 3 + 2] ?? 0));
    }
    // Each level adds at most half the one before: under twice the arc offset in all.
    expect(farthest).toBeGreaterThan(0);
    expect(farthest).toBeLessThan(2 * SHAPE.arcOffset);
    expect(main.halfWidth).toBe(2);
    // The branch: half as long, half as wide (childWidthMultiplier), from the main bolt's
    // first half.
    const branch = bolts[1];
    if (!branch) throw new Error('no branch');
    expect(branch.halfWidth).toBe(1);
    const startY = branch.points[1] ?? 0;
    expect(startY).toBeGreaterThanOrEqual(0);
    expect(startY).toBeLessThan(256);
    expect((branch.points[32 * 3 + 1] ?? 0) - startY).toBeCloseTo(256);
  });

  it('scale how far they stray with the arc offset', () => {
    const next = random(5);
    const bolts = growBolts(4, 0, 0, next);
    layOutBolts(bolts, SHAPE, next);
    const before = Array.from(bolts[0]?.points ?? []);
    scaleArc(bolts, 2);
    const after = Array.from(bolts[0]?.points ?? []);
    for (let i = 0; i < before.length; i += 3) {
      expect(after[i]).toBeCloseTo((before[i] ?? 0) * 2);
      expect(after[i + 1]).toBeCloseTo(before[i + 1] ?? 0);
      expect(after[i + 2]).toBeCloseTo((before[i + 2] ?? 0) * 2);
    }
  });

  it('are clear at their ends and thin out with their fade flag', () => {
    expect(boltAlpha(true, false, 0, 8)).toBe(0);
    expect(boltAlpha(false, false, 0, 8)).toBe(1);
    expect(boltAlpha(true, false, 4, 8)).toBe(1);
    expect(boltAlpha(true, true, 4, 8)).toBeCloseTo(0.75);
    expect(boltAlpha(false, true, 8, 8)).toBe(0);
  });
});
