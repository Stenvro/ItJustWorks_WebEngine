// A weapon's idle sound (WEAP UNAM, "Idle Sound"): a loop that plays at the weapon while it is
// drawn in its holder's hand, and stops as it is sheathed or unequipped, as its holder dies or
// leaves. Vanilla's bound weapons name MAGConjureBoundWeaponLP: the conjured sword's hum.
// TODO(M13): that it plays while drawn (not while merely equipped) is inferred; bound weapons
// are drawn as long as they exist. src/shell/actor-combat.ts feeds it every frame.

import type { Vec3 } from '../render/math.ts';

/** A loop playing (the sound system's SoundInstance). */
interface Playing {
  stop(immediately?: boolean): void;
}

/** An actor holding a weapon drawn whose record names an idle sound. */
export interface WeaponIdle {
  readonly reference: number;
  /** The idle sound (SNDR) of the weapon in hand. */
  readonly sound: number;
  /** Where it plays (the weapon). */
  readonly place: () => Vec3;
}

/** Plays a looping descriptor at a place for a reference. */
export type PlayLoop = (
  descriptor: number,
  place: () => Vec3,
  source: number,
) => Promise<Playing | undefined> | undefined;

interface LoopState {
  readonly sound: number;
  playing: Playing | undefined;
  dropped: boolean;
}

export class WeaponIdleSounds {
  readonly #loops = new Map<number, LoopState>();
  readonly #play: PlayLoop;

  constructor(play: PlayLoop) {
    this.#play = play;
  }

  /** The actors whose drawn weapon sounds now: new ones start, the rest stop. */
  update(idles: Iterable<WeaponIdle>): void {
    const wanted = new Map<number, WeaponIdle>();
    for (const idle of idles) wanted.set(idle.reference, idle);
    for (const [reference, state] of this.#loops) {
      if (wanted.get(reference)?.sound !== state.sound) this.stop(reference);
    }
    for (const [reference, idle] of wanted) {
      if (this.#loops.has(reference)) continue;
      const state: LoopState = { sound: idle.sound, playing: undefined, dropped: false };
      this.#loops.set(reference, state);
      void this.#play(idle.sound, idle.place, reference)?.then((playing) => {
        if (state.dropped) playing?.stop();
        else state.playing = playing;
      });
    }
  }

  /** Its loop stops (sheathed, dead, gone). */
  stop(reference: number): void {
    const state = this.#loops.get(reference);
    if (!state) return;
    state.dropped = true;
    state.playing?.stop();
    this.#loops.delete(reference);
  }

  clear(): void {
    for (const reference of [...this.#loops.keys()]) this.stop(reference);
  }

  /** The references whose idle loops play (or are starting). */
  get sounding(): number[] {
    return [...this.#loops.keys()];
  }
}
