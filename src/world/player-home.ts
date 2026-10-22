// What the player can do to a home, played with the game's own scripts:
// - purchases: dialogue with a steward (or Nazir, ...) whose script furnishes a room;
// - HearthFire houses: drafting the house and its wings and building every part at the
//   drafting table and workbenches, then crafting the furniture of each finished room.
// This module finds those actions for a cell and plays a chosen set of them from the state
// of a new game in the Papyrus VM; the result is which references the scripts enabled or
// disabled. In a running game the same scripts run in the script runtime when the player
// does these things: buying in conversation (the dialogue menu runs the steward's info fragments) and
// crafting at the drafting table and workbenches (the crafting menu).

import { evaluateConditions, parseConditions, type Condition } from '../scripting/conditions.ts';
import { PapyrusVm } from '../scripting/papyrus-vm.ts';
import { ScriptLibrary } from '../scripting/script-library.ts';
import { ObjectHandle, PapyrusArray } from '../scripting/values.ts';
import { FormCache, GameHost, PLAYER_REF, WorldState } from '../scripting/world-host.ts';
import type { Vfs } from '../vfs/vfs.ts';
import type { CellData } from './cell-loader.ts';
import { GroupType } from '../formats/esm/record.ts';
import type { RecordDatabase } from './record-db.ts';
import { scriptReferences, ScriptUse, type ScriptReferenceIndex } from './script-references.ts';

/** Everything needed to run scripts against one record database. */
export class ScriptEnvironment {
  readonly db: RecordDatabase;
  readonly cache: FormCache;
  readonly library: ScriptLibrary;
  readonly references: ScriptReferenceIndex;

  private constructor(db: RecordDatabase, vfs: Vfs, references: ScriptReferenceIndex) {
    this.db = db;
    this.cache = new FormCache(db);
    this.references = references;
    this.library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
  }

  static async create(db: RecordDatabase, vfs: Vfs): Promise<ScriptEnvironment> {
    const { index } = await scriptReferences(db);
    return new ScriptEnvironment(db, vfs, index);
  }

  /** A fresh VM on the state of a new game. */
  session(warnings: Set<string>): { vm: PapyrusVm; host: GameHost; state: WorldState } {
    const state = new WorldState();
    const host = new GameHost(this.cache, state, (message) => warnings.add(message));
    return { vm: new PapyrusVm(this.library, host), host, state };
  }
}

export interface HomePurchase {
  /** The dialogue response (INFO) whose script makes the purchase. */
  readonly info: number;
  /** The player's line, e.g. "Kitchen furnishings. (500 gold)". */
  readonly label: string;
}

export interface HouseWing {
  /** E.g. "West Wing". */
  readonly name: string;
  /** E.g. ["Bedrooms", "Greenhouse", "Enchanter's Tower"]. */
  readonly rooms: readonly string[];
}

export interface HearthfireHouse {
  /** The house's quest (BYOHHouseScript). */
  readonly quest: number;
  readonly wings: readonly HouseWing[];
}

export interface HomeActions {
  readonly purchases: readonly HomePurchase[];
  readonly house: HearthfireHouse | undefined;
  /** Markers the actions switch (not shown as separate quest states). */
  readonly controlled: ReadonlySet<number>;
}

export type HouseStage = 'plot' | 'small house' | 'full';

export interface HomeChoices {
  readonly purchases: ReadonlySet<number>;
  readonly stage: HouseStage;
  /** Chosen room per wing name; missing or undefined: the wing is not built. */
  readonly wings: ReadonlyMap<string, string | undefined>;
  readonly furnished: boolean;
}

export interface HomeResult {
  /** Own enable state of the references the scripts switched. */
  readonly enabled: ReadonlyMap<number, boolean>;
  readonly warnings: readonly string[];
}

export const NEW_GAME: HomeChoices = {
  purchases: new Set(),
  stage: 'plot',
  wings: new Map(),
  furnished: false,
};

/** Everything bought and built (each wing as chosen, or its first room). */
export function fullyUpgraded(actions: HomeActions, current: HomeChoices): HomeChoices {
  return {
    purchases: new Set(actions.purchases.map((p) => p.info)),
    stage: actions.house ? 'full' : 'plot',
    wings: new Map(
      (actions.house?.wings ?? []).map((wing) => [
        wing.name,
        current.wings.get(wing.name) ?? wing.rooms[0],
      ]),
    ),
    furnished: actions.house !== undefined,
  };
}

const player = (): ObjectHandle => new ObjectHandle(PLAYER_REF, 'actor');

// --- Purchases ----------------------------------------------------------------------------

async function owningQuest(env: ScriptEnvironment, info: number): Promise<number | undefined> {
  const location = env.db.locate(info);
  const group = location && env.db.parentGroup(location);
  if (group?.type !== GroupType.topicChildren) return undefined;
  return (await env.cache.record(group.label))?.formIdField('QNAM');
}

/** Runs a dialogue response's script fragments (begin, then end). */
async function runResponse(env: ScriptEnvironment, vm: PapyrusVm, info: number): Promise<void> {
  const attachments = await env.cache.attachments(info);
  const fragments = [...(attachments?.fragments ?? [])].sort((a) => (a.stage === 'begin' ? -1 : 1));
  for (const fragment of fragments) {
    await vm.call(new ObjectHandle(info, fragment.script), fragment.function, [null]);
  }
}

/** The player's line for a response: its topic text with <Global=X> filled in. */
async function purchaseLabel(env: ScriptEnvironment, info: number): Promise<string> {
  const record = await env.cache.record(info);
  const location = env.db.locate(info);
  const group = location && env.db.parentGroup(location);
  const topic =
    group?.type === GroupType.topicChildren ? await env.cache.record(group.label) : undefined;
  let text =
    [record?.text('RNAM'), topic?.text('FULL'), record?.editorId].find(
      (t) => t !== undefined && t !== '',
    ) ?? '';
  const globals = new Map<string, number>();
  const attachments = await env.cache.attachments(info);
  for (const script of attachments?.scripts ?? []) {
    for (const property of script.properties) {
      if (property.value.type !== 'object' || !record) continue;
      const form = await env.cache.record(
        env.db.toGlobal(record.plugin, property.value.value.formId),
      );
      if (form?.type === 'GLOB' && form.editorId) {
        globals.set(form.editorId.toLowerCase(), form.fields.f32('FLTV') ?? 0);
      }
    }
  }
  text = text.replace(/<Global=([^>]+)>/g, (tag, name: string) => {
    const value = globals.get(name.toLowerCase());
    return value === undefined ? tag : String(Math.round(value));
  });
  return text.trim();
}

async function findPurchases(env: ScriptEnvironment, data: CellData): Promise<HomePurchase[]> {
  const markers = [...data.references].filter(([, state]) => !state.parent).map(([id]) => id);
  // Responses whose scripts name one of the cell's markers, and the purchases (responses
  // that take gold) of the same quests: some reach the markers through a quest script.
  const candidates = new Set<number>();
  for (const marker of markers) {
    for (const reference of env.references.references(marker)) {
      if ((reference.use & ScriptUse.dialogue) !== 0) candidates.add(reference.record);
    }
  }
  const quests = new Set<number>();
  for (const info of candidates) {
    const quest = await owningQuest(env, info);
    if (quest !== undefined) quests.add(quest);
  }
  for (const info of env.references.recordsWith(ScriptUse.purchase)) {
    const quest = await owningQuest(env, info);
    if (quest !== undefined && quests.has(quest)) candidates.add(info);
  }
  // Keep those that change something in this cell when played on a new game.
  const purchases: HomePurchase[] = [];
  for (const info of [...candidates].sort((a, b) => a - b)) {
    const { vm, state } = env.session(new Set());
    try {
      await runResponse(env, vm, info);
    } catch {
      continue;
    }
    if (![...state.enabled.keys()].some((ref) => data.references.has(ref))) continue;
    purchases.push({ info, label: await purchaseLabel(env, info) });
  }
  return purchases;
}

// --- HearthFire ---------------------------------------------------------------------------

interface HouseScripts {
  readonly house: ObjectHandle;
  readonly building: ObjectHandle;
  readonly houseIndex: number;
}

async function houseScripts(vm: PapyrusVm, quest: number): Promise<HouseScripts | undefined> {
  const house = new ObjectHandle(quest, 'byohhousescript');
  const building = await vm.getProperty(house, 'BYOHHouseBuilding');
  const index = await vm.getProperty(house, 'iHouseIndex');
  if (!(building instanceof ObjectHandle) || typeof index !== 'number') return undefined;
  return { house, building, houseIndex: index };
}

/** The house quest whose building script lists the most of this cell's markers. */
function findHouseQuest(env: ScriptEnvironment, data: CellData): number | undefined {
  const counts = new Map<number, number>();
  for (const [id, state] of data.references) {
    if (state.parent) continue;
    for (const reference of env.references.references(id)) {
      if (reference.script.toLowerCase() !== 'byohhousescript') continue;
      counts.set(reference.record, (counts.get(reference.record) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0];
}

interface BuildPart {
  readonly item: number;
  readonly script: string;
  readonly conditions: readonly Condition[];
  /** Drafting a wing: its "Addition - <wing> - <room>" name. */
  readonly addition: { readonly wing: string; readonly room: string } | undefined;
  readonly order: number;
}

const BUILD_SCRIPTS = new Set([
  'byohbuildingobjectscript',
  'byohbuildingremodelentryscript',
  'byohbuildingobjectexteriorscript',
]);

/** Every recipe that builds part of a house (not furniture), in the building list's order. */
async function buildParts(
  env: ScriptEnvironment,
  vm: PapyrusVm,
  scripts: HouseScripts,
): Promise<BuildPart[]> {
  const masterList = await vm.getProperty(scripts.building, 'BuildingMasterList');
  const order =
    masterList instanceof ObjectHandle ? await env.cache.formList(masterList.formId) : [];
  const enableList = await vm.getProperty(scripts.house, 'EnableList');
  const parts: BuildPart[] = [];
  for (const recipeId of env.db.formIdsOfType('COBJ')) {
    const recipe = await env.cache.record(recipeId);
    const item = recipe?.formIdField('CNAM');
    if (!recipe || item === undefined) continue;
    const script = (await env.cache.attachments(item))?.scripts[0]?.name.toLowerCase();
    if (!script || !BUILD_SCRIPTS.has(script)) continue;
    const index = order.indexOf(item);
    // Parts that only remove something (e.g. "Remove Workbench") enable nothing.
    if (
      index >= 0 &&
      enableList instanceof PapyrusArray &&
      (enableList.items[index] ?? null) === null
    ) {
      continue;
    }
    const handle = new ObjectHandle(item, script);
    const layout = (await vm.getProperty(handle, 'bDisableAdditionLayouts')) === true;
    const name = (await env.cache.record(item))?.text('FULL') ?? '';
    const [, wing, room] = name.split(' - ');
    parts.push({
      item,
      script,
      conditions: parseConditions(recipe),
      addition: layout && wing && room ? { wing, room } : undefined,
      order: index < 0 ? order.length : index,
    });
  }
  return parts.sort((a, b) => a.order - b.order);
}

async function findHouse(
  env: ScriptEnvironment,
  data: CellData,
): Promise<HearthfireHouse | undefined> {
  const quest = findHouseQuest(env, data);
  if (quest === undefined) return undefined;
  const { vm } = env.session(new Set());
  const scripts = await houseScripts(vm, quest);
  if (!scripts) return undefined;
  const wings = new Map<string, string[]>();
  for (const part of await buildParts(env, vm, scripts)) {
    if (!part.addition) continue;
    const rooms = wings.get(part.addition.wing) ?? [];
    if (!rooms.includes(part.addition.room)) rooms.push(part.addition.room);
    wings.set(part.addition.wing, rooms);
  }
  return { quest, wings: [...wings].map(([name, rooms]) => ({ name, rooms })) };
}

/** Crafts an item: it goes to the player, whose inventory change runs its script. */
async function craft(vm: PapyrusVm, host: GameHost, item: number, script: string): Promise<void> {
  const inventory = host.state.inventory(PLAYER_REF);
  inventory.set(item, (inventory.get(item) ?? 0) + 1);
  await vm.call(new ObjectHandle(item, script), 'OnContainerChanged', [player(), null]);
}

/** Crafts the furniture of every finished room that is not furnished yet. */
async function furnish(
  env: ScriptEnvironment,
  vm: PapyrusVm,
  host: GameHost,
  scripts: HouseScripts,
  crafted: Set<string>,
): Promise<void> {
  const roomLists = await vm.getProperty(scripts.building, 'RoomMasterLists');
  const doneFlags = await vm.getProperty(scripts.house, 'RoomDoneFlags');
  if (!(roomLists instanceof PapyrusArray) || !(doneFlags instanceof ObjectHandle)) return;
  const flags = await env.cache.formList(doneFlags.formId);
  const remodeled = (await vm.getProperty(scripts.house, 'bRoom1Remodeled')) === true;
  // List 0 is the small house (room 1, variant A), list 1 the entryway it is remodeled into
  // (room 1, variant B), list n ≥ 2 room n; RoomDoneFlags uses the same indices.
  for (let list = 0; list < roomLists.items.length; list++) {
    if ((list === 0 && remodeled) || (list === 1 && !remodeled)) continue;
    const flag = flags[list];
    const items = roomLists.items[list];
    if (flag === undefined || !(items instanceof ObjectHandle)) continue;
    const done = await vm.call(new ObjectHandle(flag, 'globalvariable'), 'GetValue');
    if (typeof done !== 'number' || done < 1) continue;
    await vm.setProperty(scripts.building, 'activeRoomID', list < 2 ? 1 : list);
    await vm.setProperty(scripts.building, 'activeVariantID', list === 0 ? 'A' : 'B');
    for (const item of await env.cache.formList(items.formId)) {
      const key = `${String(list)}:${String(item)}`;
      if (crafted.has(key)) continue;
      crafted.add(key);
      const script = (await env.cache.attachments(item))?.scripts[0]?.name;
      if (script) await craft(vm, host, item, script);
    }
  }
  // Trophies are the player's choice at each trophy base, crafted there in the running game (the
  // crafting menu at the base: BYOHHouseTrophyBaseScript's OnActivate names the base,
  // BYOHBuildingObjectTrophyScript's BuildTrophy places the trophy with PlaceAtMe). This preview
  // shows the house's own references only. TODO(M13): trophies chosen in the sandbox's preview
  // (references the scripts place: WorldState has none).
}

/**
 * Builds a house the way a player does: buy the plot, then repeatedly craft the first part
 * whose recipe conditions hold (finishing what is started before drafting another wing),
 * furnishing each room once it is finished.
 */
async function buildHouse(
  env: ScriptEnvironment,
  vm: PapyrusVm,
  host: GameHost,
  house: HearthfireHouse,
  choices: HomeChoices,
): Promise<void> {
  if (choices.stage === 'plot') return;
  const scripts = await houseScripts(vm, house.quest);
  if (!scripts) return;
  await vm.call(scripts.house, 'BuyProperty');
  // The player stands at the drafting table of this house.
  await vm.setProperty(scripts.building, 'activeHouseLocation', scripts.houseIndex);
  const trigger = await vm.getProperty(scripts.house, 'HouseCraftingTrigger');
  if (trigger instanceof ObjectHandle) await vm.setProperty(trigger, 'bPlayerInTrigger', true);

  const parts = (await buildParts(env, vm, scripts)).filter(
    (part) => !part.addition || choices.wings.get(part.addition.wing) === part.addition.room,
  );
  const built = new Set<number>();
  const furnished = new Set<string>();
  for (let step = 0; step <= parts.length; step++) {
    if (choices.furnished) await furnish(env, vm, host, scripts, furnished);
    if (choices.stage === 'small house') {
      const rooms = await vm.getProperty(scripts.house, 'numRoomsCompleted');
      if (typeof rooms === 'number' && rooms >= 1) break;
    }
    let next: BuildPart | undefined;
    for (const drafting of [false, true]) {
      for (const part of parts) {
        if (built.has(part.item) || (part.addition !== undefined) !== drafting) continue;
        if (await evaluateConditions(part.conditions, vm, host, PLAYER_REF)) {
          next = part;
          break;
        }
      }
      if (next) break;
    }
    if (!next) break;
    built.add(next.item);
    await craft(vm, host, next.item, next.script);
  }
}

// --- Public API ---------------------------------------------------------------------------

/** What the player can buy and build in a cell. */
export async function findHomeActions(
  env: ScriptEnvironment,
  data: CellData,
): Promise<HomeActions> {
  const [purchases, house] = await Promise.all([findPurchases(env, data), findHouse(env, data)]);
  const actions: HomeActions = { purchases, house, controlled: new Set() };
  if (purchases.length === 0 && !house) return actions;
  // Markers the actions switch, seen by playing everything.
  const all = await playHomeActions(env, actions, fullyUpgraded(actions, NEW_GAME));
  const controlled = new Set([...all.enabled.keys()].filter((ref) => data.references.has(ref)));
  if (house) {
    for (const [id, state] of data.references) {
      if (state.parent) continue;
      if (env.references.references(id).some((r) => r.record === house.quest)) controlled.add(id);
    }
  }
  return { ...actions, controlled };
}

/** Plays the chosen actions on a new game; returns what the scripts enabled and disabled. */
export async function playHomeActions(
  env: ScriptEnvironment,
  actions: HomeActions,
  choices: HomeChoices,
): Promise<HomeResult> {
  const warnings = new Set<string>();
  const { vm, host, state } = env.session(warnings);
  try {
    if (actions.house) await buildHouse(env, vm, host, actions.house, choices);
    for (const purchase of actions.purchases) {
      if (choices.purchases.has(purchase.info)) await runResponse(env, vm, purchase.info);
    }
  } catch (error) {
    warnings.add(`script error: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { enabled: state.enabled, warnings: [...warnings] };
}
