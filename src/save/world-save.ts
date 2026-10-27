// What a save keeps of the loaded world beside the scripts' side (docs/formats/save.md): where
// the actors of the loaded area stand, the furniture they use, the package each runs and how
// far it got, who each fights; the graphs of the objects that scripts or the player moved
// (levers pulled, gates raised). Only the minimal state from which each system rebuilds itself
// as the world loads again, the way the original's change forms do; nothing of the rendering.
// Platform-independent.

import type { SavedPackage } from '../ai/package-runtime.ts';
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

export interface WorldSave {
  readonly actors: readonly SavedActor[];
  /** The graphs of loaded objects moved from where they start, by reference. */
  readonly graphs: readonly (readonly [number, SavedGraph])[];
  /** What flies (none in saves made before they were kept). */
  readonly projectiles?: readonly SavedProjectile[];
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

  constructor(save: WorldSave) {
    for (const actor of save.actors) this.#actors.set(actor.reference, actor);
    for (const [reference, graph] of save.graphs) this.#graphs.set(reference, graph);
    this.#projectiles = save.projectiles ?? [];
  }

  /** What flew as the game was saved, once (the projectiles fly it on as the world loads). */
  takeProjectiles(): readonly SavedProjectile[] {
    const projectiles = this.#projectiles;
    this.#projectiles = [];
    return projectiles;
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
