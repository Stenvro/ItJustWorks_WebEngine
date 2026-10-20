// References the running game's scripts create (PlaceAtMe, an alias's Create Reference): each
// is drawn from its base object's model in a small scene of its own, collides (a loose item
// falls and settles), lights (a placed light), can be activated, moved, enabled and disabled,
// like the cell's own references.

import { parseLight, LightFlag, baseModelPath } from '../world/cell-records.ts';
import { referenceMatrix, type CellLight, type CellObject } from '../world/cell-loader.ts';
import { parseItem } from '../world/item-records.ts';
import type { GpuScene, InstanceVisibility, ModelInstance } from '../render/scene-renderer.ts';
import type { Renderer } from '../render/renderer.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { GameSession } from './game-session.ts';
import { collisionGroup, type CollisionGroup, type PlaySession } from './play-session.ts';

export interface CreatedObject {
  readonly reference: number;
  readonly object: CellObject;
  readonly instance: ModelInstance | undefined;
  readonly scene: GpuScene | undefined;
  readonly light: CellLight | undefined;
  readonly visibility: InstanceVisibility;
  readonly collision: CollisionGroup;
}

export class CreatedObjects {
  readonly #session: GameSession;
  readonly #renderer: Renderer;
  readonly #entries = new Map<number, CreatedObject>();

  constructor(session: GameSession, renderer: Renderer) {
    this.#session = session;
    this.#renderer = renderer;
  }

  get(reference: number): CreatedObject | undefined {
    return this.#entries.get(reference);
  }

  get all(): Iterable<CreatedObject> {
    return this.#entries.values();
  }

  /** Builds a created reference where the scripts placed it (once; again after a removal). */
  async add(
    runtime: ScriptRuntime,
    reference: number,
    play: PlaySession | undefined,
  ): Promise<void> {
    if (this.#entries.has(reference)) return;
    const base = await runtime.baseOf(reference);
    const record = base === undefined ? undefined : await runtime.forms.record(base);
    const at = await runtime.placement(reference);
    if (!record || !at || this.#entries.has(reference)) return;
    // Created actors are the actor stage's (src/shell/actor-stage.ts).
    if (record.type === 'NPC_' || record.type === 'LVLN') return;
    const world = referenceMatrix({
      position: at.position,
      rotation: at.rotation,
      scale: at.scale,
    });
    const visibility: InstanceVisibility = { hidden: !createdEnabled(runtime, reference) };
    const path = baseModelPath(record);
    const item = parseItem(record);
    const object: CellObject = {
      reference,
      base: base ?? 0,
      baseType: record.type,
      editorId: record.editorId ?? '',
      name: record.text('FULL') ?? '',
      model: path ?? '',
      world,
      water: undefined,
      ...(item && { item: { weight: item.weight, value: item.value } }),
    };
    const [model, collision] = path
      ? await Promise.all([this.#session.model(path), this.#session.collision(path)])
      : [undefined, undefined];
    // A loose arrow is the ammunition model's single arrow (its quiver is what is worn); one
    // stuck where it hit (src/shell/combat-projectiles.ts: keyframed) stays there.
    const keyframed = runtime.state.references.get(reference)?.motionType === 4;
    const moves =
      !keyframed &&
      collision?.bodies.some((body) => body.motion === 'dynamic' && !body.phantom) === true;
    const arrow = record.type === 'AMMO';
    const instance: ModelInstance | undefined = model && {
      model,
      world: moves ? new Float32Array(world) : world,
      ...(moves && { motion: { version: 0 } }),
      visibility,
      ...(arrow && { partShown: (part) => part.name.toLowerCase() === 'arrow:0' }),
    };
    const scene = instance && this.#renderer.scene.createScene([instance]);
    let light: CellLight | undefined;
    if (record.type === 'LIGH') {
      const data = parseLight(record);
      if ((data.flags & LightFlag.offByDefault) === 0) {
        light = {
          reference,
          position: at.position,
          radius: data.radius,
          color: data.color,
          fade: data.fade,
          flags: data.flags,
          period: data.period,
          intensityAmplitude: data.intensityAmplitude,
          movementAmplitude: data.movementAmplitude,
        };
      }
    }
    const group = collisionGroup();
    const entry: CreatedObject = {
      reference,
      object,
      instance,
      scene,
      light,
      visibility,
      collision: group,
    };
    this.#entries.set(reference, entry);
    if (play && collision) {
      if (keyframed) {
        group.whenComplete.push(() => {
          for (const placed of group.collision) play.physics.setMotion(placed, true);
        });
      }
      play.add(group, {
        objects: [{ object, collision, instance }],
        primitives: [],
        isEnabled: () => !visibility.hidden,
      });
    }
  }

  /** A created reference goes (deleted, or its cell unloaded). */
  remove(reference: number, play: PlaySession | undefined): void {
    const entry = this.#entries.get(reference);
    if (!entry) return;
    this.#entries.delete(reference);
    play?.remove(entry.collision);
    entry.scene?.destroy();
  }

  /** Every created reference goes (the view changes). */
  clear(play: PlaySession | undefined): void {
    for (const reference of [...this.#entries.keys()]) this.remove(reference, play);
  }

  /** Their enable states as the scripts left them. */
  refresh(runtime: ScriptRuntime, play: PlaySession | undefined): void {
    for (const entry of this.#entries.values()) {
      const enabled = createdEnabled(runtime, entry.reference);
      if (entry.visibility.hidden === !enabled) continue;
      entry.visibility.hidden = !enabled;
      play?.setReferenceEnabled(entry.reference, enabled);
    }
  }

  *scenes(): Iterable<GpuScene> {
    for (const entry of this.#entries.values()) if (entry.scene) yield entry.scene;
  }

  /** The lights of the enabled created references. */
  lights(): CellLight[] {
    return [...this.#entries.values()].flatMap((entry) =>
      entry.light && !entry.visibility.hidden ? [entry.light] : [],
    );
  }
}

/** A created reference is enabled unless a script disabled or deleted it. */
export function createdEnabled(runtime: ScriptRuntime, reference: number): boolean {
  const state = runtime.state.references.get(reference);
  return state?.deleted !== true && state?.container === undefined && state?.enabled !== false;
}
