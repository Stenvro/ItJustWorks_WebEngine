// Traps hitting actors (docs/scripting.md, "Traps"). Observed in the original: every physics
// world has a trap listener; bodies on the trap layers (L_TRAP, L_CLOUDTRAP) are its traps, and
// a contact between one and an actor (its character controller) is a hit. The engine keeps an
// entry per trap and target: a new contact tells the start (TESTrapHitEvent: the scripts'
// OnTrapHitStart), a contact that goes on tells a hit once more than [Havok]
// fTrapHitEventDelayMS (500 ms by default) has passed since the entry's last telling (OnTrapHit;
// the first 500 ms after the start), and the contact's end tells the stop (OnTrapHitStop). Each
// carries the trap body's velocity, where it touches, the material and the body's motion type;
// the "initial hit" flag is false for these contacts (the entry's flag; what sets it is not
// read). The scripts hear the hits only on living actors (script-events.ts). Platform-independent.

import type { EventHub } from './event-hub.ts';

/**
 * How near (game units) a trap's body must be to an actor's controller to touch it: the
 * controller keeps a skin's gap to what it stands against (src/physics/character.ts).
 */
export const TRAP_REACH = 2;

/** [Havok] fTrapHitEventDelayMS's built-in default (ms). */
export const TRAP_HIT_EVENT_DELAY_MS = 500;

type Vec3 = readonly [number, number, number];

/** A trap an actor touches now (the physics world's trapsTouching). */
export interface TrapTouchNow {
  readonly position: Vec3;
  readonly velocity: Vec3;
  readonly motionType: number;
}

interface Entry {
  /** Milliseconds (the clock's) of its last telling. */
  told: number;
  touch: TrapTouchNow;
}

export class TrapHits {
  /** fTrapHitEventDelayMS: the least time between two hits of one trap on one target (ms). */
  delayMs = TRAP_HIT_EVENT_DELAY_MS;
  readonly #events: EventHub;
  readonly #now: () => number;
  /** By target, then trap. */
  readonly #entries = new Map<number, Map<number, Entry>>();

  /** `now`: the clock in milliseconds (the engine's timer). */
  constructor(events: EventHub, now: () => number) {
    this.#events = events;
    this.#now = now;
  }

  /** The traps an actor touches now (its check each physics step): starts, hits and stops. */
  touching(target: number, touches: ReadonlyMap<number, TrapTouchNow>): void {
    const now = this.#now();
    let entries = this.#entries.get(target);
    for (const [trap, touch] of touches) {
      const entry = entries?.get(trap);
      if (!entry) {
        entries ??= new Map();
        this.#entries.set(target, entries);
        entries.set(trap, { told: now, touch });
        this.#tell(trap, target, 'start', touch);
        continue;
      }
      entry.touch = touch;
      if (now - entry.told > this.delayMs) {
        entry.told = now;
        this.#tell(trap, target, 'hit', touch);
      }
    }
    if (!entries) return;
    for (const [trap, entry] of [...entries]) {
      if (touches.has(trap)) continue;
      entries.delete(trap);
      this.#tell(trap, target, 'stop', entry.touch);
    }
    if (entries.size === 0) this.#entries.delete(target);
  }

  /** An actor or a trap is gone (its cell unloaded): its contacts end without a telling. */
  forget(reference: number): void {
    this.#entries.delete(reference);
    for (const [target, entries] of this.#entries) {
      entries.delete(reference);
      if (entries.size === 0) this.#entries.delete(target);
    }
  }

  #tell(trap: number, target: number, phase: 'start' | 'hit' | 'stop', touch: TrapTouchNow): void {
    this.#events.emit('trapHit', {
      trap,
      phase,
      target,
      velocity: touch.velocity,
      position: touch.position,
      // TODO(M13): the material of the trap's body at the contact (aeMaterial).
      material: undefined,
      initial: false,
      motionType: touch.motionType,
    });
  }
}
