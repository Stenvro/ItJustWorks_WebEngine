import { describe, expect, it } from 'vitest';
import { CycleType } from '../formats/nif/animation-blocks.ts';
import { identity, type Mat4 } from './math.ts';
import type { ParticleEmitter, ParticleSystemData } from './particle-data.ts';
import {
  evenKeys,
  PARTICLE_FLOATS,
  ParticleSimulation,
  simpleColor,
  subTextureFrame,
  type ParticleContext,
} from './particle-sim.ts';

const EMITTER_OBJECT = 1;

const emitter = (overrides: Partial<ParticleEmitter> = {}): ParticleEmitter => ({
  name: 'Emitter',
  shape: 'box',
  object: EMITTER_OBJECT,
  size: [0, 0, 0],
  speed: 100,
  speedVariation: 0,
  declination: 0,
  declinationVariation: 0,
  planarAngle: 0,
  planarAngleVariation: 0,
  color: [1, 1, 1, 1],
  radius: 10,
  radiusVariation: 0,
  lifeSpan: 1,
  lifeSpanVariation: 0,
  meshes: [],
  emissionType: 0,
  velocityType: 0,
  emissionAxis: [0, 0, 1],
  ...overrides,
});

const translated = (x: number, y: number, z: number): Mat4 => {
  const m = identity();
  m[12] = x;
  m[13] = y;
  m[14] = z;
  return m;
};

const system = (overrides: Partial<ParticleSystemData> = {}): ParticleSystemData => ({
  name: 'Test',
  block: 0,
  worldSpace: true,
  maxParticles: 100,
  subtextures: [],
  aspectRatio: 1,
  velocityOriented: false,
  material: undefined,
  alpha: undefined,
  shader: -1,
  alphaProperty: -1,
  strip: undefined,
  emitters: [emitter()],
  modifiers: {
    spawnOnDeath: false,
    spawn: undefined,
    gravity: [],
    drag: [],
    bombs: [],
    colliders: [],
    rotation: undefined,
    color: undefined,
    scales: undefined,
    subTexture: undefined,
    recycleBound: undefined,
    inheritVelocity: undefined,
    wind: 0,
    lod: undefined,
    inactive: [],
  },
  tracks: [
    {
      kind: 'float',
      target: 'Emitter',
      param: 'birthRate',
      timing: { frequency: 1, phase: 0, start: 0, stop: 1, cycle: CycleType.loop },
      source: { constant: 20, keys: undefined },
    },
  ],
  sequenceTracks: new Map(),
  objects: new Map([
    [0, identity()],
    [EMITTER_OBJECT, translated(0, 0, 50)],
  ]),
  billboards: new Map(),
  ...overrides,
});

/** Runs a system for `seconds` at 60 updates per second (after its warm-up). */
function run(
  data: ParticleSystemData,
  seconds: number,
  world: Mat4 = identity(),
): { simulation: ParticleSimulation; context: ParticleContext } {
  const simulation = new ParticleSimulation(data, 7);
  let context: ParticleContext = {
    seconds: 0,
    dt: 0,
    instanceWorld: world,
    animated: undefined,
    camera: [0, -500, 0],
    wind: [0, 0, 0],
  };
  simulation.update(context);
  for (let t = 1 / 60; t <= seconds + 1e-9; t += 1 / 60) {
    context = { ...context, seconds: t, dt: 1 / 60 };
    simulation.update(context);
  }
  return { simulation, context };
}

describe('particle modifiers over a particle life', () => {
  it('interpolates evenly spaced scale keys', () => {
    expect(evenKeys([0, 1, 0], 0.25)).toBeCloseTo(0.5, 6);
    expect(evenKeys([0, 1, 0], 0.5)).toBeCloseTo(1, 6);
    expect(evenKeys([2], 0.9)).toBe(2);
  });

  it('blends BSPSysSimpleColorModifier colours and fades alpha in and out', () => {
    const color = {
      name: 'Color',
      fadeIn: 0.2,
      fadeOut: 0.8,
      color1End: 0.1,
      color1Start: 0.3,
      color2End: 0.5,
      color2Start: 1,
      colors: [1, 0, 0, 0, 0, 1, 0, 0.5, 0, 0, 1, 0],
    };
    const at = (t: number): number[] => simpleColor(color, t, [0, 0, 0, 0]);
    expect(at(0.05).slice(0, 3)).toEqual([1, 0, 0]);
    expect(at(0.2)[0]).toBeCloseTo(0.5, 6);
    expect(at(0.4).slice(0, 3)).toEqual([0, 1, 0]);
    expect(at(1).slice(0, 3)).toEqual([0, 0, 1]);
    expect(at(0.1)[3]).toBeCloseTo(0.25, 6);
    expect(at(0.5)[3]).toBe(0.5);
    expect(at(0.9)[3]).toBeCloseTo(0.25, 6);
  });

  it('runs atlas frames, loops from the loop start and holds a loop start at the end', () => {
    expect(subTextureFrame(0, 8, 0, 7, 0.5)).toBe(4);
    expect(subTextureFrame(0, 11, 4, 7, 1)).toBe(7);
    expect(subTextureFrame(0, 12, 4, 7, 1)).toBe(4);
    expect(subTextureFrame(0, 16, 4, 7, 0.75)).toBe(4);
    expect(subTextureFrame(2, 20, 7, 7, 1)).toBe(7);
  });
});

describe('ParticleSimulation', () => {
  it('emits at the birth rate and keeps particles for their life span', () => {
    const { simulation } = run(system(), 3);
    // 20 per second living 1 second.
    expect(simulation.count).toBeGreaterThanOrEqual(18);
    expect(simulation.count).toBeLessThanOrEqual(22);
  });

  it('emits along the emitter object Z axis from its position', () => {
    const { simulation, context } = run(system(), 2);
    const out = new Float32Array(simulation.instanceCount * PARTICLE_FLOATS);
    const written = simulation.write(out, 0, context);
    expect(written).toBe(simulation.count);
    for (let i = 0; i < written; i++) {
      const base = i * PARTICLE_FLOATS;
      expect(out[base]).toBeCloseTo(0, 3);
      expect(out[base + 1]).toBeCloseTo(0, 3);
      // Starts at z 50, moves up at 100 per second for at most a second.
      expect(out[base + 2]).toBeGreaterThanOrEqual(50);
      expect(out[base + 2]).toBeLessThanOrEqual(151);
      expect(out[base + 3]).toBeCloseTo(10, 3);
    }
  });

  it('places world-space particles with the instance and keeps them there', () => {
    const { simulation, context } = run(system(), 1, translated(1000, 2000, 0));
    const out = new Float32Array(simulation.instanceCount * PARTICLE_FLOATS);
    simulation.write(out, 0, context);
    expect(out[0]).toBeCloseTo(1000, 2);
    expect(out[1]).toBeCloseTo(2000, 2);
  });

  it('stops at the system capacity and without a birth rate', () => {
    expect(run(system({ maxParticles: 5 }), 2).simulation.count).toBe(5);
    expect(run(system({ tracks: [] }), 2).simulation.count).toBe(0);
  });

  it('pulls particles with planar gravity and damps them with drag', () => {
    const gravity = system({
      emitters: [emitter({ speed: 0, lifeSpan: 10 })],
      modifiers: {
        ...system().modifiers,
        gravity: [
          {
            name: 'Gravity',
            object: 0,
            axis: [0, 0, -1],
            strength: 100,
            decay: 0,
            forceType: 0,
            turbulence: 0,
            turbulenceScale: 1,
            worldAligned: true,
          },
        ],
      },
      maxParticles: 1,
    });
    const falling = run(gravity, 1);
    const out = new Float32Array(PARTICLE_FLOATS);
    falling.simulation.write(out, 0, falling.context);
    // About ½·g·t² = 50 below the start after one second (plus the warm-up's head start).
    expect(out[2]).toBeLessThan(0);

    const dragged = run(
      system({
        maxParticles: 1,
        emitters: [emitter({ lifeSpan: 10 })],
        modifiers: {
          ...system().modifiers,
          drag: [
            {
              name: 'Drag',
              object: 0,
              axis: [0, 0, 1],
              percentage: 0.1,
              range: Infinity,
              rangeFalloff: Infinity,
            },
          ],
        },
      }),
      1,
    );
    const slowed = new Float32Array(PARTICLE_FLOATS);
    dragged.simulation.write(slowed, 0, dragged.context);
    // Without drag it would have risen 250 units in 2.5 seconds; 10% per frame stops it early.
    expect(slowed[2]).toBeLessThan(50 + 120);
  });

  it('orients quads along the velocity when asked', () => {
    const { simulation, context } = run(system({ velocityOriented: true }), 1);
    const out = new Float32Array(simulation.instanceCount * PARTICLE_FLOATS);
    simulation.write(out, 0, context);
    expect(out[14]).toBeCloseTo(100, 3);
  });

  it('records a ribbon of points for strip particles', () => {
    const { simulation, context } = run(
      system({
        maxParticles: 2,
        tracks: [
          {
            kind: 'float',
            target: 'Emitter',
            param: 'birthRate',
            timing: { frequency: 1, phase: 0, start: 0, stop: 1, cycle: CycleType.loop },
            source: { constant: 1, keys: undefined },
          },
        ],
        emitters: [emitter({ lifeSpan: 5 })],
        strip: { maxPoints: 6, startCapSize: 1, endCapSize: 1, updateDelta: 0.1 },
      }),
      1,
    );
    const out = new Float32Array(simulation.instanceCount * PARTICLE_FLOATS);
    const segments = simulation.write(out, 0, context);
    expect(segments).toBeGreaterThan(simulation.count);
    // Each segment points from an older point towards a newer one (upwards).
    expect(out[14]).toBeGreaterThan(0);
  });
});
