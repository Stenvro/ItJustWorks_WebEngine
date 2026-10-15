import { describe, expect, it } from 'vitest';
import { nearestRing, RING_SKILLS, starPlace, treeMiddle } from './skills-ring.ts';
import type { SkillRecord } from '../world/perk-trees.ts';

const node = (index: number, column: number, row: number) => ({
  index,
  perk: 0x100 + index,
  flags: 1,
  column,
  row,
  offsetX: 0,
  offsetY: 0,
  skill: undefined,
  children: [],
});

describe('skills ring', () => {
  it('has the eighteen skills once each', () => {
    expect(new Set(RING_SKILLS).size).toBe(18);
    expect(RING_SKILLS[1]).toBe(10); // Smithing at Point01
    expect(RING_SKILLS[9]).toBe(14); // Lockpicking at Point09
  });

  it('puts a tree about its point, rows up its image', () => {
    const skill: SkillRecord = {
      formId: 1,
      editorId: 'AVLockpicking',
      name: 'Lockpicking',
      nodes: [node(1, 0, 0), node(2, 4, 4)],
    };
    expect(treeMiddle(skill)).toBe(2);
    // Point09: 180°, out along −Y, right along −X.
    const [x, y, z] = starPlace(skill, node(1, 0, 0), 9);
    expect(x).toBeCloseTo(10, 5);
    expect(y).toBeCloseTo(-92, 5);
    expect(z).toBeCloseTo(-2, 5);
    expect(starPlace(skill, node(2, 4, 4), 9)[2]).toBeCloseTo(22, 5);
  });

  it('finds the ring position nearest a heading', () => {
    expect(nearestRing(0)).toBe(0);
    expect(nearestRing(29)).toBe(1);
    expect(nearestRing(-15)).toBe(17);
    expect(nearestRing(359)).toBe(0);
  });
});
