// A whole save (docs/formats/save.md): the scripts' side (runtime-save.ts), where the player
// stands, the sky's weather; the header the save list shows. Made from a running game and
// put back into a fresh one; the world itself is rebuilt from the plugins by whoever loads it
// (the shell or the headless simulation), which then applies the player's place and the
// weather. Free of browser APIs but for compression (save-codec.ts).

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Placement, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { RuntimeSave } from '../scripting/runtime/runtime-save.ts';
import { readSave, SAVE_VERSION, writeSave, type SaveHeader } from './save-codec.ts';
import type { SavedHazard } from '../scripting/runtime/hazard-engine.ts';
import type { WorldSave } from './world-save.ts';

/** The save file's body. */
export interface GameSave {
  readonly runtime: RuntimeSave;
  /** Where the player stands (cell or worldspace), and facing. */
  readonly player: Placement;
  /** The sky's weather then (none outside). */
  readonly weather: number | undefined;
  /** What could not be saved (threads in flight, ...): logged again as it loads. */
  readonly unsaved: readonly string[];
  /**
   * The loaded world beside the scripts (src/save/world-save.ts): actors' places, furniture,
   * packages and fights, moved objects' graphs. None in saves made before it, or without a view.
   */
  readonly world?: WorldSave | undefined;
  /** The hazards standing (their lifetimes and hits); none in saves made before they were kept. */
  readonly hazards?: readonly SavedHazard[] | undefined;
  /**
   * Item counts to add to containers after their record's inventory is filled (an imported
   * .ess keeps inventories as changes against the records: ess-import.ts).
   */
  readonly inventoryDeltas?: readonly (readonly [number, readonly (readonly [number, number])[]])[];
}

export interface SaveRequest {
  readonly name: string;
  readonly kind: SaveHeader['kind'];
  readonly number: number;
  readonly thumbnail?: Uint8Array;
  /** Real time now (ms since 1970). */
  readonly now: number;
}

/** The save's location text: the player's location, else their cell's or world's name. */
async function locationName(runtime: ScriptRuntime, player: Placement): Promise<string> {
  for (const formId of [runtime.state.playerLocation, player.cell, player.world]) {
    if (formId === undefined) continue;
    const name = (await runtime.forms.record(formId))?.text('FULL');
    if (name) return name;
  }
  return '';
}

/** Saves the running game: its bytes, and what could not be saved (also in the file). */
export async function saveGame(
  runtime: ScriptRuntime,
  request: SaveRequest,
): Promise<{ bytes: Uint8Array; unsaved: string[] }> {
  const player = await runtime.placement(PLAYER_REF);
  if (!player) throw new Error('the player is nowhere');
  const unsaved: string[] = [];
  const data = await runtime.saveData((what) => unsaved.push(what));
  const body: GameSave = {
    runtime: data,
    player,
    weather: runtime.world.currentWeather?.(),
    unsaved,
    world: runtime.world.saveWorld?.(),
    hazards: runtime.hazards.save(),
  };
  const header: SaveHeader = {
    version: SAVE_VERSION,
    name: request.name,
    kind: request.kind,
    number: request.number,
    playerName: runtime.state.playerName ?? 'Prisoner',
    playerLevel: runtime.state.actors.get(PLAYER_REF)?.level ?? 1,
    location: await locationName(runtime, player),
    gameDays: runtime.state.gameDaysPassed,
    realTime: request.now,
    plugins: runtime.forms.db.plugins.map((plugin) => plugin.entry.name),
  };
  const bytes = await writeSave({
    header,
    thumbnail: request.thumbnail ?? new Uint8Array(),
    body,
  });
  return { bytes, unsaved };
}

/** A save file read back: its header and body. */
export async function readGameSave(
  bytes: Uint8Array,
): Promise<{ header: SaveHeader; save: GameSave }> {
  const file = await readSave(bytes);
  return { header: file.header, save: file.body as GameSave };
}

/**
 * The save's scripts put into a fresh runtime (instead of its new game). Returns what could
 * not be put back and what was never saved, for the log.
 */
export async function loadGameScripts(
  runtime: ScriptRuntime,
  save: GameSave,
  header: SaveHeader,
  progress?: (what: string) => void,
): Promise<string[]> {
  const problems: string[] = [];
  const loaded = new Set(runtime.forms.db.plugins.map((plugin) => plugin.entry.name.toLowerCase()));
  for (const plugin of header.plugins) {
    if (!loaded.has(plugin.toLowerCase())) problems.push(`the save's plugin ${plugin} is missing`);
  }
  problems.push(...(await runtime.loadGame(save.runtime, progress)));
  // What scripts set on actors that the world holds apart from the game state (head tracking:
  // src/ai/head-tracking.ts) is told to it again, as the original's actors keep it in their
  // saved process; alpha and the stealth eye's flag the world reads from the state itself.
  for (const [actor, state] of runtime.state.actors) {
    if (state.headTrackingOff === true) runtime.world.headTracking?.(actor, false);
    if (state.lookAt !== undefined) runtime.world.lookAt?.(actor, state.lookAt, 'script');
  }
  await runtime.hazards.restore(save.hazards ?? []);
  for (const [container, items] of save.inventoryDeltas ?? []) {
    const inventory = await runtime.inventory(container);
    for (const [item, delta] of items) {
      const count = (inventory.get(item) ?? 0) + delta;
      if (count > 0) inventory.set(item, count);
      else inventory.delete(item);
    }
  }
  for (const what of save.unsaved) problems.push(`not saved: ${what}`);
  return problems;
}
