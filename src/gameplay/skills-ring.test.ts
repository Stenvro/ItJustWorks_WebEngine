import { describe, expect, it } from 'vitest';
import {
  cameraMoveShare,
  nearestRing,
  RING_SKILLS,
  ringTurnSpeed,
  ringView,
  STAR_BASE,
  STAR_DISTANCE,
  starPlace,
  starView,
  treeMiddle,
} from './skills-ring.ts';
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

  it('puts a tree about its point, each row further out and up', () => {
    const skill: SkillRecord = {
      formId: 1,
      editorId: 'AVLockpicking',
      name: 'Lockpicking',
      nodes: [node(1, 0, 0), node(2, 4, 4)],
    };
    expect(treeMiddle(skill)).toBe(2);
    // Point09: 180°, out along −Y, right along −X; row 0 fStatsStarZInitialOffset (5) up.
    const [x, y, z] = starPlace(skill, node(1, 0, 0), 9);
    expect(x).toBeCloseTo(10, 4);
    expect(y).toBeCloseTo(-99.34, 4);
    expect(z).toBeCloseTo(4.93, 4);
    // Row 4: 4 × 15 further out, 4 × 9 higher.
    const far = starPlace(skill, node(2, 4, 4), 9);
    expect(far[1]).toBeCloseTo(-159.34, 4);
    expect(far[2]).toBeCloseTo(40.93, 4);
  });

  it('stands the camera before the selected star, looking just above it', () => {
    // Point00: out along +Y.
    const view = starView([0, 120, 20], 0);
    expect(view.position[0]).toBeCloseTo(0, 5);
    expect(view.position[1]).toBeCloseTo(112, 5);
    expect(view.position[2]).toBeCloseTo(20, 5);
    expect(view.target).toEqual([0, 120, 21]);
  });

  it('finds the ring position nearest a heading', () => {
    expect(nearestRing(0)).toBe(0);
    expect(nearestRing(29)).toBe(1);
    expect(nearestRing(-15)).toBe(17);
    expect(nearestRing(359)).toBe(0);
  });
});

describe('ringTurnSpeed', () => {
  const settings = { speedMax: 0.5, rampMs: 2000 };
  const most = (2 * 180) / Math.PI;

  it('rises to 1 / fStatsRotationSpeedMax radians a second over the ramp time', () => {
    expect(ringTurnSpeed(0, 1, 200, 1 / 60, settings)).toBeCloseTo(most * Math.sin(Math.PI / 4));
    expect(ringTurnSpeed(0, 2, 200, 1 / 60, settings)).toBeCloseTo(most);
    // A speed below the most grows by 1.3 an update.
    expect(ringTurnSpeed(10, 0, 200, 1 / 60, settings)).toBeCloseTo(13);
  });

  it('slows as the skill nears and stops there', () => {
    expect(ringTurnSpeed(most, 2, 5, 1 / 60, settings)).toBeCloseTo(most / 4);
    expect(ringTurnSpeed(most, 2, 0.05, 1 / 60, settings)).toBe(0);
  });
});

describe('the ring camera', () => {
  it('stands at the middle, looking at the point faced raised by fStatsSkillsLookAt', () => {
    const view = ringView(0);
    expect(view.position).toEqual([0, 0, 0]);
    expect(view.target[0]).toBeCloseTo(0, 5);
    expect(view.target[1]).toBeCloseTo(STAR_DISTANCE, 5);
    expect(view.target[2]).toBeCloseTo(STAR_BASE + 5, 5);
    // About 3° up.
    expect((Math.atan2(view.target[2], STAR_DISTANCE) * 180) / Math.PI).toBeCloseTo(2.84, 1);
    // Point01 (Smithing), 20° clockwise; settling up from the CameraIntro's end.
    const smithing = ringView(20, -16.44);
    expect(smithing.position).toEqual([0, 0, -16.44]);
    expect(smithing.target[0]).toBeCloseTo(STAR_DISTANCE * Math.sin(Math.PI / 9), 5);
  });

  it('eases a move by half a cosine in a tree and a quarter sine to the ring', () => {
    expect(cameraMoveShare(0, true)).toBe(0);
    expect(cameraMoveShare(0.5, true)).toBeCloseTo(0.5);
    expect(cameraMoveShare(0.25, true)).toBeCloseTo((1 - Math.SQRT1_2) / 2);
    expect(cameraMoveShare(1, true)).toBeCloseTo(1);
    expect(cameraMoveShare(0.5, false)).toBeCloseTo(Math.SQRT1_2);
    expect(cameraMoveShare(2, false)).toBe(1);
  });
});
