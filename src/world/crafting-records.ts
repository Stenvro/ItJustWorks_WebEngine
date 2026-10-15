// Crafting data: recipes (COBJ, "constructible objects": the components, the conditions, the
// created object and count, the workbench keyword), workbenches (FURN WBDT: the bench type and
// skill, with the furniture's keywords) and what the crafting menu needs to know about a created
// item (its keywords, whether it is food). An index of every recipe by workbench keyword and by
// created object, built once per record database.
// Layouts: UESP "Skyrim Mod:Mod File Format" (COBJ, FURN, ALCH), xEdit, CommonLibSSE-NG
// (BGSConstructibleObject). Notes: docs/formats/esm.md ("Crafting"). Platform-independent.

import { view } from '../formats/esm/fields.ts';
import { RecordFlag } from '../formats/esm/record.ts';
import { conditionAt, type Condition } from '../scripting/conditions.ts';
import type { GameRecord, RecordDatabase } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'type' | 'editorId' | 'fields' | 'formIdAt'> &
  Partial<Pick<GameRecord, 'text'>>;

/** FURN WBDT byte 0: what a workbench opens (UESP FURN; 0: not a workbench). */
export const WorkbenchType = {
  none: 0,
  /** Forges, smelters, tanning racks, cooking pots, ovens, HearthFire tables, ... */
  createObject: 1,
  /** Grindstones: improving weapons. */
  smithingWeapon: 2,
  enchanting: 3,
  /** Unused in vanilla. */
  enchantingExperiment: 4,
  alchemy: 5,
  /** Unused in vanilla. */
  alchemyExperiment: 6,
  /** Armor workbenches: improving armor. */
  smithingArmor: 7,
} as const;

/** WBDT byte 1 when the workbench uses no skill (-1 as a signed byte). */
const NO_SKILL = 0xff;

export interface Workbench {
  readonly formId: number;
  readonly editorId: string;
  /** Display name (FULL); empty if none. */
  readonly name: string;
  /** WorkbenchType. */
  readonly type: number;
  /** The actor value of the skill it trains (10 Smithing, 16 Alchemy, 23 Enchanting), if any. */
  readonly skill: number | undefined;
  /** Its keywords (KWDA): recipes whose workbench keyword is one of them are made here. */
  readonly keywords: readonly number[];
}

export interface RecipeComponent {
  /** The item used up (a global form id). */
  readonly item: number;
  readonly count: number;
}

export interface Recipe {
  readonly formId: number;
  readonly editorId: string;
  /** CNAM: the object made, or the item improved by a tempering recipe; undefined if none. */
  readonly created: number | undefined;
  /** NAM1: how many are made (1 when the record has no NAM1). */
  readonly createdCount: number;
  /** BNAM: the keyword a workbench must have to make it; undefined if none. */
  readonly workbench: number | undefined;
  /** CNTO, in record order. */
  readonly components: readonly RecipeComponent[];
  /** CTDA: when it is listed (run on the player; OR binds tighter than AND). */
  readonly conditions: readonly Condition[];
}

/** A form's keywords (KWDA, u32 form ids), as global form ids. */
export function recordKeywords(record: Pick<GameRecord, 'fields' | 'formIdAt'>): number[] {
  const data = record.fields.first('KWDA');
  const keywords: number[] = [];
  for (let at = 0; data && at + 4 <= data.length; at += 4) {
    const formId = record.formIdAt(data, at);
    if (formId !== 0) keywords.push(formId);
  }
  return keywords;
}

/** A furniture's workbench data (WBDT), or undefined if it is not a workbench. */
export function parseWorkbench(record: RecordSource): Workbench | undefined {
  const wbdt = record.fields.first('WBDT');
  const type = wbdt?.[0] ?? WorkbenchType.none;
  if (!wbdt || type === WorkbenchType.none) return undefined;
  const skill = wbdt[1] ?? NO_SKILL;
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    name: record.text?.('FULL') ?? '',
    type,
    skill: skill === NO_SKILL ? undefined : skill,
    keywords: recordKeywords(record),
  };
}

export function parseRecipe(record: RecordSource): Recipe {
  const fields = record.fields.list;
  const components: RecipeComponent[] = [];
  const conditions: Condition[] = [];
  let created: number | undefined;
  let createdCount = 1;
  let workbench: number | undefined;
  for (let i = 0; i < fields.length; i++) {
    const { type, data } = fields[i] ?? { type: '', data: new Uint8Array() };
    if (type === 'CNTO' && data.length >= 8) {
      // u32 item, i32 count; an optional COED (owner, rank / global, condition) may follow.
      components.push({ item: record.formIdAt(data), count: view(data).getInt32(4, true) });
    } else if (type === 'CTDA') {
      const condition = conditionAt(fields, i, record);
      if (condition) conditions.push(condition);
    } else if (type === 'CNAM' && data.length >= 4) {
      const formId = record.formIdAt(data);
      created = formId === 0 ? undefined : formId;
    } else if (type === 'BNAM' && data.length >= 4) {
      const formId = record.formIdAt(data);
      workbench = formId === 0 ? undefined : formId;
    } else if (type === 'NAM1' && data.length >= 2) {
      createdCount = view(data).getUint16(0, true);
    }
  }
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    created,
    createdCount,
    workbench,
    components,
    conditions,
  };
}

/** ALCH ENIT flags (UESP). */
export const PotionFlag = {
  noAutoCalc: 0x1,
  food: 0x2,
  medicine: 0x10000,
  poison: 0x20000,
} as const;

/** What the constructible menu reads from a created object to pick its category. */
export interface CraftedItemInfo {
  readonly type: string;
  readonly keywords: readonly number[];
  /** An ALCH flagged as food (ENIT flags 0x2): cooking pot and oven recipes. */
  readonly food: boolean;
}

export function craftedItemInfo(
  record: Pick<GameRecord, 'type' | 'fields' | 'formIdAt'>,
): CraftedItemInfo {
  let food = false;
  if (record.type === 'ALCH') {
    const enit = record.fields.first('ENIT');
    // ENIT: i32 value, u32 flags, addiction, addiction chance, consume sound.
    food =
      enit !== undefined &&
      enit.length >= 8 &&
      (view(enit).getUint32(4, true) & PotionFlag.food) !== 0;
  }
  return { type: record.type, keywords: recordKeywords(record), food };
}

/** Every recipe of the load order (winning, not deleted versions), by workbench and by result. */
export class RecipeIndex {
  /** In load order (the order the menu lists them in). */
  readonly recipes: readonly Recipe[];
  readonly #byFormId = new Map<number, Recipe>();
  readonly #byWorkbench = new Map<number, Recipe[]>();
  readonly #byCreated = new Map<number, Recipe[]>();

  constructor(recipes: readonly Recipe[]) {
    this.recipes = recipes;
    for (const recipe of recipes) {
      this.#byFormId.set(recipe.formId, recipe);
      if (recipe.workbench !== undefined) push(this.#byWorkbench, recipe.workbench, recipe);
      if (recipe.created !== undefined) push(this.#byCreated, recipe.created, recipe);
    }
  }

  get(formId: number): Recipe | undefined {
    return this.#byFormId.get(formId);
  }

  /** Recipes whose workbench keyword (BNAM) is `keyword`. */
  byWorkbenchKeyword(keyword: number): readonly Recipe[] {
    return this.#byWorkbench.get(keyword) ?? [];
  }

  /** Recipes whose created object (CNAM) is `item`. */
  byCreated(item: number): readonly Recipe[] {
    return this.#byCreated.get(item) ?? [];
  }

  /**
   * The recipes a workbench with these keywords offers (BNAM is one of them), in load order;
   * conditions not yet checked.
   */
  forWorkbench(keywords: readonly number[]): Recipe[] {
    const wanted = new Set(keywords);
    return this.recipes.filter(
      (recipe) => recipe.workbench !== undefined && wanted.has(recipe.workbench),
    );
  }

  /** Workbench keywords with their recipe counts. */
  workbenchCounts(): Map<number, number> {
    return new Map([...this.#byWorkbench].map(([keyword, list]) => [keyword, list.length]));
  }

  /** Reads every COBJ in one pass over the plugins. */
  static async read(db: RecordDatabase): Promise<RecipeIndex> {
    const recipes: Recipe[] = [];
    await db.scan(
      ['COBJ'],
      (flags) => (flags & (RecordFlag.deleted | RecordFlag.ignored)) === 0,
      (record) => {
        recipes.push(parseRecipe(record));
      },
    );
    return new RecipeIndex(recipes);
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

const indexes = new WeakMap<RecordDatabase, Promise<RecipeIndex>>();

/** The recipe index of a record database, read on first use and kept with the database. */
export function recipeIndex(db: RecordDatabase): Promise<RecipeIndex> {
  let pending = indexes.get(db);
  if (!pending) {
    pending = RecipeIndex.read(db);
    indexes.set(db, pending);
  }
  return pending;
}
