import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { RaceFlag } from '../world/actor-records.ts';
import { parseCombatStyle, type CombatStyleFlight } from './combat-style-records.ts';
import {
  airborne,
  canFly,
  combatAreaRadius,
  diveBombGoal,
  entryDirection,
  FLIGHT_DEFAULTS,
  fliesByRace,
  FlyingState,
  flyingStateOf,
  flightRanges,
  headingRotation,
  hoverPoints,
  LANDING_APPROACH,
  landingApproach,
  maneuverSeconds,
  maneuverWeights,
  orbitClockwise,
  orbitPoint,
  orbitSeconds,
  perchFaces,
  pickManeuver,
  pointReached,
  readFlightSettings,
  steerFlight,
  shoutRanges,
  wantsTakeoff,
  withinReach,
  type FlightManeuver,
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
    expect(flyingStateOf('FlightLand')).toBe(FlyingState.none);
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

describe('who may fly (CanFly) and the combat tree’s Takeoff', () => {
  const able = { racesFly: true, injured: false, allowed: true, health: 100 };
  it('flies with its race, unhurt, allowed and alive', () => {
    expect(canFly(able)).toBe(true);
    expect(canFly({ ...able, injured: true })).toBe(false);
    expect(canFly({ ...able, allowed: false })).toBe(false);
    expect(canFly({ ...able, health: 0 })).toBe(false);
    expect(canFly({ ...able, racesFly: false })).toBe(false);
  });

  it('takes off from the ground or its perch, and out of a hover or a landing', () => {
    expect(wantsTakeoff(true, FlyingState.none)).toBe(true);
    expect(wantsTakeoff(true, FlyingState.perching)).toBe(true);
    expect(wantsTakeoff(false, FlyingState.none)).toBe(false);
    expect(wantsTakeoff(false, FlyingState.hovering)).toBe(true);
    expect(wantsTakeoff(true, FlyingState.cruising)).toBe(false);
  });
});

describe('the flight maneuvers (CSTY CSFL weighed)', () => {
  const settings = FLIGHT_DEFAULTS;

  it('weighs each maneuver by its style chance on its settings’ scale', () => {
    const weights = maneuverWeights(CS_DRAGON, settings);
    expect(weights.hover).toBeCloseTo(0.52);
    expect(weights.diveBomb).toBeCloseTo(0.36);
    expect(weights.groundAttack).toBeCloseTo(0.85);
    expect(weights.perchAttack).toBeCloseTo(0.5);
    expect(weights.flyingAttack).toBeCloseTo(0.75);
    const scaled = maneuverWeights(
      CS_DRAGON,
      readFlightSettings((name) => (name === 'fCombatDiveBombChanceMax' ? 0.5 : undefined)),
    );
    expect(scaled.diveBomb).toBeCloseTo(0.18);
  });

  it('draws one by weight among those not tried, none once all are', () => {
    const weights = maneuverWeights(CS_DRAGON, settings);
    // Order: ground attack 0.85, hover 0.52, dive bomb 0.36, perch 0.5, flying attack 0.75.
    const sum = 0.85 + 0.52 + 0.36 + 0.5 + 0.75;
    expect(pickManeuver(weights, new Set(), () => 0)).toBe('groundAttack');
    expect(pickManeuver(weights, new Set(), () => 0.9 / sum)).toBe('hover');
    expect(pickManeuver(weights, new Set(), () => 0.999)).toBe('flyingAttack');
    const tried = new Set<FlightManeuver>(['groundAttack']);
    expect(pickManeuver(weights, tried, () => 0)).toBe('hover');
    const all = new Set<FlightManeuver>([
      'groundAttack',
      'hover',
      'diveBomb',
      'perchAttack',
      'flyingAttack',
    ]);
    expect(pickManeuver(weights, all, () => 0)).toBeUndefined();
  });

  it('never draws a maneuver its style gives no weight (csDragonNoLanding)', () => {
    const noLanding = flight([0.52, 0.73, 0, 0.42, 0, 0, 0, 0.75]);
    const weights = maneuverWeights(noLanding, settings);
    let random = 0;
    const counts = new Map<string, number>();
    for (let i = 0; i < 1000; i++) {
      const maneuver = pickManeuver(weights, new Set(), () => {
        random = (random * 9301 + 49297) % 233280;
        return random / 233280;
      });
      counts.set(maneuver ?? '-', (counts.get(maneuver ?? '-') ?? 0) + 1);
    }
    expect(counts.get('groundAttack')).toBeUndefined();
    expect(counts.get('perchAttack')).toBeUndefined();
  });

  it('times a hover, a perch attack and a ground fight from the least up to the style’s time', () => {
    const longest = (): number => 1;
    // Hover time 0.42 on fCombatHoverTimeMin .. Max.
    const hover = settings.hoverTimeMin + (settings.hoverTimeMax - settings.hoverTimeMin) * 0.42;
    expect(maneuverSeconds('hover', CS_DRAGON, settings, longest)).toBeCloseTo(hover);
    expect(maneuverSeconds('hover', CS_DRAGON, settings, () => 0)).toBe(settings.hoverTimeMin);
    expect(maneuverSeconds('ground', CS_DRAGON, settings, longest)).toBeCloseTo(
      settings.groundAttackTimeMax,
    );
    const quick = flight([0.5, 0.5, 0.5, 0, 0, 0.5, 0, 0.75]);
    expect(maneuverSeconds('perch', quick, settings, longest)).toBe(settings.perchAttackTimeMin);
  });

  it('orbits shorter the more offensive it is (fCombatOrbitTimeMin .. Max)', () => {
    expect(orbitSeconds(0, settings, () => 1)).toBeCloseTo(12);
    expect(orbitSeconds(1, settings, () => 1)).toBeCloseTo(3);
    expect(orbitSeconds(0.5, settings, () => 1)).toBeCloseTo(7.5);
    expect(orbitSeconds(0.5, settings, () => 0)).toBeCloseTo(3);
  });
});

describe('the ranges and the combat area of a flier', () => {
  const settings = FLIGHT_DEFAULTS;

  it('gives a breath its ranges as the combat inventory does', () => {
    // Fire breath (2000): 256 .. 1800, optimal 1414.
    const fire = shoutRanges(2000, 0, settings);
    expect(fire.min).toBe(256);
    expect(fire.max).toBeCloseTo(1800);
    expect(fire.optimal).toBeCloseTo(1414);
    // A fireball (10000): its farthest capped at fCombatMaximumRange.
    expect(shoutRanges(10000, 0, settings).max).toBe(4096);
  });

  it('fights at its optimal range within its style’s, beyond both actors’ size', () => {
    const ranges = flightRanges({ extents: 300, optimal: 1414, max: 1800, styleOptimal: 1280 });
    expect(ranges.optimal).toBe(1580);
    expect(ranges.reach).toBe(2100);
  });

  it('keeps a combat area twice as wide in the air, wider after an attack', () => {
    expect(combatAreaRadius(undefined, false, settings)).toBe(4096);
    expect(combatAreaRadius(undefined, true, settings)).toBe(8192);
    expect(combatAreaRadius(10, true, settings)).toBe(16384);
    expect(combatAreaRadius(2000, false, settings)).toBe(4096);
  });
});

describe('where a flier goes', () => {
  const settings = FLIGHT_DEFAULTS;

  it('circles its centre at its radius and height, leading where it is', () => {
    const point = orbitPoint([0, 0, 100], 4000, 1500, [4000, 0, 1600], false, Math.PI / 2);
    close(point, [0, 4000, 1600]);
    const clockwise = orbitPoint([0, 0, 100], 4000, 1500, [4000, 0, 1600], true, Math.PI / 2);
    close(clockwise, [0, -4000, 1600]);
  });

  it('goes round the way it already turns', () => {
    // Facing north with the centre to its east (right): clockwise.
    expect(orbitClockwise([0, 0, 0], 0, [1000, 0, 0])).toBe(true);
    expect(orbitClockwise([0, 0, 0], 0, [-1000, 0, 0])).toBe(false);
  });

  it('hovers round its target at its range, its own side first, raised up to 20°', () => {
    const points = hoverPoints([0, 0, 0], [0, -5000, 2000], 1500, settings, () => 1);
    expect(points).toHaveLength(4);
    const first = points[0];
    close(first?.at ?? [], [0, -1500, Math.tan((20 * Math.PI) / 180) * 1500]);
    // It faces its target (north).
    expect(first?.heading).toBeCloseTo(0);
    close(points[2]?.at.slice(0, 2) ?? [], [0, 1500]);
  });

  it('dive bombs its target a little to one side, arriving within its range less that', () => {
    const { goal, arrive } = diveBombGoal([0, 0, 0], [0, -5000, 2000], 1500, settings, () => 1);
    // 10% of 1500 across the way in.
    close(goal, [150, 0, 0]);
    expect(arrive).toBe(1350);
  });

  it('perches where its perch faces its target (fCombatPerchMaxTargetAngle)', () => {
    const perch = { position: [0, 0, 0] as const, heading: 0 };
    expect(perchFaces(perch, [0, 1000, 0], settings)).toBe(true);
    expect(perchFaces(perch, [1000, 1000, 0], settings)).toBe(true);
    expect(perchFaces(perch, [1000, 0, 0], settings)).toBe(false);
  });

  it('reaches a point in the air within its radius and hysteresis, its height window', () => {
    expect(pointReached([2090, 0, 100], [0, 0, 0], 2048, settings)).toBe(true);
    expect(pointReached([2200, 0, 0], [0, 0, 0], 2048, settings)).toBe(false);
    expect(pointReached([0, 0, 300], [0, 0, 0], 2048, settings)).toBe(false);
  });

  it('begins a landing where the approach clip carries it to its spot, facing its heading', () => {
    const start = landingApproach([1000, 0, 50], Math.PI / 2);
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

  it('climbs towards its goal, its pitch turning at its turn rate', () => {
    const step = steerFlight(
      { position: [0, 0, 0], heading: 0, pitch: 0 },
      [0, 100, 5000],
      1000,
      10,
      0.1,
    );
    // A tenth of a second at 10 radians a second: one radian up.
    expect(step.pitch).toBeCloseTo(1);
    expect(step.pitchDelta).toBeGreaterThan(0);
    expect(step.direction[2]).toBeCloseTo(Math.sin(1));
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
