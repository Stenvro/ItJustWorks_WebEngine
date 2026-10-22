// Harvesting flora on the running game (docs/gameplay.md, "Harvesting"): activating a FLOR or a
// TREE with an ingredient (src/world/flora-records.ts) gives the harvester its PFIG (an
// ingredient, or a leveled list resolved) by the season's chance (PFPC), as many as the
// harvester's perks make one (Mod Ingredients Harvested: Green Thumb's two), with the harvest
// sound (SNAM) and the item's message; the reference is harvested from then on (the world
// shows its model's harvested look). A harvested flora grows again as its cell resets (UESP
// "Skyrim:Respawning"): once the player has not been in that cell for iHoursToRespawnCell game
// hours (iHoursToRespawnCellCleared where its location is cleared; never in an interior whose
// encounter zone Never Resets). Platform-independent.

import { EntryPoint } from '../../gameplay/perk-entry-points.ts';
import { parseFlora, productionChance, type FloraRecord } from '../../world/flora-records.ts';
import { EncounterZoneFlag, parseEncounterZone } from '../../world/leveling-records.ts';
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

/** iHoursToRespawnCell, iHoursToRespawnCellCleared (the engine's values, Skyrim.esm's too). */
const RESPAWN_HOURS = 240;
const RESPAWN_HOURS_CLEARED = 720;

/** How often the player's cell is noted and harvested flora looked at (real seconds). */
const SWEEP_SECONDS = 2;

export class HarvestEngine {
  readonly #runtime: ScriptRuntime;
  readonly #floras = new Map<number, Promise<FloraRecord | undefined>>();
  #sinceSweep = SWEEP_SECONDS;
  #sweeping = false;
  /** Called as a reference grows again (the world shows it unharvested). */
  onRegrown: ((reference: number) => void) | undefined;

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
    }
    return { ingredient: flora.ingredient, count, sound: flora.sound };
  }

  /** The cell the player is in now (as the world places them), if known. */
  #playerCell(): number | undefined {
    return this.#runtime.world.livePlacement?.(PLAYER_REF)?.cell;
  }

  /** Every frame: the player's cell is noted (its flora's reset waits), harvested flora regrow. */
  update(realSeconds: number): void {
    this.#sinceSweep += realSeconds;
    if (this.#sinceSweep < SWEEP_SECONDS || this.#sweeping) return;
    this.#sinceSweep = 0;
    const state = this.#runtime.state;
    const cell = this.#playerCell();
    if (cell !== undefined) state.cellVisits.set(cell, state.gameDaysPassed);
    this.#sweeping = true;
    void this.#regrow(cell).finally(() => {
      this.#sweeping = false;
    });
  }

  /** Harvested flora whose cell has reset grow again (not the cell the player is in). */
  async #regrow(playerCell: number | undefined): Promise<void> {
    const state = this.#runtime.state;
    for (const [reference, entry] of state.references) {
      const harvested = entry.harvested;
      if (!harvested || (harvested.cell !== undefined && harvested.cell === playerCell)) continue;
      const hours = await this.respawnHours(harvested.cell);
      const last = Math.max(
        harvested.at,
        harvested.cell === undefined ? 0 : (state.cellVisits.get(harvested.cell) ?? 0),
      );
      if ((state.gameDaysPassed - last) * 24 < hours) continue;
      delete entry.harvested;
      this.onRegrown?.(reference);
    }
  }

  /**
   * Game hours a cell takes to reset: iHoursToRespawnCell, iHoursToRespawnCellCleared where its
   * location is cleared, never for an interior whose encounter zone Never Resets.
   */
  async respawnHours(cell: number | undefined): Promise<number> {
    const runtime = this.#runtime;
    const setting = async (name: string, fallback: number): Promise<number> => {
      const value = await runtime.gameSetting(name);
      return typeof value === 'number' ? value : fallback;
    };
    const record = cell === undefined ? undefined : await runtime.forms.record(cell);
    if (!record) return setting('iHoursToRespawnCell', RESPAWN_HOURS);
    const interior = runtime.forms.db.worldOfCell(record.formId) === undefined;
    const zoneId = record.formIdField('XEZN');
    const zone = zoneId === undefined ? undefined : await runtime.forms.record(zoneId);
    if (interior && zone && (parseEncounterZone(zone).flags & EncounterZoneFlag.neverResets) !== 0)
      return Number.POSITIVE_INFINITY;
    const location = record.formIdField('XLCN');
    if (location !== undefined && cleared(runtime, location))
      return setting('iHoursToRespawnCellCleared', RESPAWN_HOURS_CLEARED);
    return setting('iHoursToRespawnCell', RESPAWN_HOURS);
  }
}

/** Whether a location is cleared (Location.SetCleared, the dungeons' bosses). */
function cleared(runtime: ScriptRuntime, location: number): boolean {
  return runtime.state.locations.get(location)?.cleared === true;
}
