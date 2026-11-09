// Projectiles in trigger volumes: a projectile in flight is a reference of the world, and a
// trigger whose layer collides with the projectile's tells it as it does anything else that
// comes in and goes out (OnTriggerEnter, OnTriggerLeave; the COLL records decide who is told:
// PhysicsWorld.triggersAlong). Ours fly without a reference: one is made as a shot first enters a
// trigger and goes when its flight ends, for the scripts to be told of. A cone's wave (Unrelenting
// Force) is in every volume its sector reaches, off its middle line too (PhysicsWorld.triggersInCone).

import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';

type Vec3 = readonly [number, number, number];

interface Inside {
  readonly reference: number;
  triggers: ReadonlySet<number>;
}

/** The trigger volumes a cone's wave is in: its apex, direction, front, spread (°), layer. */
export type ConeTriggers = (
  apex: Vec3,
  direction: Vec3,
  front: number,
  spread: number,
  layer: number,
) => ReadonlySet<number>;

export class ProjectileTriggers {
  readonly #runtime: () => ScriptRuntime | undefined;
  readonly #along: (from: Vec3, to: Vec3, layer: number) => ReadonlySet<number>;
  readonly #cone: ConeTriggers | undefined;
  readonly #inside = new Map<object, Inside>();

  constructor(
    runtime: () => ScriptRuntime | undefined,
    along: (from: Vec3, to: Vec3, layer: number) => ReadonlySet<number>,
    cone?: ConeTriggers,
  ) {
    this.#runtime = runtime;
    this.#along = along;
    this.#cone = cone;
  }

  /** A shot (`key`, of the projectile `base`) flew this way this step, on `layer`. */
  step(key: object, base: number, from: Vec3, to: Vec3, layer: number): void {
    this.#told(key, base, to, () => this.#along(from, to, layer));
  }

  /**
   * A cone's wave (`key`, of the projectile `base`) reaches `front` from its apex, `spread`
   * degrees either side of `direction`, on `layer`: it is in every volume that sector reaches.
   * Without a cone query, along its middle line only.
   */
  sweep(
    key: object,
    base: number,
    apex: Vec3,
    direction: Vec3,
    front: number,
    spread: number,
    layer: number,
  ): void {
    const d = Math.hypot(direction[0], direction[1], direction[2]) || 1;
    const middle: Vec3 = [
      apex[0] + (direction[0] / d) * front,
      apex[1] + (direction[1] / d) * front,
      apex[2] + (direction[2] / d) * front,
    ];
    const cone = this.#cone;
    this.#told(key, base, middle, () =>
      cone ? cone(apex, direction, front, spread, layer) : this.#along(apex, middle, layer),
    );
  }

  #told(key: object, base: number, at: Vec3, inside: () => ReadonlySet<number>): void {
    const runtime = this.#runtime();
    if (!runtime) return;
    const now = inside();
    let known = this.#inside.get(key);
    if (!known) {
      if (now.size === 0) return;
      known = { reference: runtime.state.create(base, 1), triggers: new Set() };
      runtime.state.reference(known.reference).position = [...at];
      this.#inside.set(key, known);
    }
    for (const trigger of now) {
      if (!known.triggers.has(trigger)) runtime.triggered(trigger, known.reference, true);
    }
    for (const trigger of known.triggers) {
      if (!now.has(trigger)) runtime.triggered(trigger, known.reference, false);
    }
    known.triggers = now;
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
