import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { RaceFlag } from '../world/actor-records.ts';
import { parseCombatStyle, type CombatStyleFlight } from './combat-style-records.ts';
import {
  airborne,
  chooseFlightManeuver,
  diveBombPass,
  entryDirection,
  FLIGHT_DEFAULTS,
  fliesByRace,
  flyingAttack,
  FlyingState,
  flyingStateOf,
  headingRotation,
  hoverPoint,
  LANDING_APPROACH,
  landingApproach,
  maneuverSeconds,
  orbitPoint,
  readFlightSettings,
  steerFlight,
  takesOff,
  withinReach,
} from './flight.ts';

const f32s = (...values: number[]): Uint8Array => new Uint8Array(Float32Array.from(values).buffer);

/** A combat style's flight section (CSFL: hover, dive bomb, ground attack chances, ...). */
function flight(values: number[]): CombatStyleFlight {
  return parseCombatStyle({
    formId: 1,
    editorId: 'csTest',
    flags: 0,
    fields: new Fields([{ type: 'CSFL', data: f32s(...values) }]),
  }).flight;
}

/** csDragon's flight section (Skyrim.esm). */
const CS_DRAGON = flight([0.52, 0.36, 0.85, 0.42, 1, 0.5, 0.5, 0.75]);

/** A random source giving these values in turn. */
const sequence =
  (...values: number[]): (() => number) =>
  () =>
    values.shift() ?? 0.99;

const close = (a: readonly number[], b: readonly number[], digits = 3): void => {
  expect(a.length).toBe(b.length);
  a.forEach((value, i) => {
    expect(value).toBeCloseTo(b[i] ?? 0, digits);
  });
};

describe('who flies and the flying states', () => {
  it('flies by the race flag Flies (the dragons)', () => {
    expect(fliesByRace(RaceFlag.flies | RaceFlag.walks)).toBe(true);
    expect(fliesByRace(RaceFlag.walks | RaceFlag.swims)).toBe(false);
  });

  it('reads the dragon graph’s notify events as flying states', () => {
    expect(flyingStateOf('FlightTakeOff')).toBe(FlyingState.takeOff);
    expect(flyingStateOf('FlightCruising')).toBe(FlyingState.cruising);
    expect(flyingStateOf('FlightHovering')).toBe(FlyingState.hovering);
    expect(flyingStateOf('FlightLanding')).toBe(FlyingState.landing);
    expect(flyingStateOf('PerchLandEnd')).toBe(FlyingState.perching);
    expect(flyingStateOf('FlightAction')).toBe(FlyingState.action);
    expect(flyingStateOf('LandEnd')).toBe(FlyingState.none);
    expect(flyingStateOf('weaponSwing')).toBeUndefined();
  });

  it('counts the states in the air (IsFlying): not on the ground, not perched', () => {
    expect(airborne(FlyingState.none)).toBe(false);
    expect(airborne(FlyingState.perching)).toBe(false);
    expect(airborne(FlyingState.cruising)).toBe(true);
    expect(airborne(FlyingState.landing)).toBe(true);
  });
});

describe('the flight settings', () => {
  it('takes the load order’s values where it has them', () => {
    const settings = readFlightSettings((name) =>
      name === 'fCombatHoverTimeMin' ? 5.5 : name === 'fCombatOrbitDistance' ? 4000 : undefined,
    );
    expect(settings.hoverTimeMin).toBe(5.5);
    expect(settings.orbitDistance).toBe(4000);
    expect(settings.hoverTimeMax).toBe(FLIGHT_DEFAULTS.hoverTimeMax);
  });
});

describe('the flight maneuvers (CSTY CSFL)', () => {
  it('tries its style’s chances in turn: dive bomb, hover, perch, ground attack, else orbit', () => {
    const situation = { canLand: true, perch: true };
    expect(chooseFlightManeuver(CS_DRAGON, situation, sequence(0.3))).toBe('diveBomb');
    expect(chooseFlightManeuver(CS_DRAGON, situation, sequence(0.5, 0.4))).toBe('hover');
    expect(chooseFlightManeuver(CS_DRAGON, situation, sequence(0.5, 0.6, 0.4))).toBe('perch');
    expect(chooseFlightManeuver(CS_DRAGON, situation, sequence(0.5, 0.6, 0.6, 0.8))).toBe('land');
    expect(chooseFlightManeuver(CS_DRAGON, situation, sequence(0.5, 0.6, 0.6, 0.9))).toBe('orbit');
  });

  it('perches only with a perch near and lands only where it can', () => {
    const none = { canLand: false, perch: false };
    // The chances that would have it perch and land pass it by.
    expect(chooseFlightManeuver(CS_DRAGON, none, sequence(0.5, 0.6, 0.1, 0.1))).toBe('orbit');
  });

  it('never hovers or lands with a style that does not (csDragonNoLanding)', () => {
    const noLanding = flight([0.52, 0.73, 0, 0.42, 0, 0.5, 0.5, 0.75]);
    let random = 0;
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const maneuver = chooseFlightManeuver(noLanding, { canLand: true, perch: false }, () => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280;
      });
      counts.set(maneuver, (counts.get(maneuver) ?? 0) + 1);
    }
    expect(counts.get('land')).toBeUndefined();
    expect(counts.get('perch')).toBeUndefined();
    // About 73% dive bombs, 14% hovers (0.27 × 0.52), the rest orbits.
    expect(counts.get('diveBomb') ?? 0).toBeGreaterThan(650);
    expect(counts.get('hover') ?? 0).toBeGreaterThan(90);
  });

  it('breathes on a pass by its flying attack chance', () => {
    expect(flyingAttack(CS_DRAGON, () => 0.7)).toBe(true);
    expect(flyingAttack(CS_DRAGON, () => 0.8)).toBe(false);
  });

  it('times a hover, a perch attack and a ground fight between the settings by the style', () => {
    const settings = FLIGHT_DEFAULTS;
    const even = (): number => 0.5;
    // Hover time 0.42 of fCombatHoverTimeMin (5.5) .. max.
    expect(maneuverSeconds('hover', CS_DRAGON, settings, even)).toBeCloseTo(
      settings.hoverTimeMin + (settings.hoverTimeMax - settings.hoverTimeMin) * 0.42,
    );
    // Ground attack time 1: the longest.
    expect(maneuverSeconds('ground', CS_DRAGON, settings, even)).toBeCloseTo(
      settings.groundAttackTimeMax,
    );
    // A style time of 0: the least.
    const quick = flight([0.5, 0.5, 0.5, 0, 0, 0.5, 0, 0.75]);
    expect(maneuverSeconds('perch', quick, settings, even)).toBe(settings.perchAttackTimeMin);
  });

  it('takes off once its ground time is over or its target is beyond its orbit', () => {
    const base = { groundTime: 20, targetDistance: 500, orbitDistance: 4000 };
    expect(takesOff({ ...base, onGround: 5 })).toBe(false);
    expect(takesOff({ ...base, onGround: 21 })).toBe(true);
    expect(takesOff({ ...base, onGround: 5, targetDistance: 5000 })).toBe(true);
  });
});

describe('where a flier goes', () => {
  it('circles its centre at its radius and height, leading where it is', () => {
    const point = orbitPoint([0, 0, 100], 4000, 1500, [4000, 0, 1600], false, Math.PI / 2);
    close(point, [0, 4000, 1600]);
    const clockwise = orbitPoint([0, 0, 100], 4000, 1500, [4000, 0, 1600], true, Math.PI / 2);
    close(clockwise, [0, -4000, 1600]);
  });

  it('dives low over its target and climbs away beyond it', () => {
    const { over, past } = diveBombPass([0, -5000, 2000], [0, 0, 0], 384, 2000);
    close(over, [0, 0, 384]);
    close(past, [0, 2000, 1536]);
  });

  it('hovers before its target on its own side', () => {
    close(hoverPoint([0, -5000, 2000], [0, 0, 100], 1280, 768), [0, -1280, 868]);
  });

  it('begins a landing where the approach clip carries it to its spot', () => {
    const start = landingApproach([1000, 0, 50], [-9000, 0, 3000]);
    close(start, [1000 - LANDING_APPROACH.ahead, 0, 50 + LANDING_APPROACH.above]);
  });

  it('gives the tweener its entry direction (turns clockwise) and rotation (about z)', () => {
    expect(entryDirection(0, 0)).toBe(0);
    expect(entryDirection(0, Math.PI / 2)).toBeCloseTo(0.25);
    expect(entryDirection(0, -Math.PI / 2)).toBeCloseTo(0.75);
    expect(entryDirection(Math.PI, 0)).toBeCloseTo(0.5);
    // A quarter turn right (compass +90°) is a quarter turn clockwise: −90° about z.
    const [, , z, w] = headingRotation(Math.PI / 2);
    expect(2 * Math.atan2(z, w)).toBeCloseTo(-Math.PI / 2);
  });
});

describe('steering in flight', () => {
  it('turns at most its turn rate a second and tells the graph its turn (left positive)', () => {
    const step = steerFlight(
      { position: [0, 0, 0], heading: 0, pitch: 0 },
      [1000, 0, 0],
      100,
      Math.PI / 2,
      0.5,
    );
    // Half a second at 90° a second: 45° of the 90° to the right.
    expect(step.heading).toBeCloseTo(Math.PI / 4);
    expect(step.turnDelta).toBeCloseTo(-90);
    close(step.position, [Math.sin(Math.PI / 4) * 50, Math.cos(Math.PI / 4) * 50, 0]);
  });

  it('climbs towards its goal no steeper than its pitch limit', () => {
    const step = steerFlight(
      { position: [0, 0, 0], heading: 0, pitch: 0 },
      [0, 100, 5000],
      1000,
      10,
      0.1,
    );
    expect(step.pitch).toBeCloseTo(Math.PI / 4);
    expect(step.pitchDelta).toBeGreaterThan(0);
    expect(step.direction[2]).toBeCloseTo(Math.sin(Math.PI / 4));
  });

  it('does not fly past its goal in one step', () => {
    const step = steerFlight({ position: [0, 0, 0], heading: 0, pitch: 0 }, [0, 10, 0], 1000, 1, 1);
    close(step.position, [0, 10, 0]);
  });
});

describe('the reach of blows at fliers', () => {
  const fighter = { feet: [0, 0, 0] as const, height: 128, reach: 141 };
  it('reaches one on the ground and one hovering low', () => {
    expect(withinReach(fighter, { feet: [50, 0, 0], height: 128 })).toBe(true);
    expect(withinReach(fighter, { feet: [50, 0, 190], height: 400 })).toBe(true);
  });

  it('cannot reach a flier overhead', () => {
    expect(withinReach(fighter, { feet: [0, 0, 1500], height: 400 })).toBe(false);
  });
});
