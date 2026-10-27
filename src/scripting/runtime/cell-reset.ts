// Cells resetting and respawning (docs/scripting.md, "Cell reset and cleared locations"). Observed in
// the original; the times are whole game hours, 0 for never.
//
// - A cell notes the hour it leaves the loaded area. As it comes back, a cell that never left
//   is as the plugins made it; one that left resets if more than iHoursToRespawnCell hours
//   have passed since (iHoursToRespawnCellCleared where its location is cleared). Its location
//   for that is its encounter zone's, else its own (XLCN), else its worldspace's.
// - A cell with an encounter zone (its own XEZN; outside, else its worldspace's) resets by the
//   zone instead: a zone that Never Resets keeps all its cells; else, as one of its cells comes
//   into the loaded area, the zone resets once the wait has passed since its cells last left
//   (and the first time it is met), and each of its cells that left before the zone's last
//   reset resets as it comes back. A zone that resets is levelled anew as it is next met.
// - What a reset does to each of the cell's references that may reset (not "No Respawn"; a
//   container only if its base Respawns, an actor base only if it Respawns; a leveled actor
//   unless "No Respawn"): what the game changed on it goes (its lock, open state, destruction,
//   harvest), a container's inventory is picked anew from its records, an object that is not
//   persistent goes back to its editor place, its enable state and animated state are as the
//   plugins made them, an actor comes back as its records make it, and it is told
//   (TESResetEvent: the scripts' OnReset). A reference that may not reset keeps all.
// - An actor keeps a respawn clock of its own: a dead actor respawns only once the wait has
//   passed since it died, also where its zone reset sooner.
// - What the game made in the cell goes with its reset: references created there (dropped
//   items, PlaceAtMe) lying in the world, unless a quest's alias holds them.
// - Corpses: as a cell that left comes back, a dead actor that does not respawn, did not start
//   dead and died more than iHoursToClearCorpses hours ago is removed.
//
// The reset is decided as the cell is about to load (so its references load as reset) and told
// as its references attach (ScriptRuntime.cellAttached: after OnCellAttach). Platform-independent.

import { RecordFlag } from '../../formats/esm/record.ts';
import { NpcFlag } from '../../world/actor-records.ts';
import { EncounterZoneFlag, parseEncounterZone } from '../../world/leveling-records.ts';
import type { GameRecord } from '../../world/record-db.ts';
import type { ZoneTimes } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';

/** The built-in defaults of the waits (game hours); Skyrim.esm sets 240 and 720 for the first two. */
export const RESET_DEFAULTS = {
  iHoursToRespawnCell: 72,
  iHoursToRespawnCellCleared: 144,
  iHoursToClearCorpses: 24,
} as const;

/** CONT DATA flags: the container's inventory comes back as its cell resets. */
const CONTAINER_RESPAWNS = 0x2;

export interface ResetWaits {
  /** iHoursToRespawnCell, iHoursToRespawnCellCleared. */
  readonly respawn: number;
  readonly cleared: number;
}

/**
 * Whether the wait has passed: from `since` (0: never, always passed) to `now`, more than the
 * respawn wait (the cleared one where the location is cleared).
 */
export function respawnDue(
  now: number,
  since: number,
  cleared: boolean,
  waits: ResetWaits,
): boolean {
  if (since === 0) return true;
  const wait = cleared ? waits.cleared : waits.respawn;
  return since < now && wait < now - since;
}

/** What the engine decides of a cell as it comes back (see the file's comment). */
export interface CellReturn {
  /** The cell resets (its references that may reset do). */
  readonly reset: boolean;
  /** It had left the loaded area before (a cell met the first time does nothing). */
  readonly returning: boolean;
}

/** How a cell comes back, by its clocks (the rule alone, for the cases and the engine). */
export function cellReturn(input: {
  readonly now: number;
  /** When the cell left (0: never). */
  readonly detached: number;
  /** Its location is cleared. */
  readonly cleared: boolean;
  /** Its encounter zone, with the zone's clocks as they are after the zone was met now. */
  readonly zone?: { readonly neverResets: boolean; readonly times: ZoneTimes };
  readonly waits: ResetWaits;
}): CellReturn {
  const { now, detached, waits } = input;
  if (detached === 0) return { reset: false, returning: false };
  if (!input.zone)
    return { reset: respawnDue(now, detached, input.cleared, waits), returning: true };
  const { neverResets, times } = input.zone;
  if (neverResets) return { reset: false, returning: true };
  return { reset: times.reset !== 0 && detached < times.reset, returning: true };
}

export class CellResets {
  readonly #runtime: ScriptRuntime;
  /** References reset as their cells came back, to be told as they attach. */
  readonly #told = new Set<number>();
  #waits: Promise<ResetWaits & { readonly corpses: number }> | undefined;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
    runtime.events.on('death', (event) => {
      if (event.dead) runtime.state.deathHours.set(event.actor, this.now);
    });
  }

  /** The whole game hours passed. */
  get now(): number {
    return Math.floor(this.#runtime.state.gameDaysPassed * 24);
  }

  /** The waits, from the load order's game settings (else the engine's defaults). */
  waits(): Promise<ResetWaits & { readonly corpses: number }> {
    this.#waits ??= (async () => {
      const setting = async (name: keyof typeof RESET_DEFAULTS): Promise<number> => {
        const value = await this.#runtime.gameSetting(name);
        return typeof value === 'number' ? value : RESET_DEFAULTS[name];
      };
      return {
        respawn: await setting('iHoursToRespawnCell'),
        cleared: await setting('iHoursToRespawnCellCleared'),
        corpses: await setting('iHoursToClearCorpses'),
      };
    })();
    return this.#waits;
  }

  /**
   * A cell leaves the loaded area: it (and its encounter zone) notes the hour. Its references'
   * resets not told yet are dropped.
   */
  async detached(cell: number): Promise<void> {
    const state = this.#runtime.state;
    const now = this.now;
    state.cellDetached.set(cell, now);
    const zone = await this.#zoneOf(cell);
    if (zone !== undefined) this.#times(zone).detached = now;
  }

  /**
   * A cell is about to come into the loaded area (`references`: its own and those of its
   * worldspace's persistent cell that stand in it): it resets if its time has come; its
   * references' state is reset now and told as they attach. Returns the references reset.
   */
  async attaching(cell: number, references: readonly number[] = []): Promise<number[]> {
    const runtime = this.#runtime;
    const state = runtime.state;
    const now = this.now;
    const waits = await this.waits();
    const zone = await this.#zoneOf(cell);
    const zoneRecord = zone === undefined ? undefined : await runtime.forms.record(zone);
    const zoneData = zoneRecord?.type === 'ECZN' ? parseEncounterZone(zoneRecord) : undefined;
    const neverResets = ((zoneData?.flags ?? 0) & EncounterZoneFlag.neverResets) !== 0;
    if (zone !== undefined && zoneData) {
      // The zone is met: it resets once its cells have been away long enough.
      const times = this.#times(zone);
      times.attached = now;
      const zoneCleared = this.#cleared(zoneData.location);
      if (!neverResets && respawnDue(now, times.detached, zoneCleared, waits)) {
        times.reset = now;
        // Levelled anew as next met (progression-engine.ts zoneLevel).
        state.zoneLevels.delete(zone);
      }
    }
    const detached = state.cellDetached.get(cell) ?? 0;
    state.cellDetached.delete(cell);
    const location = zoneData?.location ?? (await this.#ownLocation(cell));
    const cleared = this.#cleared(location);
    const decision = cellReturn({
      now,
      detached,
      cleared,
      ...(zone !== undefined && zoneData && { zone: { neverResets, times: this.#times(zone) } }),
      waits,
    });
    if (!decision.returning) return [];
    const ids = [...new Set([...runtime.forms.db.cellReferences(cell), ...references])];
    const reset: number[] = [];
    for (const reference of ids) {
      const record = await runtime.forms.record(reference);
      if (!record || record.deleted) continue;
      if (record.type === 'ACHR') {
        if (await this.#clearCorpse(record, now, waits.corpses)) continue;
      }
      if (!decision.reset || !(await this.#mayReset(record))) continue;
      // An actor's own clock: its respawn waits from its death.
      if (
        record.type === 'ACHR' &&
        state.actors.get(reference)?.dead === true &&
        !respawnDue(now, state.deathHours.get(reference) ?? 0, cleared, waits)
      )
        continue;
      this.#reset(record);
      reset.push(reference);
      this.#told.add(reference);
    }
    for (const reference of reset) {
      if ((await runtime.forms.record(reference))?.type === 'ACHR')
        await runtime.locationClearing.revived(reference);
    }
    if (decision.reset) this.#dropCreated(cell);
    return reset;
  }

  /** Of these references attaching, those reset as their cell came back (told once). */
  takeResets(references: readonly number[]): number[] {
    const told = references.filter((reference) => this.#told.has(reference));
    for (const reference of told) this.#told.delete(reference);
    return told;
  }

  /** Whether a reference may reset with its cell (the engine's check, see the file's comment). */
  async #mayReset(record: GameRecord): Promise<boolean> {
    const base = record.formIdField('NAME');
    const baseRecord = base === undefined ? undefined : await this.#runtime.forms.record(base);
    if (baseRecord?.type === 'CONT') {
      const data = baseRecord.fields.first('DATA');
      return ((data?.[0] ?? 0) & CONTAINER_RESPAWNS) !== 0;
    }
    if (baseRecord?.type === 'NPC_') return (npcFlags(baseRecord) & NpcFlag.respawn) !== 0;
    return (record.flags & RecordFlag.noRespawn) === 0;
  }

  /** A reference goes back to how its records make it (see the file's comment). */
  #reset(record: GameRecord): void {
    const state = this.#runtime.state;
    const reference = record.formId;
    const entry = state.references.get(reference);
    if (entry) {
      delete entry.openState;
      delete entry.locked;
      delete entry.lockLevel;
      delete entry.destroyed;
      delete entry.destructionStage;
      delete entry.destructionHealth;
      delete entry.harvested;
      // Enabled or disabled as the plugins made it (the engine sets it again as it resets).
      // TODO(M13): read whether the engine sets the initial state or the one it had last.
      delete entry.enabled;
      if ((record.flags & RecordFlag.persistent) === 0 && entry.container === undefined) {
        delete entry.position;
        delete entry.rotation;
        delete entry.cell;
        delete entry.world;
      }
    }
    state.inventories.delete(reference);
    state.itemStacks.delete(reference);
    state.graphs.delete(reference);
    state.leveledLevels.delete(reference);
    if (record.type === 'ACHR') {
      state.actors.delete(reference);
      state.deathHours.delete(reference);
    }
  }

  /**
   * A cell's reset removes what the game made there: created references lying in it (dropped
   * items, PlaceAtMe). TODO(M13): read from the engine which created references a reset keeps
   * besides those a quest's alias holds (persistent ones made by scripts).
   */
  #dropCreated(cell: number): void {
    const runtime = this.#runtime;
    const state = runtime.state;
    for (const reference of state.created.keys()) {
      const entry = state.references.get(reference);
      if (!entry || entry.deleted === true || entry.container !== undefined) continue;
      if (entry.cell !== cell || runtime.aliasesHolding(reference).length > 0) continue;
      entry.deleted = true;
      state.graphs.delete(reference);
    }
  }

  /** A dead actor that does not respawn is removed once its corpse is old enough. */
  async #clearCorpse(record: GameRecord, now: number, wait: number): Promise<boolean> {
    const runtime = this.#runtime;
    const reference = record.formId;
    if (runtime.state.actors.get(reference)?.dead !== true) return false;
    if ((record.flags & (RecordFlag.startsDead | RecordFlag.initiallyDisabled)) !== 0) return false;
    if (await this.#mayReset(record)) return false;
    const died = runtime.state.deathHours.get(reference) ?? 0;
    if (died === 0 || now - died <= wait) return false;
    // TODO(M13): two more checks of the engine's before it removes a corpse are not identified
    // (read: an extra data of the reference and a flag of it); a corpse a quest's alias holds
    // is kept here.
    if (runtime.aliasesHolding(reference).length > 0) return false;
    await runtime.setEnabled(reference, false);
    return true;
  }

  #times(zone: number): ZoneTimes {
    const state = this.#runtime.state;
    let times = state.zoneTimes.get(zone);
    if (!times) {
      times = { detached: 0, attached: 0, reset: 0 };
      state.zoneTimes.set(zone, times);
    }
    return times;
  }

  #cleared(location: number | undefined): boolean {
    return location !== undefined && this.#runtime.state.locations.get(location)?.cleared === true;
  }

  /** A cell's encounter zone: its own (XEZN), else outside its worldspace's. */
  async #zoneOf(cell: number): Promise<number | undefined> {
    const forms = this.#runtime.forms;
    const own = (await forms.record(cell))?.formIdField('XEZN');
    if (own !== undefined) return own;
    const world = forms.db.worldOfCell(cell);
    return world === undefined ? undefined : (await forms.record(world))?.formIdField('XEZN');
  }

  /** A cell's own location (XLCN), else outside its worldspace's. */
  async #ownLocation(cell: number): Promise<number | undefined> {
    const forms = this.#runtime.forms;
    const own = (await forms.record(cell))?.formIdField('XLCN');
    if (own !== undefined) return own;
    const world = forms.db.worldOfCell(cell);
    return world === undefined ? undefined : (await forms.record(world))?.formIdField('XLCN');
  }
}

/** NPC_ ACBS flags (u32 at 0). */
function npcFlags(record: GameRecord): number {
  const acbs = record.fields.first('ACBS');
  return acbs && acbs.length >= 4
    ? new DataView(acbs.buffer, acbs.byteOffset, acbs.byteLength).getUint32(0, true)
    : 0;
}
