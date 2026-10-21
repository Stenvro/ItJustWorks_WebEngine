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
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
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

/** Skyrim.esm forms crafted with. */
const WHEAT = 0x4b0ba;
const BLUE_MOUNTAIN_FLOWER = 0x77e1c;
const NIGHTSHADE = 0x2f44c;
const DEATHBELL = 0x516c8;
const SALT_PILE = 0x34cdf;
const IRON_SWORD = 0x12eb7;
const IRON_CUIRASS = 0x12e49;
const SOUL_GEM_GRAND_FILLED = 0x2e4ff;
const SOUL_GEM_PETTY_FILLED = 0x2e4e3;
const FIRE_DAMAGE_BASE = 0x10fb95;
const FORTIFY_HEALTH_BASE = 0x10fb77;
/** EnchIronSwordFire01, "Iron Sword of Embers". */
const IRON_SWORD_OF_EMBERS = 0x49bb8;
const HEALTH = 24;
const ALCHEMY = 16;
const ENCHANTING = 23;
const SMITHING = 10;

describe.skipIf(!hasGamedata())('crafting in a running game on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
  const count = (container: number, formId: number) => runtime.itemCount(container, formId);
  const give = (formId: number, n = 1) =>
    runtime.addItem(PLAYER_REF, runtime.formHandle(formId), n, true);
  const experience = (skill: number) => runtime.state.skillExperience.get(skill) ?? 0;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    runtime = new ScriptRuntime(db, library);
  }, 120_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('brew a potion named after its strongest effect, the same one made again', async () => {
    await give(WHEAT, 2);
    await give(BLUE_MOUNTAIN_FLOWER, 2);
    const before = experience(ALCHEMY);
    const first = await runtime.crafting.brew(PLAYER_REF, [WHEAT, BLUE_MOUNTAIN_FLOWER]);
    const made = first.made ?? 0;
    expect(made >>> 24).toBe(0xff);
    const record = await runtime.forms.record(made);
    expect(record?.type).toBe('ALCH');
    expect(record?.text('FULL')).toBe('Potion of Fortify Health');
    const potion = await runtime.magic.item(made);
    expect(potion?.kind).toBe('potion');
    const effects = await Promise.all(
      (potion?.effects ?? []).map(async (e) => [
        (await runtime.magic.effect(e.effect))?.editorId,
        e.magnitude,
        e.duration,
      ]),
    );
    // Alchemy 15: the power is 4 x (1 + 0.5 x 0.15) = 4.3.
    expect(effects).toEqual([
      ['AlchFortifyHealth', Math.round(4 * 4.3), 60],
      ['AlchRestoreHealth', Math.round(5 * 4.3), 0],
    ]);
    expect((await runtime.equipment.item(made))?.value).toBe(first.potion?.value);
    // The shared effects are found out on both; the ingredients are used up.
    expect([...(runtime.state.ingredientEffects.get(WHEAT) ?? [])].sort()).toEqual([0, 1]);
    expect([...(runtime.state.ingredientEffects.get(BLUE_MOUNTAIN_FLOWER) ?? [])].sort()).toEqual([
      0, 2,
    ]);
    expect(await count(PLAYER_REF, WHEAT)).toBe(1);
    expect(experience(ALCHEMY)).toBeGreaterThan(before);
    // Made again it is the same potion: they stack.
    const second = await runtime.crafting.brew(PLAYER_REF, [WHEAT, BLUE_MOUNTAIN_FLOWER]);
    expect(second.made).toBe(made);
    expect(await count(PLAYER_REF, made)).toBe(2);
    // It is drunk as the plugins' potions are.
    expect(await runtime.magic.useItem(PLAYER_REF, made)).toBe('used');
    expect(await count(PLAYER_REF, made)).toBe(1);
  }, 120_000);

  it('brew a poison, and nothing from ingredients that share no effect', async () => {
    await give(NIGHTSHADE, 2);
    await give(DEATHBELL);
    await give(SALT_PILE);
    const poison = await runtime.crafting.brew(PLAYER_REF, [NIGHTSHADE, DEATHBELL]);
    expect((await runtime.forms.record(poison.made ?? 0))?.text('FULL')).toBe(
      'Poison of Damage Health',
    );
    expect((await runtime.magic.item(poison.made ?? 0))?.kind).toBe('poison');
    const failed = await runtime.crafting.brew(PLAYER_REF, [NIGHTSHADE, SALT_PILE]);
    expect(failed.made).toBeUndefined();
    expect(await count(PLAYER_REF, NIGHTSHADE)).toBe(0);
    expect(await count(PLAYER_REF, SALT_PILE)).toBe(0);
  }, 60_000);

  it('disenchant an item to learn its base enchantment, once', async () => {
    await give(IRON_SWORD_OF_EMBERS, 2);
    expect(await runtime.crafting.disenchant(PLAYER_REF, IRON_SWORD_OF_EMBERS)).toEqual({
      kind: 'learned',
      enchantment: FIRE_DAMAGE_BASE,
      name: 'Fire Damage',
    });
    expect(runtime.state.knownEnchantments.has(FIRE_DAMAGE_BASE)).toBe(true);
    expect(await count(PLAYER_REF, IRON_SWORD_OF_EMBERS)).toBe(1);
    expect((await runtime.crafting.disenchant(PLAYER_REF, IRON_SWORD_OF_EMBERS)).kind).toBe(
      'known',
    );
  }, 60_000);

  it('enchant a weapon: an enchantment and an item made, its charge used by hits, recharged', async () => {
    // The player's own (the Player record's items) stay.
    const swords = await count(PLAYER_REF, IRON_SWORD);
    await give(IRON_SWORD);
    await give(SOUL_GEM_GRAND_FILLED);
    const before = experience(ENCHANTING);
    const fire = (value?: number) => [
      { formId: FIRE_DAMAGE_BASE, ...(value !== undefined && { value }) },
    ];
    const half = await runtime.crafting.plan(PLAYER_REF, IRON_SWORD, fire(5), 5);
    const full = await runtime.crafting.plan(PLAYER_REF, IRON_SWORD, fire(), 5);
    expect(full?.weapon).toBe(true);
    expect(full?.maxValue).toBe(10);
    expect(full?.charge).toBe(3000);
    // A lower magnitude gives more hits.
    expect(half?.uses ?? 0).toBeGreaterThan(full?.uses ?? 0);
    const made =
      (await runtime.crafting.enchant(
        PLAYER_REF,
        IRON_SWORD,
        undefined,
        fire(),
        SOUL_GEM_GRAND_FILLED,
      )) ?? 0;
    const sword = await runtime.equipment.item(made);
    expect(sword?.name).toBe('Iron Sword of Fire Damage');
    expect(sword?.weapon?.damage).toBe((await runtime.equipment.item(IRON_SWORD))?.weapon?.damage);
    expect(sword?.charge).toBe(3000);
    expect((await runtime.forms.record(made))?.formIdField('CNAM')).toBe(IRON_SWORD);
    const enchantment = await runtime.magic.item(sword?.enchantment ?? 0);
    expect(enchantment?.enchantment?.baseEnchantment).toBe(FIRE_DAMAGE_BASE);
    expect(enchantment?.effects[0]?.magnitude).toBe(10);
    expect(enchantment?.cost).toBe(full?.chargePerUse);
    // The sword and the gem are used up, the made sword is the player's.
    expect(await count(PLAYER_REF, IRON_SWORD)).toBe(swords);
    expect(await count(PLAYER_REF, SOUL_GEM_GRAND_FILLED)).toBe(0);
    expect(await count(PLAYER_REF, made)).toBe(1);
    expect(experience(ENCHANTING)).toBeGreaterThan(before);
    // It is wielded like any sword.
    expect(await runtime.equipment.equip(PLAYER_REF, made)).toBe(true);
    // Each hit uses its cost until too little is left.
    let hits = 0;
    while (hits < 1000 && (await runtime.crafting.useCharge(PLAYER_REF, made))) hits++;
    expect(hits).toBe(full?.uses);
    expect(await runtime.crafting.chargePercent(PLAYER_REF, made)).toBeLessThan(5);
    // A petty soul recharges 250 of it.
    await give(SOUL_GEM_PETTY_FILLED);
    const gems = await runtime.crafting.soulGems(PLAYER_REF);
    expect(gems.map((gem) => [gem.formId, gem.charge])).toEqual([[SOUL_GEM_PETTY_FILLED, 250]]);
    expect(await runtime.crafting.recharge(PLAYER_REF, made, SOUL_GEM_PETTY_FILLED)).toBe(true);
    expect((await runtime.crafting.charge(PLAYER_REF, made))?.current).toBeGreaterThanOrEqual(250);
    expect(await count(PLAYER_REF, SOUL_GEM_PETTY_FILLED)).toBe(0);
  }, 120_000);

  it('enchant armor by the soul, and not with a weapon enchantment', async () => {
    runtime.state.knownEnchantments.add(FORTIFY_HEALTH_BASE);
    await give(IRON_CUIRASS, 2);
    await give(SOUL_GEM_GRAND_FILLED, 2);
    expect(
      await runtime.crafting.enchant(
        PLAYER_REF,
        IRON_CUIRASS,
        undefined,
        [{ formId: FIRE_DAMAGE_BASE }],
        SOUL_GEM_GRAND_FILLED,
      ),
    ).toBeUndefined();
    const made =
      (await runtime.crafting.enchant(
        PLAYER_REF,
        IRON_CUIRASS,
        undefined,
        [{ formId: FORTIFY_HEALTH_BASE }],
        SOUL_GEM_GRAND_FILLED,
        'Breezehome Cuirass',
      )) ?? 0;
    const armor = await runtime.equipment.item(made);
    expect(armor?.name).toBe('Breezehome Cuirass');
    expect(armor?.armor?.rating).toBe((await runtime.equipment.item(IRON_CUIRASS))?.armor?.rating);
    const enchantment = await runtime.magic.item(armor?.enchantment ?? 0);
    expect(enchantment?.castType).toBe(0);
    // Fortify Health 20 at Enchanting 15 with a grand soul (UESP's skill multiplier: ~1).
    expect(enchantment?.effects[0]?.magnitude).toBe(20);
    // Worn, its enchantment fortifies the wearer (the magic system's worn enchantments).
    const health = (await runtime.actors.value(PLAYER_REF, HEALTH)).current;
    expect(await runtime.equipment.equip(PLAYER_REF, made)).toBe(true);
    await runtime.magic.syncLasting(PLAYER_REF);
    expect((await runtime.actors.value(PLAYER_REF, HEALTH)).current).toBe(health + 20);
  }, 120_000);

  it('improve an item of its own: the quality moves and is worn with it', async () => {
    const swords = await count(PLAYER_REF, IRON_SWORD);
    await give(IRON_SWORD, 2);
    runtime.actors.setBase(PLAYER_REF, SMITHING, 40);
    const before = experience(SMITHING);
    expect(await runtime.crafting.temper(PLAYER_REF, IRON_SWORD, undefined)).toEqual({
      kind: 'improved',
      level: 2,
      previous: 0,
    });
    expect(experience(SMITHING)).toBeGreaterThan(before);
    expect(runtime.crafting.stacks(PLAYER_REF, IRON_SWORD)).toEqual([{ count: 1, health: 1.2 }]);
    expect(runtime.crafting.plainCount(PLAYER_REF, IRON_SWORD)).toBe(swords + 1);
    expect(runtime.crafting.instances(PLAYER_REF, IRON_SWORD).map((i) => i.health)).toEqual([
      1, 1.2,
    ]);
    // The plain one is wielded until the improved one is chosen.
    await runtime.equipment.equip(PLAYER_REF, IRON_SWORD);
    expect(runtime.equipment.modifiers.temperLevel(PLAYER_REF, IRON_SWORD)).toBe(0);
    runtime.crafting.wear(PLAYER_REF, IRON_SWORD, 0);
    expect(runtime.equipment.modifiers.temperLevel(PLAYER_REF, IRON_SWORD)).toBe(2);
    const plain = await runtime.equipment.weaponDamage(PLAYER_REF, IRON_SWORD, 0, 0);
    expect(await runtime.equipment.weaponDamage(PLAYER_REF, IRON_SWORD)).toBeGreaterThan(plain);
    // Not improved further at the same skill.
    expect((await runtime.crafting.temper(PLAYER_REF, IRON_SWORD, 0)).kind).toBe('skill');
    // Given away (the one asked for), it stays improved where it goes.
    const chest = 0xff0f0001;
    await runtime.removeItem(PLAYER_REF, runtime.formHandle(IRON_SWORD), 1, true, chest, 0);
    expect(runtime.crafting.stacks(chest, IRON_SWORD)).toEqual([{ count: 1, health: 1.2 }]);
    expect(runtime.crafting.stacks(PLAYER_REF, IRON_SWORD)).toEqual([]);
    expect(await count(PLAYER_REF, IRON_SWORD)).toBe(swords + 1);
    // Taken without saying which, the plain ones go first.
    await runtime.addItem(chest, runtime.formHandle(IRON_SWORD), 1, true);
    await runtime.removeItem(chest, runtime.formHandle(IRON_SWORD), 1, true, undefined);
    expect(runtime.crafting.stacks(chest, IRON_SWORD)).toEqual([{ count: 1, health: 1.2 }]);
  }, 120_000);
});
