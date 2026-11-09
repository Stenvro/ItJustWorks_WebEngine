// Ambient idles on the stage (src/ai/ambient-idles.ts; docs/animation.md, "Ambient idles"): an
// actor whose graph asked for a new idle (PickNewIdle) tries the idle tree's ActionIdle on its AI
// updates, with the furniture it is in as the action's target, until one plays; the player too,
// in the camera states that allow it. The tries of a frame share its budget, in turns.

import {
  AMBIENT_IDLE_DEFAULTS,
  ambientIdleDistance,
  AmbientIdleFlags,
  AmbientIdleLife,
  AmbientIdleTurns,
  ambientIdleUpdate,
  ambientIdleWait,
  COMPLEX_SCENE_ACTORS,
  isComplexScene,
  playerAmbientIdleView,
  readAmbientIdleSettings,
  type AmbientIdleActor,
  type AmbientIdleSettings,
} from '../ai/ambient-idles.ts';
import { parsePackage } from '../ai/package-records.ts';
import { parseRaceCombat, RaceSize } from '../ai/race-combat-records.ts';
import type { Vec3 } from '../render/math.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
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
  /** An actor's life state (ACTOR_LIFE_STATE; undefined: alive). */
  readonly lifeOf?: (reference: number) => number | undefined;
  /** Whether an actor is in the high process (undefined: taken as yes). */
  readonly highProcess?: (reference: number) => boolean;
  /** The player as the idles see it (undefined: no player body on the stage). */
  readonly player?: () => AmbientIdlePlayer | undefined;
  /** The clock the frame's budget is measured with (ms; default performance.now). */
  readonly clock?: () => number;
  /** Whether an actor moves off now (its package walks it, it paths; undefined: never). */
  readonly moving?: (reference: number) => boolean;
}

/** The player as its idle update sees it. */
export interface AmbientIdlePlayer {
  /** The player's third person body as a user of furniture. */
  readonly user: FurnitureUser;
  /** The camera's state (src/shell/camera-states.ts). */
  readonly camera: number;
  /** First or third person (src/shell/player.ts). */
  readonly pov: 'first' | 'third';
  /** The player's keys move them now. */
  readonly moving?: boolean;
  /** Its life state (undefined: alive). */
  readonly life?: number;
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

  /** Seconds of frames seen (the idle wait timers' clock). */
  #clock = 0;
  readonly #turns = new AmbientIdleTurns();
  /** iAINumberActorsComplexScene. */
  #complexSceneActors = COMPLEX_SCENE_ACTORS;
  /** The frame's budget for the tries (ms): [Animation] fSpecialIdlePickTime, microseconds. */
  readonly #budget: number;

  constructor(options: ActorAmbientIdlesOptions) {
    this.#options = options;
    this.#budget = options.session.ini.number('Animation', 'fSpecialIdlePickTime') / 1000;
    options.session.settings().then(
      (settings) => {
        this.#settings = readAmbientIdleSettings((name) => settings.number(name));
        this.#complexSceneActors =
          settings.number('iAINumberActorsComplexScene') ?? COMPLEX_SCENE_ACTORS;
      },
      () => undefined,
    );
  }

  /** The engine's PickNewIdleHandler. */
  pickNewIdle(reference: number): void {
    this.flags.pickNewIdle(reference);
  }

  /**
   * A specific idle was sent to an actor's graph (a package's, a script's PlayIdle, a line's):
   * over an idle that plays, the PickNewIdle the stopped one raises is no request.
   */
  specificIdle(reference: number): void {
    this.flags.specificIdle(reference);
  }

  /**
   * The actors' AI updates (`seconds` since the last frame): those that want a new idle try
   * ActionIdle, in turns within the frame's budget; the player too, in the camera states that
   * allow it.
   */
  frame(focus: Vec3 | undefined, seconds = 0): void {
    this.#clock += seconds;
    const now = this.#clock;
    const staged = new Map<number, StagedActor>();
    let high = 0;
    for (const actor of this.#options.actors()) {
      staged.set(actor.reference, actor);
      if (!actor.dead && this.#options.highProcess?.(actor.reference) !== false) high++;
      // Moving off cuts the idle that played (no PickNewIdle of its end comes).
      if (this.flags.playing(actor.reference) && this.#options.moving?.(actor.reference) === true) {
        this.flags.moved(actor.reference);
      }
    }
    const player = this.#options.player?.();
    if (player?.moving === true) this.flags.moved(PLAYER_REF);
    if (!focus) return;
    const complex = isComplexScene(high, this.#complexSceneActors);
    const order = [...staged.keys()];
    if (player) order.push(PLAYER_REF);
    const clock = this.#options.clock ?? (() => performance.now());
    this.#turns.run(order, this.#budget, clock, (reference) => {
      if (!this.flags.ready(reference, now) || this.#trying.has(reference)) return false;
      const one = staged.get(reference);
      if (one) return this.#tryActor(one, focus, now, complex);
      return player !== undefined && this.#tryPlayer(player, now, complex);
    });
  }

  /** One actor's idle update (with its flag set): whether it tried ActionIdle. */
  #tryActor(staged: StagedActor, focus: Vec3, now: number, complex: boolean): boolean {
    const reference = staged.reference;
    if (!staged.placed.behavior) return false;
    if (staged.dead) {
      this.flags.drop(reference);
      return false;
    }
    const actor = this.#actor(staged, focus);
    if (!actor) return false;
    const update = ambientIdleUpdate(actor);
    if (update === 'drop') this.flags.drop(reference);
    if (update !== 'try') return false;
    this.#try(this.#options.userOf(staged), actor.furniture === 'in', now, complex);
    return true;
  }

  /** The player's idle update (with its flag set): whether it tried ActionIdle. */
  #tryPlayer(player: AmbientIdlePlayer, now: number, complex: boolean): boolean {
    if (!playerAmbientIdleView(player.camera, player.pov)) return false;
    const update = ambientIdleUpdate({
      distance: 0,
      reach: Infinity,
      furniture: this.#furnitureState(PLAYER_REF),
      packageIdles: false,
      eating: false,
      ...(player.life !== undefined && { life: player.life }),
    });
    if (update === 'drop') this.flags.drop(PLAYER_REF);
    if (update !== 'try') return false;
    this.#try(player.user, this.#furnitureState(PLAYER_REF) === 'in', now, complex);
    return true;
  }

  /** Tries ActionIdle on one (its conditions valued asynchronously). */
  #try(user: FurnitureUser, inFurniture: boolean, now: number, complex: boolean): void {
    const reference = user.reference;
    this.#trying.add(reference);
    const furniture = inFurniture ? this.#options.interaction(reference)?.furniture : undefined;
    void this.#options
      .playAction(user, furniture, inFurniture)
      .then(
        (event) => {
          if (event === undefined) {
            this.flags.tried(reference, false);
            return;
          }
          this.flags.played(reference, now, ambientIdleWait(this.#settings, complex), complex);
          this.played.push({ actor: reference, event, furniture });
          if (this.played.length > HISTORY) this.played.shift();
        },
        () => undefined,
      )
      .finally(() => {
        this.#trying.delete(reference);
      });
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
      life: this.#options.lifeOf?.(staged.reference) ?? AmbientIdleLife.alive,
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
