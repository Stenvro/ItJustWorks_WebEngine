// Harvesting flora on the running game (docs/gameplay.md, "Harvesting"): activating a FLOR or a
// TREE with an ingredient (src/world/flora-records.ts) gives the harvester its PFIG (an
// ingredient, or a leveled list resolved) by the season's chance (PFPC), as many as the
// harvester's perks make one (Mod Ingredients Harvested: Green Thumb's two), with the harvest
// sound (SNAM) and the item's message; the reference is harvested from then on (the world
// shows its model's harvested look). A harvested flora grows again as it resets with its cell
// (cell-reset.ts: the cell's or its encounter zone's clock; not a reference flagged No Respawn,
// as a coin purse placed so that it never comes back). Platform-independent.

import { EntryPoint } from '../../gameplay/perk-entry-points.ts';
import { parseFlora, productionChance, type FloraRecord } from '../../world/flora-records.ts';
import { RESET_DEFAULTS } from './cell-reset.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

/** What a harvest gave. */
export interface Harvest {
  /** The ingredient (or list) and how many (0: nothing grew this season). */
  readonly ingredient: number;
  readonly count: number;
  /** SNDR the world plays at the flora (its harvest sound). */
  readonly sound: number | undefined;
}

/** How often harvested flora without a cell is looked at (real seconds). */
const SWEEP_SECONDS = 2;

export class HarvestEngine {
  readonly #runtime: ScriptRuntime;
  readonly #floras = new Map<number, Promise<FloraRecord | undefined>>();
  #sinceSweep = SWEEP_SECONDS;
  #sweeping = false;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
  }

  /** The flora a reference's base is, if it can be harvested. */
  async flora(reference: number): Promise<FloraRecord | undefined> {
    const base = await this.#runtime.baseOf(reference);
    if (base === undefined) return undefined;
    let pending = this.#floras.get(base);
    if (!pending) {
      pending = this.#runtime.forms
        .record(base)
        .then((record) => (record ? parseFlora(record) : undefined));
      this.#floras.set(base, pending);
    }
    return pending;
  }

  /** Whether a reference has been harvested (and has not grown again). */
  isHarvested(reference: number): boolean {
    return this.#runtime.state.references.get(reference)?.harvested !== undefined;
  }

  /**
   * An actor harvests a flora: the ingredient by the season's chance, as many as its perks
   * make (Mod Ingredients Harvested), the sound the world plays; undefined if it cannot be (not flora, already
   * harvested).
   */
  async harvest(actor: number, reference: number): Promise<Harvest | undefined> {
    const runtime = this.#runtime;
    const flora = await this.flora(reference);
    if (!flora || this.isHarvested(reference)) return undefined;
    const cell = runtime.forms.db.cellOfReference(reference) ?? this.#playerCell();
    runtime.state.reference(reference).harvested = {
      at: runtime.state.gameDaysPassed,
      ...(cell !== undefined && { cell }),
    };
    let count = 0;
    if (Math.random() < productionChance(flora, runtime.date.month)) {
      const perks = await runtime.perks.apply(EntryPoint.modIngredientsHarvested, actor, 1, [
        flora.ingredient,
      ]);
      count = Math.max(1, Math.round(perks));
      await runtime.addItem(actor, runtime.formHandle(flora.ingredient), count, false);
      if (actor === PLAYER_REF) runtime.incrementStat('Ingredients Harvested');
    }
    // Nothing grew this season: the default object's harvest-failed sound (HVFS) instead.
    const failed = count === 0 ? await runtime.magic.defaultObject('HVFS') : undefined;
    return { ingredient: flora.ingredient, count, sound: failed ?? flora.sound };
  }

  /** The cell the player is in now (as the world places them), if known. */
  #playerCell(): number | undefined {
    return this.#runtime.world.livePlacement?.(PLAYER_REF)?.cell;
  }

  /**
   * Every frame: harvested flora whose harvest noted no cell grows again by its own clock.
   * Flora of a cell grows again only with its cell's reset (cell-reset.ts).
   */
  update(realSeconds: number): void {
    this.#sinceSweep += realSeconds;
    if (this.#sinceSweep < SWEEP_SECONDS || this.#sweeping) return;
    this.#sinceSweep = 0;
    this.#sweeping = true;
    void this.#regrow().finally(() => {
      this.#sweeping = false;
    });
  }

  /**
   * Harvested flora without a cell grows again once more than iHoursToRespawnCell game hours
   * have passed since its harvest. Inferred: such flora has no cell to reset with. TODO(M13):
   * what the engine does with harvested flora that has no cell.
   */
  async #regrow(): Promise<void> {
    const state = this.#runtime.state;
    let hours: number | undefined;
    for (const entry of state.references.values()) {
      const harvested = entry.harvested;
      if (!harvested || harvested.cell !== undefined) continue;
      hours ??= await this.#respawnHours();
      if ((state.gameDaysPassed - harvested.at) * 24 < hours) continue;
      delete entry.harvested;
    }
  }

  /** iHoursToRespawnCell (game hours). */
  async #respawnHours(): Promise<number> {
    const value = await this.#runtime.gameSetting('iHoursToRespawnCell');
    return typeof value === 'number' ? value : RESET_DEFAULTS.iHoursToRespawnCell;
  }
}
