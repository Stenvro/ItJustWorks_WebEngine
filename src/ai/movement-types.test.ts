import { describe, expect, it } from 'vitest';
import type { MovementType } from '../world/movement.ts';
import { MovementCatalog, type RaceMovement } from './movement-types.ts';

const type = (formId: number, name: string, forward: number): MovementType => ({
  formId,
  editorId: `${name}_MT`,
  name,
  walk: { left: forward, right: forward, forward, back: forward },
  run: { left: forward * 4, right: forward * 4, forward: forward * 4, back: forward * 2 },
  rotateInPlace: { walk: Math.PI, run: Math.PI },
  rotateWhileMoving: Math.PI,
});

const DEFAULT = type(1, 'NPCDefault', 80);
const SNEAK = type(2, 'NPCSneaking', 47);
const SPRINT = type(3, 'AIControlledNPCSprinting', 125);
const WOLF_WALK = type(4, 'WolfDefault', 75);
const WOLF_RUN = type(5, 'WolfRun', 139);

const catalog = new MovementCatalog([DEFAULT, SNEAK, SPRINT, WOLF_WALK, WOLF_RUN], {
  walk: 1,
  run: 1,
  sneak: 2,
  sprint: 3,
});

const race = (overrides: Partial<RaceMovement>): RaceMovement => ({
  movementTypes: {
    walk: undefined,
    run: undefined,
    swim: undefined,
    fly: undefined,
    sneak: undefined,
    sprint: undefined,
  },
  movementOverrides: [],
  accelerationRate: 0,
  decelerationRate: 0,
  angularAccelerationRate: 0,
  size: 1,
  ...overrides,
});

describe('MovementCatalog.forActor', () => {
  it('takes the defaults for a race without movement types', () => {
    const types = catalog.forActor(race({}), undefined);
    expect(types?.walk.name).toBe('NPCDefault');
    expect(types?.run.name).toBe('NPCDefault');
    expect(types?.sprint?.name).toBe('AIControlledNPCSprinting');
  });

  it("takes the race's own walk and run types", () => {
    const wolf = race({
      movementTypes: { ...race({}).movementTypes, walk: 4, run: 5 },
    });
    const types = catalog.forActor(wolf, undefined);
    expect(types?.walk.name).toBe('WolfDefault');
    expect(types?.run.name).toBe('WolfRun');
  });

  it('takes the tagged type for every gait', () => {
    const types = catalog.forActor(race({}), 'npcsneaking');
    expect(types?.walk.name).toBe('NPCSneaking');
    expect(types?.run.name).toBe('NPCSneaking');
    expect(types?.sprint?.name).toBe('NPCSneaking');
  });

  it("gives a type the race's own speeds", () => {
    const speeds = { ...DEFAULT, walk: { left: 1, right: 1, forward: 99, back: 1 } };
    const types = catalog.forActor(
      race({ movementOverrides: [{ movementType: 1, speeds }] }),
      undefined,
    );
    expect(types?.walk.walk.forward).toBe(99);
    expect(types?.walk.name).toBe('NPCDefault');
  });
});
