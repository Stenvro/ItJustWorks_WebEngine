import { describe, expect, it } from 'vitest';
import {
  boundingSphere,
  fitFocusShadow,
  FOCUS_SHADOW_DISTANCE,
  MAX_FOCUS_SHADOWS,
  selectFocusShadows,
  type FocusCandidate,
} from './focus-shadows.ts';
import { invert, project } from './frustum.ts';
import { lookAt, multiply, perspectiveReversedZ, type Vec3 } from './math.ts';
import { fitCascades } from './shadow-cascades.ts';

const body = (name: string, x: number, player = false, halfWidth = 30): FocusCandidate<string> => ({
  center: [x, 0, 64],
  radius: 70,
  halfWidth,
  player,
  target: name,
});
const names = (chosen: readonly FocusCandidate<string>[]): string[] =>
  chosen.map((candidate) => candidate.target);

describe('selectFocusShadows', () => {
  const player: Vec3 = [0, 0, 64];

  it('gives the player the first map, then the nearest bodies within the distance', () => {
    const candidates = [
      body('far', 300),
      body('near', 100),
      body('out', FOCUS_SHADOW_DISTANCE + 200),
      body('player', 0, true),
    ];
    expect(names(selectFocusShadows(candidates, player))).toEqual(['player', 'near', 'far']);
  });

  it('takes a body’s size off its distance, as the engine keys them', () => {
    // 460 away but 120 wide: 460² − 120² < 450².
    expect(names(selectFocusShadows([body('wide', 460, false, 120)], player))).toEqual(['wide']);
    expect(names(selectFocusShadows([body('narrow', 460, false, 10)], player))).toEqual([]);
  });

  it('stops at iNumFocusShadow and never passes the atlas', () => {
    const many = Array.from({ length: 8 }, (_, i) => body(`npc${String(i)}`, 20 + i * 10));
    expect(selectFocusShadows(many, player, 2)).toHaveLength(2);
    expect(selectFocusShadows(many, player, 99)).toHaveLength(MAX_FOCUS_SHADOWS);
    expect(selectFocusShadows(many, player, 0)).toHaveLength(0);
  });
});

describe('boundingSphere', () => {
  it('holds every sphere and reports the horizontal half extent', () => {
    const spheres = [
      { center: [0, 0, 20] as Vec3, radius: 20 },
      { center: [0, 0, 110] as Vec3, radius: 15 },
      { center: [30, 0, 60] as Vec3, radius: 10 },
    ];
    const bound = boundingSphere(spheres);
    if (!bound) throw new Error('no bound');
    for (const sphere of spheres) {
      const distance = Math.hypot(
        sphere.center[0] - bound.center[0],
        sphere.center[1] - bound.center[1],
        sphere.center[2] - bound.center[2],
      );
      expect(distance + sphere.radius).toBeLessThanOrEqual(bound.radius + 1e-6);
    }
    expect(bound.halfWidth).toBe(30);
    expect(boundingSphere([])).toBeUndefined();
  });
});

describe('fitFocusShadow', () => {
  const toLight: Vec3 = [0.3, -0.4, 0.866];
  const center: Vec3 = [1200, 2400, 560];
  const focus = fitFocusShadow(center, 70, toLight, 1024);

  it('holds the body and its shadow on the ground behind it in its square', () => {
    for (const point of [
      center,
      [center[0] + 60, center[1], center[2] + 60],
      // Down the sun's ray from the body's centre to the ground 500 units below.
      [center[0] - 0.3 * 577, center[1] + 0.4 * 577, center[2] - 0.866 * 577],
    ] as Vec3[]) {
      const [x, y, z] = project(focus.viewProj, point);
      expect(Math.abs(x)).toBeLessThan(1);
      expect(Math.abs(y)).toBeLessThan(1);
      expect(z).toBeGreaterThan(0);
      expect(z).toBeLessThan(1);
    }
    // Beside the body, out of its square.
    const aside = project(focus.viewProj, [center[0] + 400, center[1], center[2]]);
    expect(Math.max(Math.abs(aside[0]), Math.abs(aside[1]))).toBeGreaterThan(1);
  });

  it('is much sharper than the nearest cascade', () => {
    const viewProj = multiply(
      perspectiveReversedZ(Math.PI / 3, 16 / 9, 4),
      lookAt([1000, 2000, 600], [1200, 2400, 560], [0, 0, 1]),
    );
    const inverse = invert(viewProj);
    if (!inverse) throw new Error('singular');
    const [first] = fitCascades(inverse, 4, toLight, 2048);
    expect(focus.texelSize * 3).toBeLessThan(first?.texelSize ?? 0);
  });

  it('snaps to whole texels, so a body moving less than a texel keeps its grid', () => {
    const a = fitFocusShadow(center, 70, toLight, 1024);
    const b = fitFocusShadow([center[0] + 0.01, center[1], center[2]], 70, toLight, 1024);
    const point: Vec3 = [1210, 2390, 520];
    const [ax, ay] = project(a.viewProj, point);
    const [bx, by] = project(b.viewProj, point);
    expect(bx).toBeCloseTo(ax, 6);
    expect(by).toBeCloseTo(ay, 6);
  });
});
