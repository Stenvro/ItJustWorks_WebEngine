// Ambient idles on the stage (src/ai/ambient-idles.ts; docs/animation.md, "Ambient idles"): an
// actor whose graph asked for a new idle (PickNewIdle) tries the idle tree's ActionIdle on its AI
// updates, with the furniture it is in as the action's target, until one plays.

import {
  AMBIENT_IDLE_DEFAULTS,
  ambientIdleAllowed,
  ambientIdleDistance,
  AmbientIdleFlags,
  readAmbientIdleSettings,
  type AmbientIdleActor,
  type AmbientIdleSettings,
} from '../ai/ambient-idles.ts';
import { parsePackage } from '../ai/package-records.ts';
import { parseRaceCombat, RaceSize } from '../ai/race-combat-records.ts';
import type { Vec3 } from '../render/math.ts';
import type { ActorInteraction } from '../scripting/runtime/runtime.ts';
import type { FurnitureUser } from './actor-furniture.ts';
import type { StagedActor } from './actor-stage.ts';
import type { GameSession } from './game-session.ts';

export interface ActorAmbientIdlesOptions {
  readonly session: GameSession;
  readonly actors: () => Iterable<StagedActor>;
  readonly userOf: (staged: StagedActor) => FurnitureUser;
  /** The furniture an actor uses or is on its way to (undefined: none). */
  readonly furnitureOf: (reference: number) => number | undefined;
  readonly interaction: (reference: number) => ActorInteraction | undefined;
  /** The package an actor runs (undefined: none). */
  readonly packageOf: (reference: number) => number | undefined;
  /** ActionIdle on an actor with a target: the event of the idle its graph took. */
  readonly playAction: (
    user: FurnitureUser,
    target: number | undefined,
    inFurniture: boolean,
  ) => Promise<string | undefined>;
}

/** An ambient idle played (kept for the checks: the last HISTORY). */
export interface AmbientIdlePlayed {
  readonly actor: number;
  readonly event: string;
  /** The furniture it was in (undefined: none). */
  readonly furniture: number | undefined;
}

const HISTORY = 256;
/** A furniture marker's animation type 2: a bed's (asleep in it). */
const SLEEP_ANIMATION = 2;
/** ActorInteraction state 3: in the furniture. */
const IN_FURNITURE = 3;

export class ActorAmbientIdles {
  readonly flags = new AmbientIdleFlags();
  /** The ambient idles played, oldest first. */
  readonly played: AmbientIdlePlayed[] = [];
  readonly #options: ActorAmbientIdlesOptions;
  #settings: AmbientIdleSettings = AMBIENT_IDLE_DEFAULTS;
  /** Actors whose try is under way (their conditions are valued asynchronously). */
  readonly #trying = new Set<number>();
  readonly #raceSizes = new Map<number, number>();
  /** Whether a package has idles of its own (PACK IDLA), by package, as read. */
  readonly #packageIdles = new Map<number, boolean>();

  constructor(options: ActorAmbientIdlesOptions) {
    this.#options = options;
    options.session.settings().then(
      (settings) => {
        this.#settings = readAmbientIdleSettings((name) => settings.number(name));
      },
      () => undefined,
    );
  }

  /** The engine's PickNewIdleHandler. */
  pickNewIdle(reference: number): void {
    this.flags.pickNewIdle(reference);
  }

  /** The actors' AI updates: those that want a new idle try ActionIdle. */
  frame(focus: Vec3 | undefined): void {
    if (!focus) return;
    for (const staged of this.#options.actors()) {
      const reference = staged.reference;
      if (staged.dead || !staged.placed.behavior) continue;
      if (!this.flags.wants(reference) || this.#trying.has(reference)) continue;
      const actor = this.#actor(staged, focus);
      if (!actor || !ambientIdleAllowed(actor)) continue;
      this.#trying.add(reference);
      const inFurniture = actor.furniture === 'in';
      const furniture = inFurniture ? this.#options.interaction(reference)?.furniture : undefined;
      void this.#options
        .playAction(this.#options.userOf(staged), furniture, inFurniture)
        .then(
          (event) => {
            this.flags.tried(reference, event !== undefined);
            if (event === undefined) return;
            this.played.push({ actor: reference, event, furniture });
            if (this.played.length > HISTORY) this.played.shift();
          },
          () => undefined,
        )
        .finally(() => {
          this.#trying.delete(reference);
        });
    }
  }

  remove(reference: number): void {
    this.flags.remove(reference);
  }

  /** What the gates see of an actor (undefined: its race's size is still being read). */
  #actor(staged: StagedActor, focus: Vec3): AmbientIdleActor | undefined {
    const size = this.#raceSize(staged.placed.look.race);
    if (size === undefined) return undefined;
    const [x, y, z] = staged.position;
    const distance = Math.hypot(x - focus[0], y - focus[1], z - focus[2]);
    return {
      distance,
      reach: ambientIdleDistance(boundRadius(staged), size, this.#settings),
      furniture: this.#furnitureState(staged.reference),
      packageIdles: this.#hasPackageIdles(this.#options.packageOf(staged.reference)),
      // TODO(M13): observed in the original, an actor at its meal (an Eat package at its
      // eating step) picks none; our Eat procedure's steps are not told apart here.
      eating: false,
    };
  }

  #furnitureState(reference: number): AmbientIdleActor['furniture'] {
    const using = this.#options.interaction(reference);
    if (!using) return this.#options.furnitureOf(reference) === undefined ? 'none' : 'heading';
    if (using.state !== IN_FURNITURE) return 'moving';
    return using.animationType === SLEEP_ANIMATION ? 'asleep' : 'in';
  }

  #hasPackageIdles(pack: number | undefined): boolean {
    if (pack === undefined) return false;
    const known = this.#packageIdles.get(pack);
    if (known !== undefined) return known;
    this.#packageIdles.set(pack, false);
    void this.#options.session.db
      .then((db) => db.get(pack))
      .then(
        (record) => {
          if (record?.type !== 'PACK') return;
          const idles = parsePackage(record).idles;
          this.#packageIdles.set(pack, idles !== undefined && idles.idles.length > 0);
        },
        () => undefined,
      );
    return false;
  }

  #raceSize(race: number): number | undefined {
    const known = this.#raceSizes.get(race);
    if (known !== undefined) return known;
    this.#raceSizes.set(race, RaceSize.medium);
    void this.#options.session.db
      .then((db) => db.get(race))
      .then(
        (record) => {
          if (record?.type === 'RACE') this.#raceSizes.set(race, parseRaceCombat(record).size);
        },
        () => undefined,
      );
    return undefined;
  }
}

/**
 * The radius of the sphere round an actor's skeleton as posed (the engine's 3D world bound, of
 * which its skinned shapes are the larger part: inferred from the nodes, which the skin
 * follows), times its scale.
 */
function boundRadius(staged: StagedActor): number {
  const worlds = staged.placed.pose.worlds;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let at = 0; at + 15 < worlds.length; at += 16) {
    const x = worlds[at + 12] ?? 0;
    const y = worlds[at + 13] ?? 0;
    const z = worlds[at + 14] ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  if (!Number.isFinite(minX)) return 64;
  const radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2;
  return radius * staged.placed.look.scale;
}
