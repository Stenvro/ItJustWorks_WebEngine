// What a save keeps of the loaded world beside the scripts' side (docs/formats/save.md): where
// the actors of the loaded area stand, the furniture they use, the package each runs and how
// far it got, who each fights; the graphs of the objects that scripts or the player moved
// (levers pulled, gates raised). Only the minimal state from which each system rebuilds itself
// as the world loads again, the way the original's change forms do; nothing of the rendering.
// Platform-independent.

import type { SavedPackage } from '../ai/package-runtime.ts';
import type { ActorGraphState, BehaviorGraphState } from '../animation/behavior-runtime.ts';
import type { VehicleOffset, VehiclePose } from '../ai/vehicles.ts';
import type { SavedGraph } from '../animation/script-graphs.ts';
import type { CastVia } from '../scripting/runtime/casting-engine.ts';
import type { DetectionSave } from '../ai/detection-states.ts';
import type { SavedGroupTarget } from '../ai/combat-groups.ts';
import type { SavedCombatSearch } from '../ai/combat-search.ts';

/** A worldspace or an interior (as src/ai/package-start.ts Space; this file stays portable). */
export type SavedSpace =
  | { readonly kind: 'world'; readonly world: number }
  | { readonly kind: 'interior'; readonly cell: number };

/** An actor of the loaded area as the save found it. */
export interface SavedActor {
  readonly reference: number;
  /**
   * The loaded cell it stands in, as the view keys its cells (an interior's form id, an
   * exterior's grid cell): it is placed again as that cell loads.
   */
  readonly cell: string;
  /** Its feet, and the way it faces (yaw). */
  readonly position: readonly [number, number, number];
  readonly heading: number;
  /** The furniture it sits, sleeps or leans in (not one it walks to). */
  readonly furniture?: number | undefined;
  /** Its package and how far it got. */
  readonly package?: SavedPackage | undefined;
  /** Whom it fights (its combat target). */
  readonly combatTarget?: number | undefined;
  /** The confidence modifier its fight drew (fCombatConfidenceModifier*), kept for the fight. */
  readonly confidenceModifier?: number | undefined;
  /** What its group knew of its target, and its search for it under way. */
  readonly fight?: SavedFight | undefined;
  /** A script set it sneaking (StartSneaking) in the package it runs. */
  readonly sneaking?: boolean | undefined;
  /** Its weapon drawn (or being drawn): drawn outside a fight too (DrawWeapon). */
  readonly weaponDrawn?: boolean | undefined;
  /** A flier in the air: it is not set on the ground as it loads, and flies on from there. */
  readonly flying?: boolean | undefined;
  /**
   * Its graph (the original keeps every actor's): it goes on from there as it loads, mid-idle,
   * seated, sneaking, its weapon out. Saves made before kept riders' alone, in the older form.
   */
  readonly graph?: SavedActorGraph | undefined;
  /** A rider getting out (its exit idle began): where its vehicle was then, how far it came. */
  readonly vehicleExit?: VehicleExit | undefined;
  /** The horse it rides: it sits on it again as both are placed (none in older saves). */
  readonly riding?: number | undefined;
  /** Bleeding out, or in a paired animation (a killmove): it goes on in it. */
  readonly down?: SavedDown | undefined;
  /**
   * It had left the stage as the game was saved (OffStageActors): its cell is one of `space`,
   * not of the loaded area. The low process may take it over as it chooses another package.
   */
  readonly offStage?: boolean | undefined;
  /** The worldspace or interior of its cell (an exterior's key names only the grid cell). */
  readonly space?: SavedSpace | undefined;
}

/**
 * An actor on its way between load doors (src/shell/actors-away.ts) as a save keeps it: where
 * it is along its way, where it is going, for which package; its road is planned again from
 * there. The game state has it only where it last came through a door.
 */
export interface SavedTrip {
  readonly actor: number;
  readonly space: SavedSpace;
  readonly position: readonly [number, number, number];
  readonly destination: {
    readonly space: SavedSpace;
    readonly position: readonly [number, number, number];
    readonly heading?: number | undefined;
  };
  readonly package?: { readonly id: number; readonly procedure: string } | undefined;
  readonly speed: number;
  /** A flier's way: straight through the air, no road under it. */
  readonly flies?: boolean | undefined;
}

/**
 * An actor's bleedout and paired animation as a save keeps them (ActorCombat.saveDown): the
 * seconds it has been bleeding out; its side of a pair, whether it is a killmove, the seconds
 * in it and a victim's killer.
 */
export interface SavedDown {
  readonly bleedout?: number | undefined;
  readonly paired?:
    | {
        readonly side: 'lead' | 'support' | undefined;
        readonly killMove: boolean;
        readonly seconds: number;
        readonly killer?: number | undefined;
      }
    | undefined;
}

/**
 * An actor's fight beside its target (the original keeps its combat group's targets and its
 * search with the group): what its group knew of the target (stealth points, lost or known,
 * where last known, as seconds before the save) and the search it made for it (its place, its
 * step and how far into it). A loaded actor searching goes on with its search, its group
 * searching, instead of losing its target again and searching anew from detection.
 */
export interface SavedFight {
  readonly known?: SavedGroupTarget | undefined;
  readonly search?: SavedCombatSearch | undefined;
  /** A script's target it keeps (StartCombat: its Fixed target selector), if one. */
  readonly fixed?: number | undefined;
}

/** An actor's graph as a save keeps it (older saves: the placed objects' form). */
export type SavedActorGraph = ActorGraphState | BehaviorGraphState;

/** A rider part-way out of its vehicle: the vehicle's pose as it let go, its exit's offset. */
export interface VehicleExit {
  readonly pose: VehiclePose;
  readonly offset: VehicleOffset;
}

/** What the player's actor state keeps beside their graphs (as the NPCs' SavedActor). */
export interface SavedPlayer {
  readonly sneaking?: boolean | undefined;
  /** Their weapon out (or being drawn). */
  readonly weaponDrawn?: boolean | undefined;
  /** Getting out of their vehicle. */
  readonly vehicleExit?: VehicleExit | undefined;
  /** The furniture they sit, sleep or lean in (none in older saves). */
  readonly furniture?: number | undefined;
  /** The camera: first or third person (the original's player camera keeps it in its saves). */
  readonly pov?: 'first' | 'third' | undefined;
  /** The world's and first person's fields of view (degrees). */
  readonly fov?: readonly [number, number] | undefined;
  /** Bleeding out, or in a paired animation (a killmove). */
  readonly down?: SavedDown | undefined;
}

/** The player's graphs as a save keeps them: the body's and the first-person one. */
export interface SavedGraphs {
  readonly body?: SavedActorGraph | undefined;
  readonly firstPerson?: SavedActorGraph | undefined;
}

/**
 * A projectile in flight (or a rune at rest) as the save found it: what flies, the cast it
 * carries, where it is and how it moves. It flies on as the world loads again.
 */
export interface SavedProjectile {
  /** Its PROJ. */
  readonly projectile: number;
  /** The magic item it carries, how it was cast (CastVia), by whom, dual cast. */
  readonly item: number;
  readonly via: CastVia;
  readonly caster: number;
  readonly dual: boolean;
  /** The staff, scroll or shout it came by. */
  readonly object?: number | undefined;
  readonly position: readonly [number, number, number];
  readonly velocity: readonly [number, number, number];
  /** Units flown and seconds since it left; at rest (a lobber waiting for its trigger). */
  readonly traveled: number;
  readonly age: number;
  readonly resting?: boolean | undefined;
  /**
   * What it is beside a missile, lobber or bolt (undefined): a flame's spray (its stream shows
   * it again where it left), a cone's wave sweeping out (`position` its apex, `velocity` its
   * direction, `traveled` how far its front has come), a Magelight stuck where it struck.
   */
  readonly kind?: 'spray' | 'cone' | 'stuck' | undefined;
  /** A concentration spell's seconds a spray or a wave carries. */
  readonly seconds?: number | undefined;
  /** Where a spray left the hand or mouth. */
  readonly origin?: readonly [number, number, number] | undefined;
  /** The actors and objects a cone's wave has reached (each is reached once). */
  readonly reached?: readonly number[] | undefined;
  /** A stuck Magelight's seconds left. */
  readonly left?: number | undefined;
  /**
   * Its model's behavior graph (most projectiles' models have one: tools/projectile-graphs.ts):
   * ours by its states (`sequences`), an imported .ess's by names (`named`).
   */
  readonly graph?: SavedGraph | undefined;
}

/**
 * An arrow stuck in an actor's body (the original's ExtraAttachedArrows3D): drawn on the
 * actor's bone it struck, for what is left of its fAttachedArrowAgeMax.
 */
export interface SavedAttachedArrow {
  /** The actor it is stuck in. */
  readonly target: number;
  /** Its PROJ (its model is the projectile's). */
  readonly projectile: number;
  /** The bone, by its index in the actor's skeleton. */
  readonly node: number;
  /** Its place in the bone's space: a 4x4 matrix, column-major. */
  readonly local: readonly number[];
  /** Seconds it has been stuck. */
  readonly age: number;
}

/**
 * A decal on the world (a hit's blood, a spell's scorch: the original's temp effects): what it
 * shows, the box it is clipped to in the space of what it lies on, and how long it has left.
 * It is built again on the shapes in its box as what it lies on is drawn.
 */
export interface SavedDecal {
  /** Its texture set (TXST). */
  readonly textureSet: number;
  /** The impact (IPCT) it was made with, whose own decal data wins over the set's. */
  readonly impact?: number | undefined;
  /**
   * What it lies on, the space of its box: a reference (only its shapes under `node`, when
   * given), the land (world space), the land of a cell (an imported save's: the cell land's
   * space, src/world/decal.ts landSpaceOrigin), or nothing known (world space, projected).
   */
  readonly on:
    | { readonly reference: number; readonly node?: string | undefined }
    | { readonly land: true }
    | { readonly cell: number }
    | { readonly world: true };
  /** Its clipping box (worldDecalBox's), a 4x4 matrix, column-major. */
  readonly box: readonly number[];
  /** The atlas quarter it shows (u, v, width, height). */
  readonly rect: readonly [number, number, number, number];
  /** The cosine a face's turn from the decal must stay above (worldDecalFaceLimit). */
  readonly faceLimit: number;
  /** Seconds it has left, its fade included (undefined: a whole lifetime, as made now). */
  readonly left?: number | undefined;
}

/** An animation object an actor holds (the original's anim objects, global data 1002). */
export interface SavedAnimObject {
  readonly actor: number;
  /** Its ANIO. */
  readonly animObject: number;
  /** Shown (drawn) on the actor, not only loaded. */
  readonly shown: boolean;
}

/** A loose object in motion as the game was saved (game units and radians a second). */
export interface SavedMotion {
  readonly reference: number;
  readonly linear: readonly [number, number, number];
  readonly angular: readonly [number, number, number];
}

/** The parts of the world a view keeps beside its actors and graphs (merged by the world). */
export interface WorldSaveParts {
  readonly decals?: readonly SavedDecal[];
  readonly animObjects?: readonly SavedAnimObject[];
  readonly motions?: readonly SavedMotion[];
  readonly detection?: DetectionSave;
  /** The actors on their way between load doors. */
  readonly trips?: readonly SavedTrip[];
}

export interface WorldSave extends WorldSaveParts {
  readonly actors: readonly SavedActor[];
  /** The graphs of loaded objects moved from where they start, by reference. */
  readonly graphs: readonly (readonly [number, SavedGraph])[];
  /** What flies (none in saves made before they were kept). */
  readonly projectiles?: readonly SavedProjectile[];
  /** The arrows stuck in actors, oldest first (none in saves made before they were kept). */
  readonly attachedArrows?: readonly SavedAttachedArrow[];
  /** The player's graphs (saves made before kept them only while the player rode a vehicle). */
  readonly playerGraphs?: SavedGraphs;
  /** The player's sneaking, drawn weapon and vehicle exit. */
  readonly player?: SavedPlayer;
}

/**
 * How many actors that left the stage are kept for a save: those that left last. What each
 * holds is small (no graph, no fight), and an actor's cell the player has not come back to in
 * this many actors' time gets what the game state has for it, as before.
 */
export const OFF_STAGE_KEPT = 512;

/** An actor's place in the game state as it left the stage (undefined: it has none). */
type StatePlace = readonly [number, number, number] | undefined;

/**
 * What a save keeps of the actors that left the stage during play, as the original keeps the
 * process of an actor that is not loaded: place, package and its progress (OFF_STAGE_KEPT
 * says how many). Only a save reads them: an actor that comes back during play is placed by its
 * package and the game state as before, and its record goes.
 */
export class OffStageActors {
  readonly #kept = new Map<number, { record: SavedActor; statePlace: StatePlace }>();
  /**
   * The fliers in the air off the stage, each with the game state's place it had as it left the
   * stage in flight (or as the low process flew it into the loaded area): a move elsewhere since
   * (a script's MoveTo or SetPosition, the end of a trip of the low process) leaves it on the
   * ground there. Kept for the session, not by one stage (a viewer's low process moves those
   * another viewer's cells let go); a game loaded or started anew clears them.
   */
  readonly #aloft = new Map<number, StatePlace>();

  keep(record: SavedActor, statePlace: StatePlace): void {
    this.#kept.delete(record.reference);
    this.#kept.set(record.reference, { record, statePlace });
    for (const oldest of this.#kept.keys()) {
      if (this.#kept.size <= OFF_STAGE_KEPT) break;
      this.#kept.delete(oldest);
    }
  }

  /** It is on the stage again (or no longer as it left): its record is gone. */
  drop(reference: number): void {
    this.#kept.delete(reference);
  }

  clear(): void {
    this.#kept.clear();
    this.#aloft.clear();
  }

  /** A flier is in the air off the stage while the game state has it at `statePlace`. */
  keepAloft(reference: number, statePlace: readonly [number, number, number]): void {
    this.#aloft.set(reference, [statePlace[0], statePlace[1], statePlace[2]]);
  }

  /**
   * Whether a flier is in the air off the stage: kept so (keepAloft), the game state's place for
   * it (`statePlace`, the game state's now) still the one it was kept at. One moved elsewhere
   * since is on the ground, and is forgotten.
   */
  aloft(reference: number, statePlace: StatePlace): boolean {
    if (!this.#aloft.has(reference)) return false;
    if (samePlace(this.#aloft.get(reference), statePlace)) return true;
    this.#aloft.delete(reference);
    return false;
  }

  /** It is on the ground off the stage, or on the stage again: no longer kept in the air. */
  landed(reference: number): void {
    this.#aloft.delete(reference);
  }

  /**
   * The records still true: one whose place in the game state changed since it left (a script
   * moved it, the low process took it through a door) has its place there, and is gone.
   */
  current(statePlaceOf: (reference: number) => StatePlace): SavedActor[] {
    const records: SavedActor[] = [];
    for (const [reference, { record, statePlace }] of this.#kept) {
      if (samePlace(statePlaceOf(reference), statePlace)) records.push(record);
      else this.#kept.delete(reference);
    }
    return records;
  }
}

const samePlace = (a: StatePlace, b: StatePlace): boolean =>
  a === b || (a !== undefined && b !== undefined && a.every((value, axis) => value === b[axis]));

/**
 * A loaded save's world, handed out as the world loads again: each actor's and graph's saved
 * state is taken once, as its reference is placed. Actors whose cell goes before they were
 * placed are dropped with it (they come back where their packages have them, as before).
 */
export class WorldRestore {
  readonly #actors = new Map<number, SavedActor>();
  readonly #graphs = new Map<number, SavedGraph>();
  #projectiles: readonly SavedProjectile[];
  #attachedArrows: readonly SavedAttachedArrow[];
  #playerGraphs: SavedGraphs | undefined;
  #player: SavedPlayer | undefined;
  #decals: readonly SavedDecal[];
  #animObjects: readonly SavedAnimObject[];
  readonly #motions = new Map<number, SavedMotion>();
  #detection: DetectionSave | undefined;
  #trips: readonly SavedTrip[];

  constructor(save: WorldSave) {
    this.#playerGraphs = save.playerGraphs;
    this.#player = save.player;
    for (const actor of save.actors) this.#actors.set(actor.reference, actor);
    for (const [reference, graph] of save.graphs) this.#graphs.set(reference, graph);
    this.#projectiles = save.projectiles ?? [];
    this.#attachedArrows = save.attachedArrows ?? [];
    this.#decals = save.decals ?? [];
    this.#animObjects = save.animObjects ?? [];
    for (const motion of save.motions ?? []) this.#motions.set(motion.reference, motion);
    this.#detection = save.detection;
    this.#trips = save.trips ?? [];
  }

  /** The actors on their way between load doors, once (they go on from where they were). */
  takeTrips(): readonly SavedTrip[] {
    const trips = this.#trips;
    this.#trips = [];
    return trips;
  }

  /** The world's decals as the game was saved, once (built again as what they lie on loads). */
  takeDecals(): readonly SavedDecal[] {
    const decals = this.#decals;
    this.#decals = [];
    return decals;
  }

  /** The animation objects an actor held, once (put on again as it is placed). */
  takeAnimObjects(actor: number): readonly SavedAnimObject[] {
    const objects = this.#animObjects.filter((held) => held.actor === actor);
    if (objects.length > 0)
      this.#animObjects = this.#animObjects.filter((held) => held.actor !== actor);
    return objects;
  }

  /** The animation objects of actors not yet placed. */
  pendingAnimObjects(): readonly SavedAnimObject[] {
    return this.#animObjects;
  }

  /** A loose object's motion as the game was saved, once (given back as its body settles). */
  takeMotion(reference: number): SavedMotion | undefined {
    const motion = this.#motions.get(reference);
    this.#motions.delete(reference);
    return motion;
  }

  /** What actors knew of each other (detection), once. */
  takeDetection(): DetectionSave | undefined {
    const detection = this.#detection;
    this.#detection = undefined;
    return detection;
  }

  /** The arrows stuck in actors as the game was saved, once (drawn again as each is placed). */
  takeAttachedArrows(): readonly SavedAttachedArrow[] {
    const arrows = this.#attachedArrows;
    this.#attachedArrows = [];
    return arrows;
  }

  /** What flew as the game was saved, once (the projectiles fly it on as the world loads). */
  takeProjectiles(): readonly SavedProjectile[] {
    const projectiles = this.#projectiles;
    this.#projectiles = [];
    return projectiles;
  }

  /** The player's saved graphs, once (put back as their body rides again). */
  takePlayerGraphs(): SavedGraphs | undefined {
    const graphs = this.#playerGraphs;
    this.#playerGraphs = undefined;
    return graphs;
  }

  /** The player's actor state beside their graphs, once (put back with them). */
  takePlayer(): SavedPlayer | undefined {
    const player = this.#player;
    this.#player = undefined;
    return player;
  }

  /** The saved actors not yet placed. */
  actors(): IterableIterator<SavedActor> {
    return this.#actors.values();
  }

  /**
   * The saved actors not yet placed, for a save made now: an actor whose cell has not loaded
   * since keeps its saved state (its place, its package's progress, its graph) into the next
   * save, as the original keeps the process of an actor that is not loaded.
   */
  carried(): SavedActor[] {
    return [...this.#actors.values()];
  }

  actor(reference: number): SavedActor | undefined {
    return this.#actors.get(reference);
  }

  /** An actor placed (or one that will not be): its saved state is used up. */
  drop(reference: number): void {
    this.#actors.delete(reference);
  }

  /** A placed object's saved graph, once. */
  takeGraph(reference: number): SavedGraph | undefined {
    const graph = this.#graphs.get(reference);
    this.#graphs.delete(reference);
    return graph;
  }
}
