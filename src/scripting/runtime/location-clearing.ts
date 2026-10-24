// Clearing locations (docs/scripting.md, "Cell reset and cleared locations"). Observed in the
// original: a location is cleared once every one of its bosses is dead. Its bosses are its
// special references of the location reference type the default object "LocRefType - Boss"
// (LRTB) names (LCTN LCSR/ACSR), less those disabled; a boss that died longer ago than the
// respawn wait (iHoursToRespawnCell, iHoursToRespawnCellCleared once cleared: cell-reset.ts)
// counts as alive again. A location without bosses keeps the state it has (scripts set it:
// Location.SetCleared).
//
// When the engine counts: as an actor dies where the player is (the actor's current location
// is the player's), the location it belongs to (its editor cell's) is counted at once, unless
// it is cleared already; as it comes back (a respawn), counted again; and whenever a quest's
// alias asks whether a location is cleared, at most once a game hour. A location that becomes
// cleared is cleared for good on the maps (their "Cleared": sCleared); one the default object
// "Keyword - ClearableLocation" (KWDO) marks also plays the default object "Music - Dungeon
// Cleared" (DCMS) and tells the hub (LocationCleared: the misc stat Dungeons Cleared counts
// it). Platform-independent.

import { DefaultObjectUse } from '../../world/default-objects.ts';
import { respawnDue } from './cell-reset.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

export class LocationClearing {
  readonly #runtime: ScriptRuntime;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
    runtime.events.on('death', async (event) => {
      if (event.dead && event.actor !== PLAYER_REF) await this.died(event.actor);
    });
  }

  /** The whole game hours passed (the engine's clock for resets and clearing). */
  get #now(): number {
    return Math.floor(this.#runtime.state.gameDaysPassed * 24);
  }

  /** An actor died: the location it belongs to is counted if the player is where it died. */
  async died(actor: number): Promise<void> {
    const runtime = this.#runtime;
    const location = await this.#homeLocation(actor);
    if (location === undefined || runtime.state.locations.get(location)?.cleared === true) return;
    const here = await runtime.locationOf(actor);
    if (here === undefined || here !== runtime.state.playerLocation) return;
    await this.count(location, this.#now, true);
  }

  /** An actor came back (respawned): the location it belongs to is counted again. */
  async revived(actor: number): Promise<void> {
    const location = await this.#homeLocation(actor);
    if (location === undefined) return;
    if (this.#runtime.state.locations.get(location)?.cleared !== true) return;
    await this.count(location, this.#now, true);
  }

  /** Whether a location is cleared now, its bosses counted if an hour has passed (aliases ask). */
  async isCleared(location: number): Promise<boolean> {
    return this.count(location, this.#now, false);
  }

  /**
   * Counts a location's bosses (`now`, whole game hours; `forced`: even if counted this hour)
   * and sets its cleared state; returns it.
   */
  async count(location: number, now: number, forced: boolean): Promise<boolean> {
    const runtime = this.#runtime;
    const state = runtime.state.location(location);
    if (!forced && state.checkedAt === now) return state.cleared === true;
    const before = state.cleared === true;
    state.checkedAt = now;
    const bossType = await runtime.magic.defaultObject(DefaultObjectUse.bossReferenceType);
    const record = bossType === undefined ? undefined : await runtime.location(location);
    let bosses = 0;
    let dead = 0;
    for (const { type, reference } of record?.references ?? []) {
      if (type !== bossType || !(await runtime.isEnabled(reference))) continue;
      bosses++;
      if (runtime.state.actors.get(reference)?.dead !== true) continue;
      const died = runtime.state.deathHours.get(reference) ?? 0;
      // Dead so long ago that it has respawned (by the engine's rule) counts as alive.
      if (now !== 0 && died !== 0 && respawnDue(now, died, before, await this.#waits())) continue;
      dead++;
    }
    if (bosses > 0) state.cleared = dead >= bosses;
    if (!before && state.cleared === true) await this.#cleared(location);
    return state.cleared === true;
  }

  /** A location became cleared: the maps show it so, a clearable one is told and played. */
  async #cleared(location: number): Promise<void> {
    const runtime = this.#runtime;
    const keyword = await runtime.magic.defaultObject(DefaultObjectUse.clearableLocation);
    if (keyword !== undefined && (await runtime.location(location))?.keywords.includes(keyword)) {
      const music = await runtime.magic.defaultObject(DefaultObjectUse.dungeonClearedMusic);
      if (music !== undefined) runtime.world.music?.(music, true);
      runtime.events.emit('locationCleared', { location });
    }
    runtime.state.location(location).everCleared = true;
  }

  /**
   * Whether the maps show a location "Cleared" (sCleared): one that has been cleared and that
   * the player can clear (KWDO). TODO(M13): whether Location.SetCleared marks it cleared once
   * as the engine's own clearing does is not read (here a location cleared now counts too).
   */
  async shownCleared(location: number): Promise<boolean> {
    const runtime = this.#runtime;
    const state = runtime.state.locations.get(location);
    if (state?.everCleared !== true && state?.cleared !== true) return false;
    const keyword = await runtime.magic.defaultObject(DefaultObjectUse.clearableLocation);
    return (
      keyword !== undefined &&
      (await runtime.location(location))?.keywords.includes(keyword) === true
    );
  }

  /** The location an actor belongs to: its editor cell's (the engine's editor location). */
  async #homeLocation(actor: number): Promise<number | undefined> {
    const runtime = this.#runtime;
    return runtime.locationAt(await runtime.editorPlace(actor));
  }

  async #waits(): Promise<{ readonly respawn: number; readonly cleared: number }> {
    return this.#runtime.cellResets.waits();
  }
}
