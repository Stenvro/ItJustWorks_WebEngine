import { describe, expect, it } from 'vitest';
import { GpuScene } from './scene-renderer.ts';

// GpuScene's whole-scene culling bound and its shadow casters' order, with stand-ins for the
// GPU objects (only their identity matters here).
type Draws = ConstructorParameters<typeof GpuScene>[0];

const pipeline = (): object => ({ kind: 'pipeline' });
const buffer = (): object => ({ kind: 'buffer' });

function draw(
  center: [number, number, number],
  radius: number,
  options: { sky?: boolean; shadow?: object; vertices?: object } = {},
): Draws[number] {
  return {
    part: {
      shadowPipeline: options.shadow,
      vertexBuffer: options.vertices ?? buffer(),
      bindGroup: {},
    },
    uniformOffset: 0,
    center,
    radius,
    sky: options.sky ?? false,
  } as unknown as Draws[number];
}

function scene(draws: Draws[number][]): GpuScene {
  // Its bind group and uniform buffer: plain objects (no GPU in the tests).
  const args: unknown[] = [draws, {}, {}, new ArrayBuffer(0), [], [], []];
  return Reflect.construct<unknown[], GpuScene>(GpuScene, args);
}

describe('GpuScene.bound', () => {
  it('holds every draw, and follows a draw that moved', () => {
    const moved = draw([0, 0, 0], 10);
    const s = scene([moved, draw([100, 0, 0], 20)]);
    const check = (): void => {
      const bound = s.bound;
      expect(bound).not.toBeNull();
      for (const d of s.draws) {
        const distance = Math.hypot(
          d.center[0] - (bound?.center[0] ?? 0),
          d.center[1] - (bound?.center[1] ?? 0),
          d.center[2] - (bound?.center[2] ?? 0),
        );
        expect(distance + d.radius).toBeLessThanOrEqual((bound?.radius ?? 0) + 1e-9);
      }
    };
    check();
    moved.center = [0, 500, 0];
    s.boundChanged();
    check();
  });

  it('is null when a draw is never culled (the sky)', () => {
    expect(scene([draw([0, 0, 0], 1), draw([0, 0, 0], 1, { sky: true })]).bound).toBeNull();
  });
});

describe('GpuScene.shadowCasters', () => {
  it('keeps only casters, instances of one mesh next to each other', () => {
    const shadow = pipeline();
    const rock = buffer();
    const tree = buffer();
    const draws = [
      draw([0, 0, 0], 1, { shadow, vertices: rock }),
      draw([0, 0, 0], 1, { shadow, vertices: tree }),
      draw([0, 0, 0], 1),
      draw([0, 0, 0], 1, { shadow, vertices: rock }),
    ];
    const casters = scene(draws).shadowCasters;
    expect(casters).toHaveLength(3);
    // The two rocks (draws 0 and 3) next to each other.
    const order = casters.map((d) => draws.indexOf(d));
    expect(Math.abs(order.indexOf(0) - order.indexOf(3))).toBe(1);
  });
});
