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
  /** The camera: first or third person (the original's player camera keeps it in its saves). */
  readonly pov?: 'first' | 'third' | undefined;
  /** The world's and first person's fields of view (degrees). */
  readonly fov?: readonly [number, number] | undefined;
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

export interface WorldSave {
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

  constructor(save: WorldSave) {
    this.#playerGraphs = save.playerGraphs;
    this.#player = save.player;
    for (const actor of save.actors) this.#actors.set(actor.reference, actor);
    for (const [reference, graph] of save.graphs) this.#graphs.set(reference, graph);
    this.#projectiles = save.projectiles ?? [];
    this.#attachedArrows = save.attachedArrows ?? [];
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
