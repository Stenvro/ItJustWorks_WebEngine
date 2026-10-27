// Ripples on water surfaces: rings that spread from where actors and bodies enter the water (a
// splash) and from those wading or swimming through it (a wake: a ring each time they have moved
// on far enough). The water shader bends its normals by the rings (water.wgsl rippleNormal).
// Platform-independent.
//
// TODO(M13): the engine runs a displacement simulation (its water displacement textures and
// render targets); these analytic rings stand in for it.

import type { Vec3 } from './math.ts';

/** At most this many rings at once (WGSL WaterFrame.ripples). */
export const MAX_RIPPLES = 16;
/** How long a ring lasts (seconds). */
export const RIPPLE_LIFETIME = 2.5;
/** A wake leaves a new ring each time its actor has moved this far (game units)... */
export const WAKE_SPACING = 48;
/** ...or after this long standing in the water (seconds). */
export const WAKE_IDLE_INTERVAL = 1.5;

/** A ring: where it started (x, y), its age (seconds) and its strength (0..1). */
export interface Ripple {
  readonly x: number;
  readonly y: number;
  readonly age: number;
  readonly strength: number;
}

interface Ring {
  readonly x: number;
  readonly y: number;
  readonly start: number;
  readonly strength: number;
}

export class WaterRipples {
  #rings: Ring[] = [];
  /** Each wake's last ring: where and when. */
  readonly #wakes = new Map<number, { x: number; y: number; at: number }>();

  /** Something entered or left the water: a strong ring (its strength 0..1). */
  splash(position: Vec3, strength: number, now: number): void {
    this.#add(position[0], position[1], Math.min(1, Math.max(0.2, strength)), now);
  }

  /** An actor (key) in the water this frame, at the surface's point above its feet. */
  wake(key: number, position: Vec3, now: number): void {
    const last = this.#wakes.get(key);
    const moved = last ? Math.hypot(position[0] - last.x, position[1] - last.y) : Infinity;
    if (last && moved < WAKE_SPACING && now - last.at < WAKE_IDLE_INTERVAL) return;
    this.#wakes.set(key, { x: position[0], y: position[1], at: now });
    this.#add(position[0], position[1], moved >= WAKE_SPACING ? 0.5 : 0.25, now);
  }

  /** An actor left the water (its next wake starts at once). */
  leave(key: number): void {
    this.#wakes.delete(key);
  }

  /** The rings alive now, newest first. */
  active(now: number): Ripple[] {
    this.#rings = this.#rings.filter((ring) => now - ring.start < RIPPLE_LIFETIME);
    return this.#rings
      .map((ring) => ({ x: ring.x, y: ring.y, age: now - ring.start, strength: ring.strength }))
      .reverse();
  }

  #add(x: number, y: number, strength: number, now: number): void {
    this.#rings.push({ x, y, start: now, strength });
    // The oldest go first when there are too many.
    if (this.#rings.length > MAX_RIPPLES) this.#rings.splice(0, this.#rings.length - MAX_RIPPLES);
  }
}
