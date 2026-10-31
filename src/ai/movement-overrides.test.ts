import { describe, expect, it } from 'vitest';
import {
  KEEP_OFFSET_FULL_SPEED,
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

  it('goes for its place at a speed growing from the follow radius to the catch-up radius', () => {
    // 100 from its place: (100 − 20) / (300 − 20) of the planner's full speed (3).
    const near = keepOffsetRequest(keep, { position: [800, 0, 50], heading: 0 }, east);
    expect(near.direction?.[0]).toBeCloseTo(100);
    expect(near.pace).toBeCloseTo((80 / 280) * KEEP_OFFSET_FULL_SPEED);
    expect(near.gait).toBe('walk');
    expect(near.face).toBeCloseTo(Math.PI);
    // Halfway between the radii: 1.5, between a walk and a run.
    const half = keepOffsetRequest(keep, { position: [740, 0, 50], heading: 0 }, east);
    expect(half.pace).toBeCloseTo(1.5);
    expect(half.gait).toBe('run');
    // Beyond the catch-up radius: full speed, still facing as the offset turns it.
    const far = keepOffsetRequest(keep, { position: [0, 0, 50], heading: 0 }, east);
    expect(far.pace).toBe(KEEP_OFFSET_FULL_SPEED);
    expect(far.face).toBeCloseTo(Math.PI);
  });

  it('counts the height in its distance', () => {
    const above = keepOffsetRequest(keep, { position: [900, 15, 50 + 20], heading: 0 }, east);
    // 25 from its place (15 across, 20 up): past the follow radius by 5.
    expect(above.pace).toBeCloseTo((5 / 280) * KEEP_OFFSET_FULL_SPEED);
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
