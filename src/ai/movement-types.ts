// Which movement types (MOVT) an actor moves by (docs/ai.md, "Movement"): the one its behavior
// graph tags while a tagged state is active (src/ai/locomotion.ts, taggedMovementType: a
// draugr blocking, a bow drawn, sneaking), else its race's for walking and running (RACE WKMV,
// RNMV, SPMV), else the Default Object Manager's (DOBJ DMWL, DMRN, DMSP: NPC_Default_MT and
// AIControlledNPC_Sprinting_MT in vanilla). A race's MTYP + SPED gives a movement type speeds
// of its own. Platform-independent.

import { parseRaceCombat, type RaceCombat } from './race-combat-records.ts';
import type { MovementTypes } from './locomotion.ts';
import { DefaultObjects } from '../world/default-objects.ts';
import { parseMovementType, type MovementType } from '../world/movement.ts';
import type { RecordDatabase } from '../world/record-db.ts';

/** Default object use codes of the default movement types. */
export const DefaultMovementUse = {
  walk: 'DMWL',
  run: 'DMRN',
  swim: 'DMSW',
  fly: 'DMFL',
  sneak: 'DMSN',
  sprint: 'DMSP',
} as const;

export type DefaultMovement = keyof typeof DefaultMovementUse;

/** fActorDefaultTurningSpeed (Skyrim.esm: a full turn a second; radians a second). */
export const ACTOR_DEFAULT_TURNING_SPEED = 2 * Math.PI;

/**
 * A movement type with fActorDefaultTurningSpeed for each turn rate it gives none (the cows'
 * swimming type turns while moving at 0, the dragons' perching type at 0 everywhere), as a
 * flier without a flying movement type turns at fFlyingActorDefaultTurningSpeed.
 * TODO(M13): the plain reading of the setting's name.
 */
export function withTurning(type: MovementType, defaultTurning: number): MovementType {
  const own = (rate: number): number => (rate > 0 ? rate : defaultTurning);
  const { walk, run } = type.rotateInPlace;
  if (walk > 0 && run > 0 && type.rotateWhileMoving > 0) return type;
  return {
    ...type,
    rotateInPlace: { walk: own(walk), run: own(run) },
    rotateWhileMoving: own(type.rotateWhileMoving),
  };
}

/** What a race says about how it moves (RACE, parseRaceCombat). */
export type RaceMovement = Pick<
  RaceCombat,
  | 'movementTypes'
  | 'movementOverrides'
  | 'accelerationRate'
  | 'decelerationRate'
  | 'angularAccelerationRate'
  | 'angularTolerance'
  | 'flags'
  | 'flags2'
  | 'aimAngleTolerance'
  | 'size'
>;

export class MovementCatalog {
  readonly #byId: ReadonlyMap<number, MovementType>;
  readonly #byName: ReadonlyMap<string, MovementType>;
  readonly #defaults: Readonly<Partial<Record<DefaultMovement, MovementType>>>;

  constructor(
    types: Iterable<MovementType>,
    defaults: Readonly<Partial<Record<DefaultMovement, number>>>,
  ) {
    const byId = new Map<number, MovementType>();
    const byName = new Map<string, MovementType>();
    for (const type of types) {
      byId.set(type.formId, type);
      // The first of a name is the graph's (names are unique in vanilla).
      const key = type.name.toLowerCase();
      if (!byName.has(key)) byName.set(key, type);
    }
    this.#byId = byId;
    this.#byName = byName;
    const resolved: Partial<Record<DefaultMovement, MovementType>> = {};
    for (const key of Object.keys(DefaultMovementUse) as DefaultMovement[]) {
      const id = defaults[key];
      const type = id === undefined ? undefined : byId.get(id);
      if (type) resolved[key] = type;
    }
    this.#defaults = resolved;
  }

  /** Every movement type of the load order and the default ones. */
  static async read(db: RecordDatabase): Promise<MovementCatalog> {
    const types: MovementType[] = [];
    for (const formId of db.formIdsOfType('MOVT')) {
      const record = await db.get(formId);
      if (record && !record.deleted) types.push(parseMovementType(record));
    }
    const objects = await DefaultObjects.read(db);
    const defaults: Partial<Record<DefaultMovement, number>> = {};
    for (const [key, use] of Object.entries(DefaultMovementUse) as [DefaultMovement, string][]) {
      const id = objects.get(use);
      if (id !== undefined) defaults[key] = id;
    }
    return new MovementCatalog(types, defaults);
  }

  /** A movement type by its name (MNAM: what the graphs tag), any case. */
  named(name: string): MovementType | undefined {
    return this.#byName.get(name.toLowerCase());
  }

  byId(formId: number): MovementType | undefined {
    return this.#byId.get(formId);
  }

  /** A default movement type (DOBJ). */
  default(use: DefaultMovement): MovementType | undefined {
    return this.#defaults[use];
  }

  /**
   * The movement types of an actor of `race` now: its graph's tagged one (by name) for every
   * gait, else its race's (else the defaults); with the race's own speeds for a type it
   * overrides. Undefined if the load order has no movement type at all.
   */
  /**
   * The movement type an actor swims by: its race's (RACE SWMV), else the default one (DOBJ
   * DMSW), else NPCSwimming; with its race's speeds for it (MTYP + SPED).
   */
  swimming(
    race: RaceMovement | undefined,
    defaultTurning = ACTOR_DEFAULT_TURNING_SPEED,
  ): MovementType | undefined {
    const id = race?.movementTypes.swim;
    const type =
      (id === undefined ? undefined : this.#byId.get(id)) ??
      this.#defaults.swim ??
      this.named('NPCSwimming');
    if (!type) return undefined;
    const override = race?.movementOverrides.find((entry) => entry.movementType === type.formId);
    return withTurning(override ? { ...type, ...override.speeds } : type, defaultTurning);
  }

  forActor(
    race: RaceMovement | undefined,
    tagged: string | undefined,
    defaultTurning = ACTOR_DEFAULT_TURNING_SPEED,
  ): MovementTypes | undefined {
    const own = (id: number | undefined): MovementType | undefined =>
      id === undefined ? undefined : this.#byId.get(id);
    const withOverride = (type: MovementType | undefined): MovementType | undefined => {
      if (!type) return undefined;
      const override = race?.movementOverrides.find((entry) => entry.movementType === type.formId);
      return withTurning(override ? { ...type, ...override.speeds } : type, defaultTurning);
    };
    const taggedType = tagged === undefined ? undefined : this.named(tagged);
    const walk = withOverride(
      taggedType ??
        own(race?.movementTypes.walk) ??
        this.#defaults.walk ??
        this.named('NPCDefault'),
    );
    const run = withOverride(
      taggedType ?? own(race?.movementTypes.run) ?? this.#defaults.run ?? walk,
    );
    const sprint = withOverride(
      taggedType ?? own(race?.movementTypes.sprint) ?? this.#defaults.sprint,
    );
    if (!walk || !run) return undefined;
    // Its turning: 1 / its race's angular acceleration rate (the engine's; 1 for none), its aim
    // and angular tolerances in radians; its race's acceleration and deceleration rates.
    const rate = race?.angularAccelerationRate ?? 0;
    return {
      walk,
      run,
      ...(sprint && { sprint }),
      angularAcceleration: Math.abs(rate) > 0.0001 ? 1 / rate : 1,
      aimTolerance: ((race?.aimAngleTolerance ?? 0) * Math.PI) / 180,
      angularTolerance: ((race?.angularTolerance ?? 0) * Math.PI) / 180,
      acceleration: race?.accelerationRate ?? 0,
      deceleration: race?.decelerationRate ?? 0,
    };
  }

  /** A race's movement data, read once per race. */
  readonly #races = new Map<number, Promise<RaceMovement | undefined>>();

  race(db: RecordDatabase, formId: number): Promise<RaceMovement | undefined> {
    let entry = this.#races.get(formId);
    if (!entry) {
      entry = db
        .get(formId)
        .then((record) => (record?.type === 'RACE' ? parseRaceCombat(record) : undefined))
        .catch(() => undefined);
      this.#races.set(formId, entry);
    }
    return entry;
  }
}
