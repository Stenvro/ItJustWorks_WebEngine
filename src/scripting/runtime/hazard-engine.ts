// Hazards on the running game (docs/gameplay.md, "Magic effects"): a hazard (HAZD:
// src/world/hazard-records.ts) placed by a magic effect (Spawn Hazard: Wall of Flames, a
// Guardian Circle; Guide: Clairvoyance's trail), an explosion (EXPL's placed object) or an
// impact (IPCT NAM2) stands where it was put for its lifetime (or, with Inherit Duration from
// Spawn Spell or without one, as long as what placed it), as many of one source's as its limit
// allows (the oldest go), and every target interval puts its spell on the actors within its
// radius (the player only with Affects Player Only), cast by its source. Its model is the
// created reference's (the world draws it); its light, sound and image-space modifier the
// world shows while it stands (`active`). Platform-independent.

import { UNITS_PER_FOOT } from '../../gameplay/magic/effect-rules.ts';
import { HazardFlag, parseHazard, type HazardRecord } from '../../world/hazard-records.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

/** A hazard standing in the world. */
export interface PlacedHazard {
  readonly reference: number;
  readonly hazard: HazardRecord;
  /** Whose it is (its spell's caster, the limit's owner). */
  readonly source: number | undefined;
  /** Seconds it has stood, and stands in all (undefined: until taken away). */
  age: number;
  readonly lifetime: number | undefined;
  /** Seconds to its spell's next hits. */
  nextHit: number;
  /** Units. */
  readonly radius: number;
}

export class HazardEngine {
  readonly #runtime: ScriptRuntime;
  readonly #records = new Map<number, Promise<HazardRecord | undefined>>();
  readonly #placed = new Map<number, PlacedHazard>();
  #hitting = false;
  /** Called as a hazard goes (the world stops its sound and light). */
  onRemoved: ((reference: number) => void) | undefined;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  /** A HAZD record, read once (undefined: not a hazard). */
  record(formId: number): Promise<HazardRecord | undefined> {
    let pending = this.#records.get(formId);
    if (!pending) {
      pending = this.#runtime.forms
        .record(formId)
        .then((record) => (record?.type === 'HAZD' ? parseHazard(record) : undefined));
      this.#records.set(formId, pending);
    }
    return pending;
  }

  /** The hazards standing now. */
  get active(): Iterable<PlacedHazard> {
    return this.#placed.values();
  }

  get(reference: number): PlacedHazard | undefined {
    return this.#placed.get(reference);
  }

  /**
   * Places a hazard at a point (an explosion's, an impact's, a trail's) for a source; resolves
   * its reference (undefined: not a hazard).
   */
  async place(
    formId: number,
    at: readonly [number, number, number],
    source: number | undefined,
    options: { readonly duration?: number; readonly area?: number } = {},
  ): Promise<number | undefined> {
    const hazard = await this.record(formId);
    if (!hazard) return undefined;
    const runtime = this.#runtime;
    const reference = await runtime.placeAt(formId, source ?? PLAYER_REF, 1);
    runtime.move(reference, [...at]);
    await this.track(reference, formId, source, options);
    return reference;
  }

  /**
   * A hazard reference placed (by the magic system's Spawn Hazard, or `place`) comes under the
   * engine: its lifetime, its limit, its spell. `duration`: its spawning spell's (Inherit
   * Duration from Spawn Spell); `area`: its spell's area in feet (Inherit Radius).
   */
  async track(
    reference: number,
    formId: number,
    source: number | undefined,
    options: { readonly duration?: number; readonly area?: number } = {},
  ): Promise<void> {
    const hazard = await this.record(formId);
    if (!hazard) return;
    const inheritDuration = (hazard.flags & HazardFlag.inheritDurationFromSpawnSpell) !== 0;
    const lifetime =
      inheritDuration && options.duration !== undefined && options.duration > 0
        ? options.duration
        : hazard.lifetime > 0
          ? hazard.lifetime
          : undefined;
    const feet =
      (hazard.flags & HazardFlag.inheritRadiusFromSpawnSpell) !== 0 && options.area
        ? options.area
        : hazard.radius;
    // Beyond its limit the source's oldest of it go.
    if (hazard.limit > 0) {
      const same = [...this.#placed.values()].filter(
        (other) => other.hazard.formId === formId && other.source === source,
      );
      while (same.length >= hazard.limit) {
        const oldest = same.shift();
        if (oldest) this.remove(oldest.reference);
      }
    }
    this.#placed.set(reference, {
      reference,
      hazard,
      source,
      age: 0,
      lifetime,
      nextHit: 0,
      radius: feet * UNITS_PER_FOOT,
    });
  }

  /** A hazard goes (its lifetime ran out, its effect ended, its limit). */
  remove(reference: number): void {
    if (!this.#placed.delete(reference)) return;
    const runtime = this.#runtime;
    const state = runtime.state.reference(reference);
    if (state.deleted !== true) {
      state.deleted = true;
      runtime.world.enableChanged?.(reference, false);
    }
    this.onRemoved?.(reference);
  }

  /** Every frame (real seconds): lifetimes run out, spells hit those within reach. */
  update(seconds: number): void {
    if (seconds <= 0 || this.#placed.size === 0) return;
    const due: PlacedHazard[] = [];
    for (const placed of [...this.#placed.values()]) {
      placed.age += seconds;
      if (this.#runtime.state.references.get(placed.reference)?.deleted === true) {
        this.remove(placed.reference);
        continue;
      }
      if (placed.lifetime !== undefined && placed.age >= placed.lifetime) {
        this.remove(placed.reference);
        continue;
      }
      if (placed.hazard.spell === undefined) continue;
      placed.nextHit -= seconds;
      if (placed.nextHit > 0) continue;
      placed.nextHit = Math.max(0.05, placed.hazard.targetInterval);
      due.push(placed);
    }
    if (due.length === 0 || this.#hitting) return;
    this.#hitting = true;
    void this.#hit(due)
      .catch((error: unknown) => {
        this.#runtime.warn(`hazards: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.#hitting = false;
      });
  }

  /** Each hazard's spell on the living actors within its radius. */
  async #hit(due: readonly PlacedHazard[]): Promise<void> {
    const runtime = this.#runtime;
    const world = runtime.world;
    const loaded = [...(world.loadedReferences?.() ?? []), PLAYER_REF];
    for (const placed of due) {
      const spell = placed.hazard.spell;
      const item = spell === undefined ? undefined : await runtime.magic.item(spell);
      const at = world.livePlacement?.(placed.reference)?.position;
      if (!item || !at) continue;
      const onlyPlayer = (placed.hazard.flags & HazardFlag.affectsPlayerOnly) !== 0;
      for (const reference of new Set(loaded)) {
        if (onlyPlayer && reference !== PLAYER_REF) continue;
        const feet = world.livePlacement?.(reference)?.position;
        if (!feet) continue;
        const distance = Math.hypot(feet[0] - at[0], feet[1] - at[1], feet[2] - at[2]);
        if (distance > placed.radius) continue;
        if (!(await runtime.actors.isActor(reference)) || (await runtime.actors.isDead(reference)))
          continue;
        await runtime.magic.apply(item, reference, {
          ...(placed.source !== undefined && { caster: placed.source }),
        });
      }
    }
  }
}
