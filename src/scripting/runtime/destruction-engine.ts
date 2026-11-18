// Destructible objects in the running game (docs/gameplay.md, "Destruction"): a reference
// whose base carries destruction data (DEST: src/world/destruction-records.ts) has a health of
// its own that scripts' DamageObject, weapon hits, spells and explosions take from (by the
// rules of src/gameplay/destruction.ts). Each stage it reaches sets its explosion off at it (the
// casting engine's explode: its damage and force; the world shows it), has the world throw its
// debris and show the stage's model (DMDL, or its own model at the stage's model damage stage),
// disables or destroys it by the stage's flags, starts its self damage per second, and tells
// its scripts (OnDestructionStageChanged). The state (health, stage, destroyed) is the game
// state's, saved with it. Platform-independent.

import {
  damageDestructible,
  maxDestructionHealth,
  stageOf,
  type DamageKind,
} from '../../gameplay/destruction.ts';
import { meshPath } from '../../world/actors.ts';
import type { AlternateTexture } from '../../world/actor-records.ts';
import { baseModelPath } from '../../world/cell-records.ts';
import {
  DESTRUCTIBLE_TYPES,
  DestructionStageFlag,
  parseDebris,
  parseDestruction,
  type DebrisRecord,
  type DestructionData,
  type DestructionStage,
} from '../../world/destruction-records.ts';
import type { Vec3 } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';

const DESTRUCTIBLE = new Set<string>(DESTRUCTIBLE_TYPES);

/** How a destructible reference looks now (its stage's model, or its own at a damage stage). */
export interface DestructionLook {
  /** The model's path (meshes\...). */
  readonly model: string;
  /** The model damage stage its BSDamageStage nodes show (0: as undamaged). */
  readonly damageStage: number;
  /** DMDS: texture sets swapped onto the stage model's shapes. */
  readonly alternateTextures: readonly AlternateTexture[];
}

/** Who did the damage (the blame for an explosion it sets off). */
export interface DestructionHit {
  readonly external: boolean;
  readonly source?: number | undefined;
}

export class DestructionEngine {
  readonly #runtime: ScriptRuntime;
  readonly #data = new Map<number, Promise<DestructionData | undefined>>();
  readonly #debris = new Map<number, Promise<DebrisRecord | undefined>>();
  readonly #references = new Map<number, Promise<boolean>>();
  /** References in a stage with self damage per second (found again from the state on load). */
  readonly #selfDamaging = new Set<number>();
  #restored = false;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  /** A base object's destruction data, read once (undefined: not destructible). */
  data(base: number): Promise<DestructionData | undefined> {
    let pending = this.#data.get(base);
    if (!pending) {
      pending = this.#runtime.forms.record(base).then((record) => {
        if (!record || !DESTRUCTIBLE.has(record.type)) return undefined;
        const data = parseDestruction(record);
        return data && data.stages.length > 0 ? data : undefined;
      });
      this.#data.set(base, pending);
    }
    return pending;
  }

  /** Whether a reference's base is destructible (asked of every loaded one: kept). */
  #destructible(reference: number): Promise<boolean> {
    let pending = this.#references.get(reference);
    if (!pending) {
      pending = this.#runtime
        .baseOf(reference)
        .then(async (base) => base !== undefined && (await this.data(base)) !== undefined);
      this.#references.set(reference, pending);
    }
    return pending;
  }

  /** A DEBR record, read once. */
  debris(formId: number): Promise<DebrisRecord | undefined> {
    let pending = this.#debris.get(formId);
    if (!pending) {
      pending = this.#runtime.forms
        .record(formId)
        .then((record) => (record?.type === 'DEBR' ? parseDebris(record) : undefined));
      this.#debris.set(formId, pending);
    }
    return pending;
  }

  /**
   * A reference's destruction data (its base's); undefined for actors (their health is their
   * actor value: TODO(M13): the two spriggans whose NPC_ carries DEST) and the rest.
   */
  async of(reference: number): Promise<DestructionData | undefined> {
    const base = await this.#runtime.baseOf(reference);
    if (base === undefined) return undefined;
    const data = await this.data(base);
    if (!data || (await this.#runtime.actors.isActor(reference))) return undefined;
    return data;
  }

  /** GetCurrentDestructionStage: the stages it has reached (0 undamaged). */
  stage(reference: number): number {
    return this.#runtime.state.references.get(reference)?.destructionStage ?? 0;
  }

  isDestroyed(reference: number): boolean {
    return this.#runtime.state.references.get(reference)?.destroyed === true;
  }

  /** Its health left (its base's DEST health while undamaged). */
  async health(reference: number): Promise<number | undefined> {
    const data = await this.of(reference);
    if (!data) return undefined;
    return this.#runtime.state.references.get(reference)?.destructionHealth ?? data.health;
  }

  /** The stage it is in now, if any. */
  async currentStage(reference: number): Promise<DestructionStage | undefined> {
    const data = await this.of(reference);
    return data && stageOf(data, this.stage(reference));
  }

  /**
   * Damage to a destructible reference (DamageObject: not external; a weapon's hit, a spell's,
   * an explosion's: external). Resolves once the stages it reached have been applied.
   */
  async damage(reference: number, amount: number, hit: DestructionHit): Promise<void> {
    await this.#take(reference, amount, { external: hit.external }, hit.source);
  }

  /** BlowUp: on through every stage left, as if it took all the damage it can. */
  async blowUp(reference: number, source?: number): Promise<void> {
    await this.#take(reference, 0, { external: false, blowUp: true }, source);
  }

  /** ClearDestruction: undamaged again (its health, stage and destroyed state; its look). */
  clear(reference: number): void {
    const state = this.#runtime.state.references.get(reference);
    if (!state) return;
    state.destroyed = false;
    state.destructionStage = 0;
    delete state.destructionHealth;
    this.#selfDamaging.delete(reference);
    this.#runtime.world.destructionChanged?.(reference, undefined);
  }

  /** SetDestroyed: its destroyed state only (no stage changes; the world shows what it is). */
  setDestroyed(reference: number, destroyed: boolean): void {
    this.#runtime.state.reference(reference).destroyed = destroyed;
    this.#runtime.world.destructionChanged?.(reference, undefined);
  }

  /** How a reference looks at its stage (undefined: as placed, its own model undamaged). */
  async look(reference: number): Promise<DestructionLook | undefined> {
    const stage = this.stage(reference);
    if (stage <= 0) return undefined;
    const base = await this.#runtime.baseOf(reference);
    const data = base === undefined ? undefined : await this.data(base);
    if (!data || base === undefined) return undefined;
    // The model of the latest stage reached that has one stays (a later stage without its own
    // model shows it on); else its own model at the stage's model damage stage.
    // TODO(M13): whether a later stage's model damage stage applies to an earlier DMDL.
    for (let index = Math.min(stage, data.stages.length) - 1; index >= 0; index--) {
      const own = data.stages[index];
      if (own?.model) {
        return {
          model: meshPath(own.model),
          damageStage: 0,
          alternateTextures: own.alternateTextures,
        };
      }
    }
    const current = stageOf(data, Math.min(stage, data.stages.length));
    const record = await this.#runtime.forms.record(base);
    const model = record && baseModelPath(record);
    if (!model || !current || current.modelDamageStage === 0) return undefined;
    return { model, damageStage: current.modelDamageStage, alternateTextures: [] };
  }

  /**
   * The loaded destructible objects within a radius of a point (an explosion's: casting-engine.ts
   * explode), with their share of its damage (less with distance, as actors take it).
   */
  async within(
    point: readonly [number, number, number],
    radius: number,
    exclude?: number,
  ): Promise<{ readonly reference: number; readonly share: number }[]> {
    const runtime = this.#runtime;
    const found: { reference: number; share: number }[] = [];
    if (!(radius > 0)) return found;
    for (const reference of runtime.world.loadedReferences?.() ?? []) {
      if (reference === exclude || !(await this.#destructible(reference))) continue;
      const at = (await runtime.placement(reference))?.position;
      if (!at) continue;
      const distance = Math.hypot(at[0] - point[0], at[1] - point[1], at[2] - point[2]);
      if (distance <= radius) found.push({ reference, share: Math.max(0, 1 - distance / radius) });
    }
    return found;
  }

  /** Every frame: stages with self damage per second take it on (not past a damage cap). */
  update(seconds: number): void {
    if (!(seconds > 0)) return;
    if (!this.#restored) this.#restore();
    for (const reference of [...this.#selfDamaging]) {
      void this.#selfDamage(reference, seconds).catch((error: unknown) => {
        this.#runtime.warn(`destruction: ${String(error)}`);
      });
    }
  }

  /** The references a loaded game left in a stage with self damage tick on. */
  #restore(): void {
    this.#restored = true;
    for (const [reference, state] of this.#runtime.state.references) {
      if ((state.destructionStage ?? 0) > 0) this.#selfDamaging.add(reference);
    }
  }

  async #selfDamage(reference: number, seconds: number): Promise<void> {
    const stage = await this.currentStage(reference);
    const rate = stage?.selfDamagePerSecond ?? 0;
    if (rate <= 0) {
      this.#selfDamaging.delete(reference);
      return;
    }
    await this.#take(reference, rate * seconds, { external: false }, undefined);
  }

  async #take(
    reference: number,
    amount: number,
    kind: Omit<DamageKind, 'destroyed'>,
    source: number | undefined,
  ): Promise<void> {
    const runtime = this.#runtime;
    const data = await this.of(reference);
    if (!data) return;
    const state = runtime.state.reference(reference);
    const standing = {
      health: state.destructionHealth ?? maxDestructionHealth(data),
      stage: state.destructionStage ?? 0,
    };
    const step = damageDestructible(data, standing, amount, {
      ...kind,
      destroyed: state.destroyed === true,
    });
    // The state moves on at once (a blow or an explosion meanwhile starts from it).
    state.destructionHealth = step.health;
    state.destructionStage = step.stage;
    if (step.reached.length === 0) return;
    for (const reached of step.reached) {
      if (((data.stages[reached - 1]?.flags ?? 0) & DestructionStageFlag.destroy) !== 0)
        state.destroyed = true;
    }
    if ((stageOf(data, step.stage)?.selfDamagePerSecond ?? 0) > 0)
      this.#selfDamaging.add(reference);
    else this.#selfDamaging.delete(reference);
    let old = standing.stage;
    for (const reached of step.reached) {
      await this.#reach(reference, data, old, reached, source);
      old = reached;
    }
  }

  /** A stage reached: its look, debris and explosion, its Disable flag; the scripts told. */
  async #reach(
    reference: number,
    data: DestructionData,
    old: number,
    reached: number,
    source: number | undefined,
  ): Promise<void> {
    const runtime = this.#runtime;
    const stage = data.stages[reached - 1];
    if (!stage) return;
    // The world shows its new look and throws its debris.
    runtime.world.destructionChanged?.(reference, stage);
    if (stage.explosion !== undefined) {
      const at = (await runtime.placement(reference))?.position;
      if (at) {
        const point: Vec3 = [at[0], at[1], at[2]];
        runtime.world.explosion?.(stage.explosion, point, source ?? reference);
        await runtime.casting.explode(source, stage.explosion, point, reference);
      }
    }
    if ((stage.flags & DestructionStageFlag.disable) !== 0)
      await runtime.setEnabled(reference, false);
    await runtime.events.emitted('destructionStageChanged', {
      reference,
      oldStage: old,
      newStage: reached,
    });
  }
}
