// Integration test: the perk system on the local game data (no new game, no world): every
// vanilla perk parsed, its entry points known; perks held by the player, their entry points
// (Armsman, Alchemist, Haggling, the schools' Dual Casting and half-cost perks, the player's
// skill boost perks), abilities and the perks the magic effects give. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ENTRY_POINTS,
  EntryFunction,
  EntryPoint,
  isValueFunction,
} from '../src/gameplay/perk-entry-points.ts';
import { BARTER_DEFAULTS, barterMultipliers } from '../src/gameplay/barter.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { actorValueIndex } from '../src/world/actor-values.ts';
import type { MagicItemRecord } from '../src/world/magic-records.ts';
import { parsePerk, type PerkRecord } from '../src/world/perk-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

/** Skyrim.esm. */
const ARMSMAN_00 = 0xbabe4;
const ARMSMAN_20 = 0x79343;
const ALCHEMIST_00 = 0xbe127;
const HAGGLING_00 = 0xbe128;
const DESTRUCTION_DUAL_CASTING = 0x153cf;
const DESTRUCTION_NOVICE = 0xf2ca8;
const MERCHANT = 0x58f7a;
const PERK_MERCHANT_ABILITY = 0xaf66a;
const SKILL_BOOSTS = 0xcf788;
const ALCHEMY_SKILL_BOOSTS = 0xa725c;
const DRAGONHIDE_PERK = 0x109639;
/** ArmorFFSelf100 (Dragonhide's effect: its perk while it lasts). */
const DRAGONHIDE_EFFECT = 0xcdb75;
const IRON_SWORD = 0x12eb7;
const FLAMES = 0x12fcd;
const WHEAT = 0x4b0ba;
const BLUE_MOUNTAIN_FLOWER = 0x77e1c;
/** A vendor to trade with (Belethor's reference does not matter: Haggling asks nothing of it). */
const VENDOR = 0x1a66b;

describe.skipIf(!hasGamedata())('perks on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
  const perks: PerkRecord[] = [];

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    for (const formId of db.formIdsOfType('PERK')) {
      const record = await db.get(formId);
      if (record && !record.deleted) perks.push(parsePerk(record));
    }
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    runtime = new ScriptRuntime(db, library);
    await runtime.magic.prepare(PLAYER_REF);
  }, 120_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('parses every perk: its entries, each entry point known, its tabs within the known', () => {
    expect(perks.length).toBeGreaterThan(450);
    const kinds = new Map<string, number>();
    for (const perk of perks) {
      for (const entry of perk.entries) {
        kinds.set(entry.kind, (kinds.get(entry.kind) ?? 0) + 1);
        if (entry.kind !== 'entryPoint') continue;
        const info = ENTRY_POINTS[entry.entryPoint];
        expect(info, `${perk.editorId}: entry point ${String(entry.entryPoint)}`).toBeDefined();
        expect(entry.tabCount).toBeLessThanOrEqual(info?.tabs.length ?? 0);
        expect(entry.conditions.length).toBeLessThanOrEqual(info?.tabs.length ?? 0);
        expect(entry.function).toBeGreaterThan(EntryFunction.none);
        expect(entry.function).toBeLessThanOrEqual(EntryFunction.setText);
        // A value function has a value to work with; the others what they pick.
        if (isValueFunction(entry.function)) {
          expect(['float', 'range', 'actorValue']).toContain(entry.data.type);
        } else if (entry.function === EntryFunction.selectSpell) {
          expect(entry.data.type).toBe('spell');
        }
      }
    }
    expect(kinds.get('entryPoint')).toBeGreaterThan(600);
    expect(kinds.get('ability')).toBeGreaterThan(20);
    expect(kinds.get('quest')).toBeGreaterThan(10);
    // The player's skill boost perks: Fortify <skill> as Multiply 1 + Actor Value Mult.
    const boosts = perks.find((perk) => perk.formId === ALCHEMY_SKILL_BOOSTS);
    const alchemy = boosts?.entries.find(
      (entry) =>
        entry.kind === 'entryPoint' && entry.entryPoint === EntryPoint.modAlchemyEffectiveness,
    );
    expect(alchemy).toMatchObject({
      function: EntryFunction.multiplyOnePlusActorValueMult,
      data: { type: 'actorValue', actorValue: actorValueIndex('AlchemyPowerMod') },
    });
  });

  it('gives the player its base perks: the skill boosts', async () => {
    expect(await runtime.perks.has(PLAYER_REF, SKILL_BOOSTS)).toBe(true);
    expect(await runtime.perks.has(PLAYER_REF, ALCHEMY_SKILL_BOOSTS)).toBe(true);
    expect(await runtime.perks.has(PLAYER_REF, ARMSMAN_00)).toBe(false);
  });

  it('raises one-handed damage by 20% with Armsman, 40% with its second rank', async () => {
    const sword = await runtime.equipment.item(IRON_SWORD);
    if (!sword) throw new Error('no iron sword');
    const factor = () => runtime.equipment.modifiers.weaponPerks(PLAYER_REF, sword);
    expect(await factor()).toBeCloseTo(1);
    const before = await runtime.equipment.weaponDamage(PLAYER_REF, IRON_SWORD);
    await runtime.perks.add(PLAYER_REF, ARMSMAN_00);
    expect(await factor()).toBeCloseTo(1.2);
    expect(await runtime.equipment.weaponDamage(PLAYER_REF, IRON_SWORD)).toBeGreaterThan(before);
    // The first rank holds while the second is not taken (HasPerk Armsman20 == 0).
    await runtime.perks.add(PLAYER_REF, ARMSMAN_20);
    expect(await factor()).toBeCloseTo(1.4);
    await runtime.perks.remove(PLAYER_REF, ARMSMAN_20);
    await runtime.perks.remove(PLAYER_REF, ARMSMAN_00);
    expect(await factor()).toBeCloseTo(1);
  });

  it('carries Fortify One-Handed into the damage through the skill boost perks', async () => {
    const sword = await runtime.equipment.item(IRON_SWORD);
    if (!sword) throw new Error('no iron sword');
    const mod = actorValueIndex('OneHandedMod') ?? 0;
    runtime.actors.modify(PLAYER_REF, mod, 25);
    expect(await runtime.equipment.modifiers.weaponPerks(PLAYER_REF, sword)).toBeCloseTo(1.25);
    runtime.actors.modify(PLAYER_REF, mod, -25);
  });

  it('makes stronger potions with Alchemist and Fortify Alchemy', async () => {
    const strength = async (): Promise<number> =>
      (await runtime.crafting.potion(PLAYER_REF, [WHEAT, BLUE_MOUNTAIN_FLOWER]))?.effects[0]
        ?.magnitude ?? 0;
    const plain = await strength();
    await runtime.perks.add(PLAYER_REF, ALCHEMIST_00);
    const alchemist = await strength();
    expect(alchemist).toBeGreaterThan(plain);
    expect(alchemist / plain).toBeCloseTo(1.2, 1);
    const power = actorValueIndex('AlchemyPowerMod') ?? 0;
    runtime.actors.modify(PLAYER_REF, power, 50);
    expect((await strength()) / plain).toBeCloseTo(1.2 * 1.5, 1);
    runtime.actors.modify(PLAYER_REF, power, -50);
    await runtime.perks.remove(PLAYER_REF, ALCHEMIST_00);
  });

  it('lowers buying and raises selling prices with Haggling', async () => {
    const speech = 30;
    const settings = { ...BARTER_DEFAULTS, min: 2, max: 3.3 };
    const plain = barterMultipliers(
      speech,
      settings,
      await runtime.perks.barterFactors(PLAYER_REF, VENDOR),
    );
    await runtime.perks.add(PLAYER_REF, HAGGLING_00);
    const factors = await runtime.perks.barterFactors(PLAYER_REF, VENDOR);
    expect(factors.buy).toBeCloseTo(0.91);
    expect(factors.sell).toBeCloseTo(1.1);
    const haggling = barterMultipliers(speech, settings, factors);
    expect(haggling.buy).toBeLessThan(plain.buy);
    expect(haggling.sell).toBeGreaterThan(plain.sell);
    await runtime.perks.remove(PLAYER_REF, HAGGLING_00);
  });

  it("dual casts a school's spells only with its Dual Casting perk; Novice halves the cost", async () => {
    expect(await runtime.casting.canDualCast(PLAYER_REF, FLAMES)).toBe(false);
    await runtime.perks.add(PLAYER_REF, DESTRUCTION_DUAL_CASTING);
    expect(await runtime.casting.canDualCast(PLAYER_REF, FLAMES)).toBe(true);
    await runtime.perks.remove(PLAYER_REF, DESTRUCTION_DUAL_CASTING);
    const flames = await runtime.magic.item(FLAMES);
    if (!flames) throw new Error('no Flames');
    const cost = async () =>
      (await runtime.casting.cost(PLAYER_REF, { item: flames, via: 'spell' })).magicka;
    const full = await cost();
    await runtime.perks.add(PLAYER_REF, DESTRUCTION_NOVICE);
    expect(await cost()).toBeCloseTo(full / 2);
    await runtime.perks.remove(PLAYER_REF, DESTRUCTION_NOVICE);
  });

  it("gives a perk's ability while it is held (Merchant), listed among the active effects", async () => {
    const bypass = actorValueIndex('BypassVendorKeywordCheck') ?? 0;
    expect((await runtime.actors.value(PLAYER_REF, bypass)).current).toBe(0);
    await runtime.perks.add(PLAYER_REF, MERCHANT);
    expect((await runtime.actors.value(PLAYER_REF, bypass)).current).toBe(1);
    const items = runtime.magic.effectsOn(PLAYER_REF).map(([, entry]) => entry.item);
    expect(items).toContain(PERK_MERCHANT_ABILITY);
    await runtime.perks.remove(PLAYER_REF, MERCHANT);
    expect((await runtime.actors.value(PLAYER_REF, bypass)).current).toBe(0);
  });

  it("holds a magic effect's perk while the effect lasts (Dragonhide)", async () => {
    const item: MagicItemRecord = {
      formId: 0xff000999,
      type: 'SPEL',
      editorId: 'TestDragonhide',
      name: 'Dragonhide',
      kind: 'spell',
      castType: 1,
      delivery: 0,
      flags: 0,
      effects: [
        { effect: DRAGONHIDE_EFFECT, magnitude: 80, area: 0, duration: 30, conditions: [] },
      ],
      keywords: [],
      cost: 0,
      chargeTime: 0,
    };
    expect(await runtime.perks.has(PLAYER_REF, DRAGONHIDE_PERK)).toBe(false);
    await runtime.magic.apply(item, PLAYER_REF, { caster: PLAYER_REF });
    expect(await runtime.perks.has(PLAYER_REF, DRAGONHIDE_PERK)).toBe(true);
    // Its entry: 80% less damage taken.
    expect(
      await runtime.perks.apply(EntryPoint.modIncomingDamage, PLAYER_REF, 1, [undefined]),
    ).toBeCloseTo(0.2);
    await runtime.magic.dispelSpell(PLAYER_REF, item.formId);
    expect(await runtime.perks.has(PLAYER_REF, DRAGONHIDE_PERK)).toBe(false);
  }, 60_000);
});
