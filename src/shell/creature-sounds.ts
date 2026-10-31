// Creature sounds (NPC_ CSDT/CSDI/CSDC, docs/audio.md "Creature sounds"): the loops a
// creature makes while it lives on the stage. Its conscious loop (type 7: a dragon's, a horse's
// or an elk's breathing, a draugr's groan, a gargoyle's or a dwarven sphere's hum) plays at its
// head while it is alive and conscious; its movement loop (type 6: the dwarven spheres' and
// spiders' machinery, the flame atronach's fire, the carriage's wheels) while it also moves.
// Both stop as it dies, falls unconscious or leaves the stage. Its idle sound (type 0: only the
// mudcrabs' AudioTemplateMudcrab names one, at 40 %) plays as it takes an ambient idle
// (src/shell/actor-ambient-idles.ts), with its chance (CSDC). TODO(M13): that the idle sound
// goes with the ambient idle, and that the chance gates each one, are inferred; the other
// one-shot types (Aware, Attack, Hit, Death, Weapon, Auxiliary, Jump) no record in the load
// order names.

import type { Vec3 } from '../render/math.ts';
import { CreatureSoundType, type CreatureSound } from '../world/actor-records.ts';

/** How fast an actor goes before its movement loop plays (units per second). */
const MOVING_SPEED = 20;

/** What a creature's loops depend on, each frame. */
export interface CreatureState {
  /** Alive and not unconscious. */
  readonly conscious: boolean;
  /** It moves (faster than MOVING_SPEED). */
  readonly moving: boolean;
}

/** The descriptors a creature's loops play now (CSDI), by its state. */
export function creatureLoops(sounds: readonly CreatureSound[], state: CreatureState): Set<number> {
  const loops = new Set<number>();
  if (!state.conscious) return loops;
  for (const sound of sounds) {
    if (sound.type === CreatureSoundType.consciousLoop) loops.add(sound.sound);
    else if (sound.type === CreatureSoundType.movementLoop && state.moving) loops.add(sound.sound);
  }
  return loops;
}

/** A loop playing (the sound system's SoundInstance). */
interface Playing {
  stop(immediately?: boolean): void;
}

/** An actor on the stage, as its creature sounds need it. */
export interface CreatureActor {
  readonly reference: number;
  readonly sounds: readonly CreatureSound[];
  readonly position: Vec3;
  readonly dead: boolean;
  /** Where its sounds play (its head). */
  readonly place: () => Vec3;
}

export interface CreatureSoundsOptions {
  /** Plays a looping descriptor at a place for a reference (its conditions run on it). */
  readonly play: (
    descriptor: number,
    place: () => Vec3,
    source: number,
  ) => Promise<Playing | undefined> | undefined;
  /** Whether an actor is unconscious (the game state's). */
  readonly unconscious: (reference: number) => boolean;
}

interface Tracked {
  /** The actor as last seen (its sounds, where they play). */
  actor: CreatureActor;
  /** Whether it was conscious last frame. */
  conscious: boolean;
  /** Where it stood last frame (its speed). */
  last: Vec3;
  /** The loops playing, by descriptor; a pending start is a promise. */
  readonly loops: Map<number, Promise<Playing | undefined> | Playing | undefined>;
}

export class CreatureSounds {
  readonly #options: CreatureSoundsOptions;
  readonly #actors = new Map<number, Tracked>();

  constructor(options: CreatureSoundsOptions) {
    this.#options = options;
  }

  /** Every frame: each creature's loops start and stop by its state. */
  frame(actors: Iterable<CreatureActor>, seconds: number): void {
    for (const actor of actors) {
      if (actor.sounds.length === 0) continue;
      let tracked = this.#actors.get(actor.reference);
      if (!tracked) {
        tracked = { actor, conscious: true, last: [...actor.position], loops: new Map() };
        this.#actors.set(actor.reference, tracked);
      }
      tracked.actor = actor;
      const [x, y, z] = actor.position;
      const travelled = Math.hypot(x - tracked.last[0], y - tracked.last[1], z - tracked.last[2]);
      tracked.last = [x, y, z];
      const moving = seconds > 0 && travelled / seconds > MOVING_SPEED;
      const conscious = !actor.dead && !this.#options.unconscious(actor.reference);
      tracked.conscious = conscious;
      const wanted = creatureLoops(actor.sounds, { conscious, moving });
      for (const [descriptor, loop] of tracked.loops) {
        if (wanted.has(descriptor)) continue;
        tracked.loops.delete(descriptor);
        void Promise.resolve(loop).then((playing) => playing?.stop());
      }
      for (const descriptor of wanted) {
        if (tracked.loops.has(descriptor)) continue;
        const start = this.#options.play(descriptor, actor.place, actor.reference);
        tracked.loops.set(descriptor, start);
        void start?.then((playing) => {
          // Stopped or replaced while it was loading.
          if (tracked.loops.get(descriptor) !== start) playing?.stop(true);
          else tracked.loops.set(descriptor, playing);
        });
      }
    }
  }

  /**
   * An actor took an ambient idle: its idle sound (type 0; one of them at random) plays at its
   * head with its chance (CSDC, percent).
   */
  idle(reference: number, random: () => number = Math.random): void {
    const tracked = this.#actors.get(reference);
    if (!tracked?.conscious) return;
    const idles = tracked.actor.sounds.filter((sound) => sound.type === CreatureSoundType.idle);
    const sound = idles[Math.min(idles.length - 1, Math.floor(random() * idles.length))];
    if (!sound || random() * 100 >= sound.chance) return;
    void this.#options.play(sound.sound, tracked.actor.place, reference);
  }

  /** An actor leaves the stage: its loops stop at once. */
  remove(reference: number): void {
    const tracked = this.#actors.get(reference);
    if (!tracked) return;
    this.#actors.delete(reference);
    for (const loop of tracked.loops.values())
      void Promise.resolve(loop).then((playing) => playing?.stop(true));
  }
}
