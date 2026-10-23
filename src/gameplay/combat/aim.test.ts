import { describe, expect, it } from 'vitest';
import {
  AIM_DEFAULTS,
  aimAngles,
  aimOffset,
  anglesOf,
  assistAim,
  ballisticPitch,
  directionOf,
  leadPoint,
  npcSpread,
  readAimSettings,
} from './aim.ts';
import { fly, launch, WORLD_GRAVITY } from './projectile.ts';

const DEG = Math.PI / 180;

describe('aiming projectiles', () => {
  it('reads the settings, keeping the engine values the plugins lack', () => {
    const settings = readAimSettings((name) => (name === 'fAutoAimMaxDegrees' ? 3 : undefined));
    expect(settings.autoAimMaxDegrees).toBe(3);
    expect(settings.autoAimMaxDegrees3rdPerson).toBe(AIM_DEFAULTS.autoAimMaxDegrees3rdPerson);
  });

  it('turns angles into directions and back', () => {
    const angles = anglesOf(directionOf({ heading: 1, pitch: -0.3 }));
    expect(angles.heading).toBeCloseTo(1, 6);
    expect(angles.pitch).toBeCloseTo(-0.3, 6);
  });

  it('lifts a falling shot onto the arc that passes the point', () => {
    const speed = 3600;
    const gravity = 0.35 * WORLD_GRAVITY;
    const pitch = ballisticPitch(2000, 0, speed, gravity);
    expect(pitch).toBeGreaterThan(0);
    const flight = launch([0, 0, 0], directionOf({ heading: 0, pitch: pitch ?? 0 }), speed);
    while (flight.position[1] < 2000) fly(flight, 1 / 240, gravity);
    expect(Math.abs(flight.position[2])).toBeLessThan(5);
    // Out of reach: none.
    expect(ballisticPitch(1e7, 0, speed, gravity)).toBeUndefined();
    // Without gravity it is the straight line.
    expect(aimAngles([0, 0, 0], [0, 100, 100], speed, 0).pitch).toBeCloseTo(45 * DEG, 6);
  });

  it('turns the player shot toward its point by at most the assistance', () => {
    const reference = { heading: 0, pitch: 2 * DEG };
    // Within reach of the assistance: exactly onto it.
    const near = assistAim(reference, { heading: 0.5 * DEG, pitch: 1.5 * DEG }, 1.2, false);
    expect(near.heading).toBeCloseTo(0.5 * DEG, 9);
    expect(near.pitch).toBeCloseTo(1.5 * DEG, 9);
    // Farther off: at most 1.2 degrees each way.
    const far = assistAim(reference, { heading: -10 * DEG, pitch: 10 * DEG }, 1.2, false);
    expect(far.heading).toBeCloseTo(-1.2 * DEG, 9);
    expect(far.pitch).toBeCloseTo(3.2 * DEG, 9);
    // An arrow is never turned down.
    const arrow = assistAim(reference, { heading: 0, pitch: -5 * DEG }, 1.2, true);
    expect(arrow.pitch).toBeCloseTo(2 * DEG, 9);
    // Across north the heading turns the short way.
    const wrap = assistAim(
      { heading: Math.PI - 0.001, pitch: 0 },
      { heading: -Math.PI + 0.001, pitch: 0 },
      1.2,
      false,
    );
    expect(wrap.heading).toBeCloseTo(-Math.PI + 0.001, 6);
  });

  it('lets an NPC arrow stray by what its Archery lacks', () => {
    const aim = { heading: 0, pitch: 0 };
    const master = npcSpread(aim, 100, 5, 1, 0.25);
    expect(master.heading).toBe(0);
    expect(master.pitch).toBe(0);
    const novice = npcSpread(aim, 0, 5, 1, 0.25);
    expect(Math.hypot(novice.heading, novice.pitch)).toBeCloseTo(5 * DEG, 9);
    const half = npcSpread(aim, 50, 5, 1, 0);
    expect(half.pitch).toBeCloseTo(2.5 * DEG, 9);
  });

  it('leads a running target so the shot meets it', () => {
    const speed = 1500;
    const velocity: [number, number, number] = [300, 0, 0];
    const point = leadPoint([0, 0, 0], [0, 1500, 0], velocity, speed, 0, AIM_DEFAULTS);
    // The shot reaches the point when the target does.
    const time = Math.hypot(...point) / speed;
    expect(Math.abs(point[0] - velocity[0] * time)).toBeLessThan(
      velocity[0] * AIM_DEFAULTS.aimDeltaThreshold,
    );
    expect(point[0]).toBeGreaterThan(250);
    // A target standing still is aimed at where it stands.
    expect(leadPoint([0, 0, 0], [0, 1500, 50], [0, 0, 0], speed, 0, AIM_DEFAULTS)).toEqual([
      0, 1500, 50,
    ]);
    // A falling shot's point is raised onto its arc's launch.
    const lifted = leadPoint(
      [0, 0, 0],
      [0, 2000, 0],
      [0, 0, 0],
      3600,
      0.35 * WORLD_GRAVITY,
      AIM_DEFAULTS,
    );
    expect(lifted[2]).toBeGreaterThan(0);
  });

  it('puts an NPC aim point off by its variance', () => {
    expect(aimOffset([0, 0, 100], [0, 0, 60], 0, AIM_DEFAULTS, [1, 1, 1, 1])).toEqual([0, 0, 100]);
    const off = aimOffset([0, 0, 100], [0, 0, 60], 1, AIM_DEFAULTS, [1, 0, 0.5, 0.5]);
    expect(off[0]).toBeCloseTo(16, 9);
    expect(off[1]).toBeCloseTo(-16, 9);
    expect(off[2]).toBeCloseTo(80, 9);
  });
});
