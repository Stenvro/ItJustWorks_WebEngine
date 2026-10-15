// Integration test: the crafting records (COBJ recipes, FURN workbenches) and the crafting
// menu's categories on the local game data. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  constructibleCategory,
  ConstructibleFilter,
  craftingMenuOf,
  materialFilterIndices,
  temperingCandidates,
} from '../src/gameplay/crafting.ts';
import {
  craftedItemInfo,
  parseWorkbench,
  recipeIndex,
  WorkbenchType,
  type RecipeIndex,
  type Workbench,
} from '../src/world/crafting-records.ts';
import { DefaultObjects } from '../src/world/default-objects.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('crafting records in the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let index: RecipeIndex;
  const workbenches = new Map<string, Workbench>();
  const keywords = new Map<string, number>();

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    index = await recipeIndex(db);
    for (const formId of db.formIdsOfType('FURN')) {
      const record = await db.get(formId);
      const workbench = record && parseWorkbench(record);
      if (workbench) workbenches.set(workbench.editorId, workbench);
    }
    for (const keyword of index.workbenchCounts().keys()) {
      const editorId = (await db.get(keyword))?.editorId;
      if (editorId) keywords.set(editorId, keyword);
    }
  }, 60_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  const recipesOf = (keyword: string) => index.byWorkbenchKeyword(keywords.get(keyword) ?? 0);

  it('index every recipe by its workbench keyword', async () => {
    expect(index.recipes.length).toBe(1614);
    expect(recipeIndex(db)).toBe(recipeIndex(db));
    expect(await recipeIndex(db)).toBe(index);
    const counts = Object.fromEntries(
      [
        'CraftingSmithingArmorTable',
        'CraftingSmithingForge',
        'CraftingSmithingSharpeningWheel',
        'BYOHBuildingCarpenter',
        'CraftingCookpot',
        'BYOHBuildingDrafting',
        'DLC2StaffEnchanter',
        'CraftingSmelter',
        'CraftingTanningRack',
        'BYOHCraftingOven',
        'CraftingSmithingSkyforge',
        'DLC1CraftingDawnguard',
        'DLC1LD_CraftingForgeAetherium',
      ].map((keyword) => [keyword, recipesOf(keyword).length]),
    );
    expect(counts).toEqual({
      CraftingSmithingArmorTable: 339,
      CraftingSmithingForge: 309,
      CraftingSmithingSharpeningWheel: 251,
      BYOHBuildingCarpenter: 200,
      CraftingCookpot: 70,
      BYOHBuildingDrafting: 51,
      DLC2StaffEnchanter: 43,
      CraftingSmelter: 18,
      CraftingTanningRack: 17,
      BYOHCraftingOven: 13,
      CraftingSmithingSkyforge: 12,
      DLC1CraftingDawnguard: 10,
      DLC1LD_CraftingForgeAetherium: 3,
    });
  });

  it('read the workbench types and skills of the furniture', () => {
    const bench = (editorId: string) => {
      const workbench = workbenches.get(editorId);
      return workbench && [workbench.type, workbench.skill, craftingMenuOf(workbench.type)?.frame];
    };
    expect(bench('CraftingBlackSmithForge')).toEqual([1, 10, 'ConstructibleObject']);
    expect(bench('CraftingBlacksmithSharpeningWheel')).toEqual([2, 10, 'Smithing']);
    expect(bench('CraftingBlacksmithArmorWorkbench')).toEqual([7, 10, 'Smithing']);
    expect(bench('CraftingEnchantingWorkbench')).toEqual([3, 23, 'EnchantConstruct']);
    expect(bench('CraftingAlchemyWorkbench')).toEqual([5, 16, 'Alchemy']);
    expect(bench('CraftingSmelterMarker1')).toEqual([1, undefined, 'ConstructibleObject']);
    expect(bench('DisenchantmentFont01')).toEqual([3, undefined, 'EnchantConstruct']);
    expect(bench('DLC2CraftingStaffWorkbench')).toEqual([1, 23, 'ConstructibleObject']);
    // A Skyforge offers the forge's recipes and its own.
    const skyforge = workbenches.get('CraftingBlackSmithForgeSkyforge');
    expect(index.forWorkbench(skyforge?.keywords ?? []).length).toBe(309 + 12);
    expect([...workbenches.values()].every((w) => craftingMenuOf(w.type) !== undefined)).toBe(true);
  });

  it('put the forge recipes in their material categories', async () => {
    const defaults = await DefaultObjects.read(db);
    const materials = materialFilterIndices((use) => defaults.get(use));
    const byCategory = new Map<number, string[]>();
    for (const recipe of recipesOf('CraftingSmithingForge')) {
      const created = recipe.created === undefined ? undefined : await db.get(recipe.created);
      if (!created) continue;
      const category = constructibleCategory(craftedItemInfo(created), materials);
      byCategory.set(category, [...(byCategory.get(category) ?? []), created.editorId ?? '']);
    }
    expect(byCategory.get(ConstructibleFilter.iron)).toContain('IronSword');
    expect(byCategory.get(ConstructibleFilter.steel)).toContain('SteelSword');
    expect(byCategory.get(ConstructibleFilter.daedric)).toContain('DaedricSword');
    expect(byCategory.get(ConstructibleFilter.jewelry)).toContain('JewelryRingGold');
    expect(byCategory.get(ConstructibleFilter.stalhrim)?.length).toBeGreaterThan(10);
    // HearthFire fittings made at the forge: "BUILDING MATERIALS" (GenericCraftableKeyword07).
    expect(byCategory.get(ConstructibleFilter.generic01 + 6)?.length).toBe(4);
  });

  it('make food at the cooking pot', async () => {
    let food = 0;
    for (const recipe of recipesOf('CraftingCookpot')) {
      const created = recipe.created === undefined ? undefined : await db.get(recipe.created);
      if (created && craftedItemInfo(created).food) food++;
    }
    expect(food).toBeGreaterThan(60);
  });

  it('improve weapons at the grindstone and armor at the armor table', async () => {
    const types = async (keyword: string) => {
      const found = new Set<string>();
      for (const recipe of recipesOf(keyword)) {
        const created = recipe.created === undefined ? undefined : await db.get(recipe.created);
        if (created) found.add(created.type);
      }
      return [...found];
    };
    expect(await types('CraftingSmithingSharpeningWheel')).toEqual(['WEAP']);
    expect(await types('CraftingSmithingArmorTable')).toEqual(['ARMO']);
    // An iron sword is improved with its own tempering recipe.
    const wheel = recipesOf('CraftingSmithingSharpeningWheel');
    const ironSword = index.recipes.find((r) => r.editorId === 'RecipeWeaponIronSword')?.created;
    const [candidate] = temperingCandidates([{ base: ironSword ?? 0 }], wheel);
    expect(candidate?.recipe.editorId).toBe('TemperWeaponIronSword');
    expect(WorkbenchType.smithingWeapon).toBe(
      workbenches.get('CraftingBlacksmithSharpeningWheel')?.type,
    );
  });
});
