import { describe, expect, it } from 'vitest';
import { ProjectileFlag, ProjectileType } from '../../world/projectile-data.ts';
import {
  aimDirection,
  bounceLobber,
  lightsGivingWay,
  explosionFalloff,
  flightKind,
  inCone,
  inRadius,
  launchCone,
  launchFlight,
  LOBBER_DEFAULTS,
  lobberAgeMax,
  lobberOutlived,
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

describe('a Magelight on a surface', () => {
  it('ends the same caster’s earlier ones, not another’s (UESP "Skyrim:Magelight")', () => {
    const stuck = (caster: number) => ({ flying: { delivered: { caster } } });
    const mine = stuck(7);
    const theirs = stuck(8);
    expect(lightsGivingWay([mine, theirs], 7)).toEqual([mine]);
    expect(lightsGivingWay([theirs], 7)).toEqual([]);
  });
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

  it('rests where it lands (fGrenadeRestitution 0.01, fGrenadeFriction 5) and waits for its trigger', () => {
    const flight = launchFlight(rune, [0, 0, 100], [0, 1, -1]);
    expect(bounceLobber(flight, [0, 70, 0], [0, 0, 1])).toBe(true);
    expect(flight.resting).toBe(true);
    const step = stepFlight(flight, 30);
    expect(step.to).toEqual([0, 70, 0]);
    expect(flight.spent).toBe(false);
  });

  // DLC2ExpSpiderOilDecal: an alternative trigger without a proximity, no Lifetime: no mine.
  const oil: FlightData = { ...rune, flags: ProjectileFlag.altTrigger, proximity: 0 };

  it('lives its Lifetime, else fGrenadeAgeMax (90 s), a mine fMineAgeMax (0: no limit)', () => {
    // The runes: an alternative trigger with a proximity: mines.
    expect(lobberAgeMax(rune)).toBe(0);
    expect(lobberAgeMax(oil)).toBe(90);
    // One thrown without a trigger is no mine either, whatever its proximity says.
    expect(lobberAgeMax({ ...rune, flags: ProjectileFlag.explosion })).toBe(90);
    // Its own Lifetime comes first, a mine's too.
    expect(lobberAgeMax({ ...rune, lifetime: 12 })).toBe(12);
    expect(lobberAgeMax({ ...oil, lifetime: 12 })).toBe(12);
    // The settings.
    expect(lobberAgeMax(oil, { grenadeAgeMax: 30, mineAgeMax: 5 })).toBe(30);
    expect(lobberAgeMax(rune, { grenadeAgeMax: 30, mineAgeMax: 5 })).toBe(5);
    // Past it, not at it; never with no limit.
    expect(lobberOutlived(oil, 90)).toBe(false);
    expect(lobberOutlived(oil, 90.1)).toBe(true);
    expect(lobberOutlived(rune, 1e6)).toBe(false);
    expect(lobberOutlived(oil, 1e6, { grenadeAgeMax: 0, mineAgeMax: 0 })).toBe(false);
  });

  it('a rune at rest waits without end; a lobber that is no mine is taken away after 90 s, unburst', () => {
    const waiting = launchFlight(rune, [0, 0, 100], [0, 1, -1]);
    bounceLobber(waiting, [0, 70, 0], [0, 0, 1]);
    stepFlight(waiting, 3600);
    expect(waiting.expired).toBeUndefined();
    expect(waiting.spent).toBe(false);
    const pool = launchFlight(oil, [0, 0, 100], [0, 1, -1]);
    bounceLobber(pool, [0, 70, 0], [0, 0, 1]);
    stepFlight(pool, 90);
    expect(pool.expired).toBeUndefined();
    stepFlight(pool, 0.5);
    // Taken away, not spent: nothing bursts where it lay.
    expect(pool.expired).toBe(true);
    expect(pool.spent).toBe(false);
    // It ages no further.
    stepFlight(pool, 10);
    expect(pool.age).toBeCloseTo(90.5, 5);
  });

  it('goes by the settings it is given, in flight as at rest', () => {
    const slow: FlightData = { ...oil, speed: 1, range: 0 };
    const thrown = launchFlight(slow, [0, 0, 100], [0, 1, 0]);
    stepFlight(thrown, 31, { ...LOBBER_DEFAULTS, grenadeAgeMax: 30 });
    expect(thrown.expired).toBe(true);
    const kept = launchFlight(slow, [0, 0, 100], [0, 1, 0]);
    stepFlight(kept, 31);
    expect(kept.expired).toBeUndefined();
    // A mine with fMineAgeMax set.
    const mine = launchFlight(rune, [0, 0, 100], [0, 1, -1]);
    bounceLobber(mine, [0, 70, 0], [0, 0, 1]);
    stepFlight(mine, 6, { ...LOBBER_DEFAULTS, mineAgeMax: 5 });
    expect(mine.expired).toBe(true);
  });

  it('one with a Lifetime is taken away past it, not spent; its timer’s burst comes first', () => {
    const timed = launchFlight({ ...rune, lifetime: 12 }, [0, 0, 100], [0, 1, -1]);
    bounceLobber(timed, [0, 70, 0], [0, 0, 1]);
    stepFlight(timed, 13);
    expect(timed.expired).toBe(true);
    expect(timed.spent).toBe(false);
    const fused = launchFlight({ ...rune, lifetime: 5, timer: 5 }, [0, 0, 100], [0, 1, -1]);
    bounceLobber(fused, [0, 70, 0], [0, 0, 1]);
    stepFlight(fused, 6);
    expect(fused.spent).toBe(true);
    expect(fused.expired).toBeUndefined();
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
