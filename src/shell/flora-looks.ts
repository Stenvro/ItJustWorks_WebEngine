// How harvested flora looks (docs/gameplay.md, "Harvesting"): a FLOR or TREE the player has
// harvested (src/scripting/runtime/harvest-engine.ts) shows its model's harvested child (its
// NiSwitchNode's second: the flowers picked, the berries gone) until it grows again. The cell's
// own instance is hidden meanwhile and a scene of the harvested model stands in its place;
// models without a switch node look the same harvested (as in the game).

import { HARVESTED_SWITCH_CHILD } from '../world/flora-records.ts';
import type { CellObject } from '../world/cell-loader.ts';
import type { RenderPort } from '../render/render-port.ts';
import type { GpuScene, InstanceVisibility } from '../render/scene-renderer.ts';
import type { GameSession } from './game-session.ts';

interface Flora {
  readonly object: CellObject;
  readonly world: Float32Array;
  /** The cell's instance of it. */
  readonly visibility: InstanceVisibility;
  readonly enabled: () => boolean;
  /** The harvested look: loading, ready (its scene), or none (no switch node). */
  harvested:
    | Promise<void>
    | { readonly scene: GpuScene | undefined; readonly visibility: InstanceVisibility }
    | null
    | undefined;
  /** Whether the cell's instance is hidden here (harvested and its look ready). */
  hiding: boolean;
}

export class FloraLooks {
  readonly #session: GameSession;
  readonly #renderer: RenderPort;
  readonly #floras = new Map<number, Flora>();

  constructor(session: GameSession, renderer: RenderPort) {
    this.#session = session;
    this.#renderer = renderer;
  }

  /**
   * A harvestable object shown by a viewer: its placement, its instance's visibility and its
   * enable state.
   */
  add(
    object: CellObject,
    world: Float32Array,
    visibility: InstanceVisibility,
    enabled: () => boolean,
  ): void {
    if (!object.harvestable || this.#floras.has(object.reference)) return;
    this.#floras.set(object.reference, {
      object,
      world,
      visibility,
      enabled,
      harvested: undefined,
      hiding: false,
    });
  }

  /** It is no longer shown (its cell unloaded). */
  remove(reference: number): void {
    const flora = this.#floras.get(reference);
    if (!flora) return;
    this.#floras.delete(reference);
    if (flora.harvested && 'scene' in flora.harvested) flora.harvested.scene?.destroy();
  }

  clear(): void {
    for (const reference of [...this.#floras.keys()]) this.remove(reference);
  }

  /** The harvested looks, each frame brought up to date (harvested, grown again). */
  *scenes(): Iterable<GpuScene> {
    const harvest = this.#session.scriptsReady?.harvest;
    for (const flora of this.#floras.values()) {
      const harvested = harvest?.isHarvested(flora.object.reference) === true;
      if (harvested && flora.harvested === undefined) this.#load(flora);
      const look = flora.harvested && 'scene' in flora.harvested ? flora.harvested : undefined;
      if (harvested && look) {
        flora.visibility.hidden = true;
        flora.hiding = true;
        look.visibility.hidden = !flora.enabled();
      } else {
        if (look) look.visibility.hidden = true;
        if (flora.hiding) {
          flora.hiding = false;
          flora.visibility.hidden = !flora.enabled();
        }
      }
      if (look?.scene && !look.visibility.hidden) yield look.scene;
    }
  }

  #load(flora: Flora): void {
    flora.harvested = this.#session
      .switchedModel(flora.object.model, HARVESTED_SWITCH_CHILD)
      .then((model) => {
        if (this.#floras.get(flora.object.reference) !== flora) return;
        if (!model) {
          flora.harvested = null;
          return;
        }
        const visibility: InstanceVisibility = { hidden: true };
        const scene = this.#renderer.scene.createScene([{ model, world: flora.world, visibility }]);
        flora.harvested = { scene, visibility };
      })
      .catch(() => {
        flora.harvested = null;
      });
  }
}
