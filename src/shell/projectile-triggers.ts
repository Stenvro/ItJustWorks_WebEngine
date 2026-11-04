// Projectiles in trigger volumes: a projectile in flight is a reference of the world, and a
// trigger whose layer collides with the projectile's tells it as it does anything else that
// comes in and goes out (OnTriggerEnter, OnTriggerLeave; the COLL records decide who is told:
// PhysicsWorld.triggersAlong). Ours fly without a reference: one is made as a shot first enters a
// trigger and goes when its flight ends, for the scripts to be told of.

import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';

type Vec3 = readonly [number, number, number];

interface Inside {
  readonly reference: number;
  triggers: ReadonlySet<number>;
}

export class ProjectileTriggers {
  readonly #runtime: () => ScriptRuntime | undefined;
  readonly #along: (from: Vec3, to: Vec3, layer: number) => ReadonlySet<number>;
  readonly #inside = new Map<object, Inside>();

  constructor(
    runtime: () => ScriptRuntime | undefined,
    along: (from: Vec3, to: Vec3, layer: number) => ReadonlySet<number>,
  ) {
    this.#runtime = runtime;
    this.#along = along;
  }

  /** A shot (`key`, of the projectile `base`) flew this way this step, on `layer`. */
  step(key: object, base: number, from: Vec3, to: Vec3, layer: number): void {
    const runtime = this.#runtime();
    if (!runtime) return;
    const now = this.#along(from, to, layer);
    let inside = this.#inside.get(key);
    if (!inside) {
      if (now.size === 0) return;
      inside = { reference: runtime.state.create(base, 1), triggers: new Set() };
      runtime.state.reference(inside.reference).position = [...to];
      this.#inside.set(key, inside);
    }
    for (const trigger of now) {
      if (!inside.triggers.has(trigger)) runtime.triggered(trigger, inside.reference, true);
    }
    for (const trigger of inside.triggers) {
      if (!now.has(trigger)) runtime.triggered(trigger, inside.reference, false);
    }
    inside.triggers = now;
  }

  /** A shot's flight ended: it leaves what it was in, and its reference goes. */
  end(key: object): void {
    const inside = this.#inside.get(key);
    if (!inside) return;
    this.#inside.delete(key);
    const runtime = this.#runtime();
    if (!runtime) return;
    for (const trigger of inside.triggers) runtime.triggered(trigger, inside.reference, false);
    runtime.deleteReference(inside.reference);
  }
}
