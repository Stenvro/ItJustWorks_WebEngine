import { describe, expect, it } from 'vitest';
import { shotAxes, turnAngle } from './camera-model.ts';
import type { Vec3 } from './math.ts';

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const degrees = (radians: number): number => (radians * 180) / Math.PI;

describe('shotAxes', () => {
  const position: Vec3 = [100, -200, 120];
  const target: Vec3 = [0, 0, 100];
  const way: Vec3 = [-100, 200, -20];
  const length = Math.hypot(...way);
  const toTarget: Vec3 = [way[0] / length, way[1] / length, way[2] / length];

  it('looks straight at the target with the world up kept, without a turn', () => {
    const { forward, up } = shotAxes(position, target);
    expect(dot(forward, toTarget)).toBeCloseTo(1, 6);
    expect(dot(forward, up)).toBeCloseTo(0, 6);
    expect(up[2]).toBeGreaterThan(0.9);
  });

  it("turns within the look's frame by the model root's own rotation", () => {
    // 20 degrees about the frame's up: the camera looks 20 degrees left of its target.
    const angle = (20 * Math.PI) / 180;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const turn = [c, -s, 0, s, c, 0, 0, 0, 1];
    expect(degrees(turnAngle(turn))).toBeCloseTo(20, 4);
    const straight = shotAxes(position, target);
    const { forward, up } = shotAxes(position, target, turn);
    expect(degrees(Math.acos(dot(forward, toTarget)))).toBeCloseTo(20, 4);
    // A yaw keeps the up.
    expect(dot(up, straight.up)).toBeCloseTo(1, 6);
    // Left: against the frame's right (forward × world up).
    const right: Vec3 = [toTarget[1], -toTarget[0], 0];
    expect(dot(forward, right)).toBeLessThan(0);
  });

  it('keeps a frame looking straight down', () => {
    const { forward, up } = shotAxes([0, 0, 500], [0, 0, 0]);
    expect(forward).toEqual([0, 0, -1]);
    expect(Math.hypot(...up)).toBeCloseTo(1, 6);
  });
});
