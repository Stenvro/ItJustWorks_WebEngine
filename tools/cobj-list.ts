// Crafting recipes (COBJ) against the real files: the recipe count of every workbench keyword
// and every workbench (FURN with WBDT), or the recipes a workbench keyword or a workbench
// furniture offers, with their components, created objects, menu categories and conditions.
//
//   node tools/cobj-list.ts                               counts by keyword, every workbench
//   node tools/cobj-list.ts CraftingSmithingForge         recipes of a workbench keyword
//   node tools/cobj-list.ts CraftingBlacksmithForgeWR     recipes of a workbench (FURN editor id)

import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import type { Condition } from '../src/scripting/conditions.ts';
import {
  CONSTRUCTIBLE_CATEGORIES,
  constructibleCategory,
  craftingMenuOf,
  materialFilterIndices,
} from '../src/gameplay/crafting.ts';
import { DefaultObjects } from '../src/world/default-objects.ts';
import {
  craftedItemInfo,
  parseWorkbench,
  recipeIndex,
  type Recipe,
  type Workbench,
} from '../src/world/crafting-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const hex = (id: number): string => id.toString(16).padStart(8, '0');
const editorIds = new Map<number, string>();
const editorId = async (formId: number | undefined): Promise<string> => {
  if (formId === undefined || formId === 0) return 'none';
  let id = editorIds.get(formId);
  if (id === undefined) {
    id = (await db.get(formId))?.editorId ?? hex(formId);
    editorIds.set(formId, id);
  }
  return id;
};
const OPERATORS = ['==', '!=', '>', '>=', '<', '<='];

async function conditionText(condition: Condition): Promise<string> {
  const comparand =
    typeof condition.comparand === 'number'
      ? String(condition.comparand)
      : await editorId(condition.comparand.global);
  const on = condition.reference ? `${await editorId(condition.reference)}.` : '';
  const args = condition.form ? await editorId(condition.form) : '';
  return `${on}${conditionFunctionName(condition.function)}(${args}) ${OPERATORS[condition.operator] ?? '?'} ${comparand}${condition.or ? ' OR' : ''}`;
}

const index = await recipeIndex(db);
const workbenches: Workbench[] = [];
for (const formId of db.formIdsOfType('FURN')) {
  const record = await db.get(formId);
  const workbench = record && !record.deleted ? parseWorkbench(record) : undefined;
  if (workbench) workbenches.push(workbench);
}

async function listRecipes(recipes: readonly Recipe[]): Promise<void> {
  const defaults = await DefaultObjects.read(db);
  const materials = materialFilterIndices((use) => defaults.get(use));
  for (const recipe of recipes) {
    const created = recipe.created === undefined ? undefined : await db.get(recipe.created);
    const category = created
      ? (CONSTRUCTIBLE_CATEGORIES.find(
          (c) => c.index === constructibleCategory(craftedItemInfo(created), materials),
        )?.label ?? '?')
      : '?';
    const name = created?.text('FULL') ?? '';
    const components = await Promise.all(
      recipe.components.map(async (c) => `${await editorId(c.item)} x${String(c.count)}`),
    );
    console.log(
      `${recipe.editorId} [${hex(recipe.formId)}] -> ${await editorId(recipe.created)} "${name}" x${String(recipe.createdCount)} (${created?.type ?? '?'}, ${category}) | ${components.join(', ')}`,
    );
    for (const condition of recipe.conditions) console.log(`    ${await conditionText(condition)}`);
  }
  console.log(`${String(recipes.length)} recipes`);
}

const target = process.argv[2];
if (target === undefined) {
  const counts = [...index.workbenchCounts()].sort((a, b) => b[1] - a[1]);
  console.log(`${String(index.recipes.length)} recipes; by workbench keyword:`);
  for (const [keyword, count] of counts) {
    console.log(`${String(count).padStart(5)} ${await editorId(keyword)}`);
  }
  console.log(`\n${String(workbenches.length)} workbenches:`);
  for (const bench of workbenches) {
    const menu = craftingMenuOf(bench.type);
    const offered = index.forWorkbench(bench.keywords).length;
    console.log(
      `${bench.editorId} [${hex(bench.formId)}] "${bench.name}" type ${String(bench.type)} (${menu?.frame ?? '?'}) skill ${bench.skill === undefined ? 'none' : String(bench.skill)}: ${String(offered)} recipes`,
    );
  }
} else {
  const bench = workbenches.find((w) => w.editorId.toLowerCase() === target.toLowerCase());
  if (bench) {
    const keywords = await Promise.all(bench.keywords.map((k) => editorId(k)));
    console.log(
      `${bench.editorId} "${bench.name}" type ${String(bench.type)} skill ${String(bench.skill)} keywords ${keywords.join(', ')}`,
    );
    await listRecipes(index.forWorkbench(bench.keywords));
  } else {
    let keyword: number | undefined;
    for (const formId of index.workbenchCounts().keys()) {
      if ((await editorId(formId)).toLowerCase() === target.toLowerCase()) keyword = formId;
    }
    if (keyword === undefined) {
      console.error(`No workbench or workbench keyword named ${target}`);
      process.exitCode = 1;
    } else {
      await listRecipes(index.byWorkbenchKeyword(keyword));
    }
  }
}
await db.close();
await vfs.close();
