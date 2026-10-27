import { describe, expect, it } from 'vitest';
import { ProjectileFlag, ProjectileType } from '../../world/projectile-data.ts';
import {
  aimDirection,
  bounceLobber,
  explosionFalloff,
  flightKind,
  inCone,
  inRadius,
  launchCone,
  launchFlight,
  pathHitsActor,
  stepFlight,
  sweepCone,
  withinProximity,
  WORLD_GRAVITY,
  type FlightData,
} from './projectile-flight.ts';

const missile: FlightData = {
  type: ProjectileType.missile,
  flags: 0,
  speed: 2500,
  gravity: 0,
  range: 10000,
  lifetime: 0,
  collisionRadius: 10,
  proximity: 0,
  timer: 0,
};

const human = (x: number, y: number) => ({
  feet: [x, y, 0] as const,
  height: 128,
  radius: 24,
});

describe('a projectile in flight', () => {
  it('flies straight at its speed and ends at its range', () => {
    const flight = launchFlight({ ...missile, range: 3000 }, [0, 0, 100], [0, 1, 0]);
    const first = stepFlight(flight, 1);
    expect(first.to[1]).toBeCloseTo(2500, 6);
    expect(first.to[2]).toBeCloseTo(100, 6);
    expect(flight.spent).toBe(false);
    const second = stepFlight(flight, 1);
    // The step ends at its range.
    expect(second.to[1]).toBeCloseTo(3000, 6);
    expect(flight.spent).toBe(true);
    expect(flight.traveled).toBeCloseTo(3000, 6);
  });

  it("falls by its gravity × the world's", () => {
    const arrow = { ...missile, type: ProjectileType.arrow, gravity: 0.35, speed: 3600 };
    const flight = launchFlight(arrow, [0, 0, 0], [0, 1, 0]);
    const { to } = stepFlight(flight, 0.5);
    expect(to[2]).toBeCloseTo(-0.5 * 0.35 * WORLD_GRAVITY * 0.25, 6);
    expect(flight.velocity[2]).toBeCloseTo(-0.35 * WORLD_GRAVITY * 0.5, 6);
    // 9.8 m/s² in game units (Havok's 69.99 units a metre).
    expect(WORLD_GRAVITY).toBeCloseTo(686, 0);
  });

  it('is spent by its lifetime and its alternative trigger timer', () => {
    const flight = launchFlight({ ...missile, lifetime: 0.5 }, [0, 0, 0], [1, 0, 0]);
    stepFlight(flight, 0.4);
    expect(flight.spent).toBe(false);
    stepFlight(flight, 0.2);
    expect(flight.spent).toBe(true);
    const timed = launchFlight(
      { ...missile, flags: ProjectileFlag.altTrigger, timer: 1 },
      [0, 0, 0],
      [1, 0, 0],
    );
    stepFlight(timed, 1);
    expect(timed.spent).toBe(true);
  });

  it('meets an actor on its path by its own thickness', () => {
    const t = pathHitsActor([0, 0, 64], [0, 1000, 64], 10, human(0, 500));
    expect(t).toBeDefined();
    expect(t).toBeGreaterThan(0.45);
    expect(t).toBeLessThan(0.5);
    // Above its head, or beside it.
    expect(pathHitsActor([0, 0, 300], [0, 1000, 300], 10, human(0, 500))).toBeUndefined();
    expect(pathHitsActor([100, 0, 64], [100, 1000, 64], 10, human(0, 500))).toBeUndefined();
    // Within an alternative trigger's proximity.
    const near = { ...missile, flags: ProjectileFlag.altTrigger, proximity: 100 };
    expect(withinProximity(near, [0, 400, 64], human(0, 500))).toBe(true);
    expect(withinProximity(missile, [0, 400, 64], human(0, 500))).toBe(false);
  });
});

describe('cones, areas and explosions', () => {
  it('sweep the actors within a cone', () => {
    const north = aimDirection(0, 0);
    expect(north[1]).toBeCloseTo(1, 9);
    expect(inCone([0, 0, 64], north, 1000, 15, human(0, 800))).toBe(true);
    // 45° off the aim, beyond 15° of spread.
    expect(inCone([0, 0, 64], north, 1000, 15, human(600, 600))).toBe(false);
    // Out of range.
    expect(inCone([0, 0, 64], north, 1000, 15, human(0, 1500))).toBe(false);
    expect(inCone([0, 0, 64], aimDirection(Math.PI / 4, 0), 1000, 15, human(600, 600))).toBe(true);
  });

  it('reach the actors within an area, less force farther from the burst', () => {
    expect(inRadius([0, 0, 0], 320, human(0, 300))).toBe(true);
    expect(inRadius([0, 0, 0], 320, human(0, 400))).toBe(false);
    expect(explosionFalloff(0, 320)).toBe(1);
    expect(explosionFalloff(160, 320)).toBeCloseTo(0.5, 9);
    expect(explosionFalloff(400, 320)).toBe(0);
  });

  it('fly by their type', () => {
    expect(flightKind(missile)).toBe('flying');
    expect(flightKind({ type: ProjectileType.lobber, flags: 0 })).toBe('lobber');
    expect(flightKind({ type: ProjectileType.beam, flags: 0 })).toBe('instant');
    expect(flightKind({ type: ProjectileType.missile, flags: ProjectileFlag.hitscan })).toBe(
      'instant',
    );
    expect(flightKind({ type: ProjectileType.flame, flags: 0 })).toBe('spray');
    expect(flightKind({ type: ProjectileType.cone, flags: 0 })).toBe('cone');
  });
});

describe('a cone’s wave', () => {
  it('reaches an actor as its front passes it, at its speed, each once', () => {
    const wave = launchCone([0, 0, 64], [0, 1, 0], 1000, 15, 2000);
    const shapes = [
      [1, human(0, 600)] as const,
      [2, human(0, 200)] as const,
      [3, human(500, 300)] as const,
    ];
    expect(sweepCone(wave, 0, shapes)).toEqual([]);
    expect(sweepCone(wave, 0.1, shapes)).toEqual([2]);
    expect(sweepCone(wave, 0.1, shapes)).toEqual([]);
    expect(sweepCone(wave, 0.1, shapes)).toEqual([1]);
    // Out of its spread: never.
    expect(sweepCone(wave, 1, shapes)).toEqual([]);
    expect(wave.front).toBe(1000);
  });
});

describe('a lobber', () => {
  const rune: FlightData = {
    ...missile,
    type: ProjectileType.lobber,
    flags: ProjectileFlag.explosion | ProjectileFlag.altTrigger,
    speed: 1000,
    proximity: 150,
  };

  it('rests where it lands (fGrenadeRestitution 0) and waits for its trigger', () => {
    const flight = launchFlight(rune, [0, 0, 100], [0, 1, -1]);
    expect(bounceLobber(flight, [0, 70, 0], [0, 0, 1])).toBe(true);
    expect(flight.resting).toBe(true);
    const step = stepFlight(flight, 30);
    expect(step.to).toEqual([0, 70, 0]);
    expect(flight.spent).toBe(false);
  });

  it('bounces back by its restitution, losing its friction’s share along the surface', () => {
    const flight = launchFlight({ ...rune, speed: 1000 }, [0, 0, 100], [0, 1, -1]);
    const resting = bounceLobber(flight, [0, 70, 0], [0, 0, 1], {
      restitution: 0.5,
      friction: 0.5,
    });
    expect(resting).toBe(false);
    expect(flight.velocity[2]).toBeCloseTo(1000 * Math.SQRT1_2 * 0.5, 6);
    expect(flight.velocity[1]).toBeCloseTo(1000 * Math.SQRT1_2 * 0.5, 6);
  });
});
