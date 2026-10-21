// Crafting in a script runtime on the game data, without a world (src/scripting/runtime/
// crafting-engine.ts, the formulas: src/gameplay/crafting.ts): the player is given what a craft
// needs, crafts, and what was made is printed (the created form's record as the engine reads
// it), with the skill's experience gained.
//
//   node tools/crafting-info.ts --potion Wheat,BlueMountainFlower [--skill 50]
//                                     ingredients brewed: the potion or poison made
//   node tools/crafting-info.ts --enchant IronSword --with EnchWeaponFireDamageBase
//        [--with ...] --gem SoulGemGrandFilled [--skill 15] [--value 5] [--name "My Sword"]
//                                     an item enchanted with learned (base) enchantments
//                                     (a weapon's slider value: --value), then (a weapon)
//                                     its hits used up and recharged
//   node tools/crafting-info.ts --temper IronSword [--skill 40]
//                                     an item improved at a smithing bench (no components)
//   node tools/crafting-info.ts --disenchant EnchIronSwordFire02
//                                     an enchanted item destroyed, its enchantment learned

import { parseArgs } from 'node:util';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { actorValueIndex } from '../src/world/actor-values.ts';
import { parseItem } from '../src/world/item-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values } = parseArgs({
  options: {
    potion: { type: 'string' },
    enchant: { type: 'string' },
    with: { type: 'string', multiple: true },
    gem: { type: 'string' },
    value: { type: 'string' },
    name: { type: 'string' },
    temper: { type: 'string' },
    disenchant: { type: 'string' },
    skill: { type: 'string' },
  },
});

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const library = new ScriptLibrary(async (name) => {
  const path = `scripts\\${name}.pex`;
  return vfs.has(path) ? vfs.read(path) : undefined;
});
const runtime = new ScriptRuntime(db, library);
const hex = (formId: number): string => formId.toString(16).toUpperCase().padStart(8, '0');
const num = (value: number): string => String(Number(value.toPrecision(5)));

/** Form ids by editor id, of the record types crafting names. */
const byEditorId = new Map<string, number>();
for (const type of ['INGR', 'WEAP', 'ARMO', 'ENCH', 'SLGM']) {
  for (const formId of db.formIdsOfType(type)) {
    const editorId = (await db.get(formId))?.editorId;
    if (editorId) byEditorId.set(editorId.toLowerCase(), formId);
  }
}
function find(wanted: string): number {
  if (/^(0x)?[0-9a-f]{6,8}$/i.test(wanted)) return Number.parseInt(wanted, 16);
  const formId = byEditorId.get(wanted.toLowerCase());
  if (formId === undefined)
    throw new Error(`no ingredient, weapon, armor, enchantment or soul gem ${wanted}`);
  return formId;
}

async function skill(name: string): Promise<number> {
  const index = actorValueIndex(name) ?? 0;
  if (values.skill !== undefined) runtime.actors.setBase(PLAYER_REF, index, Number(values.skill));
  return (await runtime.actors.value(PLAYER_REF, index)).current;
}

/** What the engine reads of a form: its record type, name, effects, value. */
async function describe(formId: number): Promise<void> {
  const record = await runtime.forms.record(formId);
  const item = record && parseItem(record);
  if (!record) {
    console.log(`  [${hex(formId)}] (no record)`);
    return;
  }
  console.log(
    `  ${record.type} [${hex(formId)}] "${record.text('FULL') ?? ''}"${item ? `, value ${String(item.value)}, weight ${num(item.weight)}` : ''}${item?.model ? `, model ${item.model}` : ''}`,
  );
  const magic = await runtime.magic.item(item?.enchantment ?? formId);
  if (item?.enchantment !== undefined)
    console.log(
      `  enchanted with [${hex(item.enchantment)}] "${magic?.name ?? ''}", charge ${String(item.charge)}`,
    );
  if (magic) {
    console.log(
      `  ${magic.kind}, cost ${String(magic.cost)}${magic.enchantment ? `, charge ${String(magic.enchantment.amount)}, base [${hex(magic.enchantment.baseEnchantment ?? 0)}]` : ''}`,
    );
    for (const entry of magic.effects) {
      const effect = await runtime.magic.effect(entry.effect);
      console.log(
        `    ${effect?.editorId ?? hex(entry.effect)} "${effect?.name ?? ''}": magnitude ${num(entry.magnitude)}, duration ${String(entry.duration)} s, area ${String(entry.area)}, ${String(entry.conditions.length)} conditions`,
      );
    }
  }
}

function experience(name: string, before: number): void {
  const index = actorValueIndex(name) ?? 0;
  const after = runtime.state.skillExperience.get(index) ?? 0;
  console.log(`${name} experience: +${num(after - before)}`);
}

if (values.potion) {
  const level = await skill('Alchemy');
  const ingredients = values.potion.split(',').map(find);
  for (const formId of ingredients)
    await runtime.addItem(PLAYER_REF, runtime.formHandle(formId), 1, true);
  const before = runtime.state.skillExperience.get(actorValueIndex('Alchemy') ?? 0) ?? 0;
  const result = await runtime.crafting.brew(PLAYER_REF, ingredients);
  console.log(`Alchemy ${num(level)}: ${result.made === undefined ? 'nothing made' : 'made'}`);
  if (result.made !== undefined) await describe(result.made);
  for (const formId of ingredients) {
    const known = [...(runtime.state.ingredientEffects.get(formId) ?? [])].sort();
    console.log(
      `  ${(await db.get(formId))?.editorId ?? hex(formId)}: effects known ${known.join(', ')}`,
    );
  }
  experience('Alchemy', before);
} else if (values.enchant) {
  const level = await skill('Enchanting');
  const base = find(values.enchant);
  const gem = find(values.gem ?? 'SoulGemGrandFilled');
  const chosen = (values.with ?? []).map((name) => ({
    formId: find(name),
    ...(values.value !== undefined && { value: Number(values.value) }),
  }));
  await runtime.addItem(PLAYER_REF, runtime.formHandle(base), 1, true);
  await runtime.addItem(PLAYER_REF, runtime.formHandle(gem), 1, true);
  for (const { formId } of chosen) runtime.state.knownEnchantments.add(formId);
  const soul = (await runtime.equipment.item(gem))?.soul?.current ?? 0;
  const plan = await runtime.crafting.plan(PLAYER_REF, base, chosen, soul);
  if (plan?.weapon)
    console.log(
      `Enchanting ${num(level)}: slider ${String(plan.value)} of 1..${String(plan.maxValue)}, charge ${String(plan.charge)}, ${String(plan.chargePerUse)} a hit: ${String(plan.uses)} hits`,
    );
  else console.log(`Enchanting ${num(level)}`);
  const before = runtime.state.skillExperience.get(actorValueIndex('Enchanting') ?? 0) ?? 0;
  const made = await runtime.crafting.enchant(
    PLAYER_REF,
    base,
    undefined,
    chosen,
    gem,
    values.name,
  );
  if (made === undefined) {
    console.log('  nothing made (the enchantment does not fit, or no soul)');
  } else {
    await describe(made);
    experience('Enchanting', before);
    const charge = await runtime.crafting.charge(PLAYER_REF, made);
    if (charge) {
      let hits = 0;
      while (hits < 10_000 && (await runtime.crafting.useCharge(PLAYER_REF, made))) hits++;
      console.log(`  ${String(hits)} hits until its charge ran out`);
      await runtime.addItem(PLAYER_REF, runtime.formHandle(gem), 1, true);
      await runtime.crafting.recharge(PLAYER_REF, made, gem);
      console.log(
        `  recharged with ${values.gem ?? 'SoulGemGrandFilled'}: ${num((await runtime.crafting.chargePercent(PLAYER_REF, made)) ?? 0)}%`,
      );
    }
  }
} else if (values.temper) {
  const level = await skill('Smithing');
  const base = find(values.temper);
  await runtime.addItem(PLAYER_REF, runtime.formHandle(base), 1, true);
  const before = runtime.state.skillExperience.get(actorValueIndex('Smithing') ?? 0) ?? 0;
  const result = await runtime.crafting.temper(PLAYER_REF, base, undefined);
  console.log(
    `Smithing ${num(level)}: ${result.kind === 'improved' ? `quality ${String(result.level)}` : 'too little skill'}`,
  );
  console.log(`  stacks: ${JSON.stringify(runtime.crafting.stacks(PLAYER_REF, base))}`);
  console.log(
    `  damage ${num(await runtime.equipment.weaponDamage(PLAYER_REF, base, 0, runtime.crafting.temperLevel(PLAYER_REF, base)))}, rating ${num(await runtime.equipment.pieceRating(PLAYER_REF, base, runtime.crafting.temperLevel(PLAYER_REF, base)))}`,
  );
  experience('Smithing', before);
} else if (values.disenchant) {
  const base = find(values.disenchant);
  await runtime.addItem(PLAYER_REF, runtime.formHandle(base), 1, true);
  const before = runtime.state.skillExperience.get(actorValueIndex('Enchanting') ?? 0) ?? 0;
  const result = await runtime.crafting.disenchant(PLAYER_REF, base);
  console.log(
    result.kind === 'learned'
      ? `learned [${hex(result.enchantment)}] "${result.name}"`
      : `nothing learned (${result.kind})`,
  );
  experience('Enchanting', before);
} else {
  console.log(
    'usage: node tools/crafting-info.ts --potion A,B[,C] | --enchant ITEM --with ENCH --gem GEM | --temper ITEM | --disenchant ITEM [--skill N]',
  );
}

await db.close();
await vfs.close();
