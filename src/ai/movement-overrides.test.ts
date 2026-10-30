import { describe, expect, it } from 'vitest';
import {
  controlsRequest,
  keepOffsetOf,
  keepOffsetRequest,
  offsetPlace,
} from './movement-overrides.ts';

describe('KeepOffsetFromActor', () => {
  // 100 units behind the target, facing as it faces turned a quarter right.
  const keep = keepOffsetOf(7, [0, -100, 0], [0, 0, 90], 300, 20);
  const east = { position: [1000, 0, 50] as const, heading: Math.PI / 2 };

  it('places the offset in the target’s frame, turned by its heading', () => {
    const place = offsetPlace(keep, east);
    expect(place[0]).toBeCloseTo(900);
    expect(place[1]).toBeCloseTo(0);
    expect(place[2]).toBe(50);
  });

  it('stands within the follow radius, facing the target’s heading plus the angle', () => {
    const request = keepOffsetRequest(keep, { position: [905, 5, 50], heading: 0 }, east);
    expect(request.direction).toBeUndefined();
    expect(request.face).toBeCloseTo(Math.PI);
  });

  it('walks to its place between the radii and runs to catch up beyond', () => {
    const near = keepOffsetRequest(keep, { position: [800, 0, 50], heading: 0 }, east);
    expect(near.gait).toBe('walk');
    expect(near.direction?.[0]).toBeCloseTo(100);
    const far = keepOffsetRequest(keep, { position: [0, 0, 50], heading: 0 }, east);
    expect(far.gait).toBe('run');
    expect(far.face).toBeUndefined();
  });
});

describe("an actor under the player's controls", () => {
  it('goes the way the controls ask, turned by the camera, at their gait', () => {
    const request = controlsRequest({ x: 0, y: 1, running: true }, Math.PI / 2);
    expect(request.gait).toBe('run');
    expect(request.direction?.[0]).toBeCloseTo(1);
    expect(request.direction?.[1]).toBeCloseTo(0);
  });

  it('stands without input', () => {
    expect(controlsRequest({ x: 0, y: 0, running: false }, 0)).toEqual({ gait: 'walk' });
  });
});
