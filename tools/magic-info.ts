// Magic items and their effects against the real files (src/world/magic-records.ts,
// src/world/magic-effects.ts), and the magic system applying them (src/scripting/runtime/
// magic-engine.ts) in a script runtime on the game data, without a world.
//
//   node tools/magic-info.ts --audit                  every MGEF and magic item read: counts
//                                                     by archetype and kind, and what reads oddly
//   node tools/magic-info.ts RestoreHealth01          one item (editor id or hex form id; an
//                                                     ARMO / WEAP: its enchantment) with its
//                                                     effects, then applied to the player
//   node tools/magic-info.ts Flames --target X       ... applied to another actor (a reference)
//   node tools/magic-info.ts Flames --caster X       ... cast by an actor (default: none, a trap)
//   node tools/magic-info.ts DiseaseRockjoint --then CureDisease
//                                                     ... then a second item on the same target
//   node tools/magic-info.ts Firebolt --dual         ... dual cast
//   node tools/magic-info.ts X --damage 50          ... the target's Health damaged first
//   node tools/magic-info.ts X --seconds 30          ... time run on (default: the longest
//                                                     duration and a second, at most 600)

import { parseArgs } from 'node:util';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import type { Condition } from '../src/scripting/conditions.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { actorValueName } from '../src/world/actor-values.ts';
import {
  ARCHETYPE_NAMES,
  EffectFlag,
  effectText,
  parseMagicEffect,
  type MagicEffectRecord,
} from '../src/world/magic-effects.ts';
import {
  MAGIC_ITEM_TYPES,
  parseMagicItem,
  type MagicItemRecord,
} from '../src/world/magic-records.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    audit: { type: 'boolean', default: false },
    target: { type: 'string' },
    caster: { type: 'string' },
    then: { type: 'string' },
    dual: { type: 'boolean', default: false },
    seconds: { type: 'string' },
    damage: { type: 'string' },
  },
});

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const hex = (formId: number): string => formId.toString(16).toUpperCase().padStart(8, '0');
const num = (value: number): string => String(Number(value.toPrecision(5)));
const OPERATORS = ['==', '!=', '>', '>=', '<', '<='];
const RUN_ON = [
  'subject',
  'target',
  'reference',
  'combat target',
  'linked ref',
  'alias',
  'package',
  'event',
];
const KINDS = ['constant', 'fire and forget', 'concentration', 'scroll'];
const DELIVERIES = ['self', 'touch', 'aimed', 'target actor', 'target location'];

const editorIds = new Map<number, string>();
async function editorId(formId: number | undefined): Promise<string> {
  if (formId === undefined || formId === 0) return '-';
  let id = editorIds.get(formId);
  if (id === undefined) {
    id = (await db.get(formId))?.editorId ?? hex(formId);
    editorIds.set(formId, id);
  }
  return id;
}
const flagNames = (flags: number, names: Readonly<Record<string, number>>): string =>
  Object.entries(names)
    .filter(([, bit]) => (flags & bit) !== 0)
    .map(([name]) => name)
    .join(' ') || 'none';
const valueName = (index: number): string => (index < 0 ? '-' : actorValueName(index));

async function conditionText(condition: Condition): Promise<string> {
  const comparand =
    typeof condition.comparand === 'number'
      ? num(condition.comparand)
      : await editorId(condition.comparand.global);
  const on =
    condition.runOn === 2
      ? `${await editorId(condition.reference)}.`
      : condition.runOn === 0
        ? ''
        : `[${RUN_ON[condition.runOn] ?? String(condition.runOn)}] `;
  const args = condition.form ? await editorId(condition.form) : String(condition.raw1);
  return `${on}${conditionFunctionName(condition.function)}(${args}) ${OPERATORS[condition.operator] ?? '?'} ${comparand}${condition.or ? ' OR' : ''}`;
}

/** A record by editor id or hex form id. */
async function find(wanted: string): Promise<GameRecord | undefined> {
  const asId = /^(0x)?[0-9a-f]{1,8}$/i.test(wanted) ? Number.parseInt(wanted, 16) : undefined;
  if (asId !== undefined) {
    const record = await db.get(asId);
    if (record) return record;
  }
  const lower = wanted.toLowerCase();
  for (const type of [...MAGIC_ITEM_TYPES, 'ARMO', 'WEAP', 'ACHR', 'REFR', 'NPC_']) {
    for (const formId of db.formIdsOfType(type)) {
      const record = await db.get(formId);
      if (record && !record.deleted && record.editorId?.toLowerCase() === lower) return record;
    }
  }
  return undefined;
}

const effects = new Map<number, MagicEffectRecord | undefined>();
async function effectOf(formId: number): Promise<MagicEffectRecord | undefined> {
  if (!effects.has(formId)) {
    const record = await db.get(formId);
    effects.set(formId, record?.type === 'MGEF' ? parseMagicEffect(record) : undefined);
  }
  return effects.get(formId);
}

// --- Audit ------------------------------------------------------------------------------------

if (values.audit) {
  const archetypes = new Map<number, number>();
  const odd: string[] = [];
  let count = 0;
  for (const formId of db.formIdsOfType('MGEF')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    count++;
    const effect = parseMagicEffect(record);
    archetypes.set(effect.archetype, (archetypes.get(effect.archetype) ?? 0) + 1);
    if (ARCHETYPE_NAMES[effect.archetype] === undefined)
      odd.push(`${effect.editorId}: archetype ${String(effect.archetype)}`);
    if ((record.fields.first('DATA')?.length ?? 0) < 152)
      odd.push(`${effect.editorId}: DATA ${String(record.fields.first('DATA')?.length)} bytes`);
    for (const form of [
      effect.associatedItem,
      effect.hitShader,
      effect.hitEffectArt,
      effect.equipAbility,
    ]) {
      if (form !== undefined && !(await db.get(form)))
        odd.push(`${effect.editorId}: missing ${hex(form)}`);
    }
  }
  console.log(`${String(count)} magic effects`);
  for (const [archetype, n] of [...archetypes].sort((a, b) => a[0] - b[0]))
    console.log(
      `  ${String(archetype).padStart(2)} ${(ARCHETYPE_NAMES[archetype] ?? '?').padEnd(22)} ${String(n)}`,
    );
  for (const type of MAGIC_ITEM_TYPES) {
    const kinds = new Map<string, number>();
    let items = 0;
    for (const formId of db.formIdsOfType(type)) {
      const record = await db.get(formId);
      if (!record || record.deleted) continue;
      const item = parseMagicItem(record);
      if (!item) continue;
      items++;
      kinds.set(item.kind, (kinds.get(item.kind) ?? 0) + 1);
      for (const entry of item.effects) {
        if (!(await effectOf(entry.effect)))
          odd.push(`${item.editorId}: effect ${hex(entry.effect)} is not a magic effect`);
      }
      if (item.effects.length === 0) odd.push(`${type} ${item.editorId}: no effects`);
    }
    console.log(
      `${type} ${String(items).padStart(5)}: ${[...kinds].map(([kind, n]) => `${kind} ${String(n)}`).join(', ')}`,
    );
  }
  console.log(`${String(odd.length)} odd`);
  for (const line of odd.slice(0, 40)) console.log(`  ${line}`);
  process.exit(0);
}

// --- One item ---------------------------------------------------------------------------------

const wanted = positionals[0];
if (!wanted) {
  console.log(
    'usage: node tools/magic-info.ts <editor id | form id> [--target X] [--then Y] | --audit',
  );
  process.exit(1);
}

/** The magic item a record is (or an enchanted object's enchantment). */
async function magicItemOf(
  record: GameRecord,
): Promise<{ item: MagicItemRecord; object: GameRecord | undefined } | undefined> {
  const own = parseMagicItem(record);
  if (own) return { item: own, object: undefined };
  const enchantment = record.formIdField('EITM');
  const ench = enchantment === undefined ? undefined : await db.get(enchantment);
  const item = ench && parseMagicItem(ench);
  return item ? { item, object: record } : undefined;
}

async function show(item: MagicItemRecord, object: GameRecord | undefined): Promise<void> {
  if (object)
    console.log(
      `${object.type} ${object.editorId ?? ''} [${hex(object.formId)}] "${object.text('FULL') ?? ''}" is enchanted with`,
    );
  console.log(
    `${item.type} ${item.editorId} [${hex(item.formId)}] "${item.name}": ${item.kind}, ${KINDS[item.castType] ?? String(item.castType)}, ${DELIVERIES[item.delivery] ?? String(item.delivery)}, flags 0x${item.flags.toString(16)}, cost ${String(item.cost)}`,
  );
  if (item.potion)
    console.log(
      `  use sound ${await editorId(item.potion.useSound)}, addiction ${await editorId(item.potion.addiction)} ${num(item.potion.addictionChance)}`,
    );
  if (item.enchantment)
    console.log(
      `  charge ${String(item.enchantment.amount)}, base ${await editorId(item.enchantment.baseEnchantment)}`,
    );
  for (const [index, entry] of item.effects.entries()) {
    const effect = await effectOf(entry.effect);
    if (!effect) {
      console.log(`  ${String(index)}. missing magic effect ${hex(entry.effect)}`);
      continue;
    }
    console.log(
      `  ${String(index)}. ${effect.editorId} "${effect.name}" [${hex(effect.formId)}]: magnitude ${num(entry.magnitude)}, area ${String(entry.area)}, duration ${String(entry.duration)} s`,
    );
    console.log(
      `     ${ARCHETYPE_NAMES[effect.archetype] ?? String(effect.archetype)} on ${valueName(effect.actorValue)}${effect.secondActorValue >= 0 ? ` and ${valueName(effect.secondActorValue)} ×${num(effect.secondValueWeight)}` : ''}, resisted by ${valueName(effect.resistValue)}, skill ${valueName(effect.skill)}`,
    );
    console.log(`     flags ${flagNames(effect.flags, EffectFlag)}`);
    if (effect.associatedItem !== undefined)
      console.log(`     uses ${await editorId(effect.associatedItem)}`);
    const shown = [
      effect.hitShader && `shader ${await editorId(effect.hitShader)}`,
      effect.hitEffectArt && `art ${await editorId(effect.hitEffectArt)}`,
      effect.hitVisuals && `visuals ${await editorId(effect.hitVisuals)}`,
      effect.imageSpaceModifier && `image space ${await editorId(effect.imageSpaceModifier)}`,
      effect.equipAbility && `equip ability ${await editorId(effect.equipAbility)}`,
      effect.sounds.length > 0 &&
        `sounds ${(await Promise.all(effect.sounds.map(async (s) => `${String(s.type)}:${await editorId(s.sound)}`))).join(' ')}`,
      effect.scripted && 'scripts',
    ].filter((part) => typeof part === 'string');
    if (shown.length > 0) console.log(`     ${shown.join(', ')}`);
    if (effect.description !== '')
      console.log(`     "${effectText(effect, entry.magnitude, entry.duration, entry.area)}"`);
    for (const condition of entry.conditions)
      console.log(`     if ${await conditionText(condition)}`);
    for (const condition of effect.conditions)
      console.log(`     if (effect) ${await conditionText(condition)}`);
  }
}

const record = await find(wanted);
const found = record && (await magicItemOf(record));
if (!found) {
  console.log(`${wanted}: no magic item or enchanted object`);
  process.exit(1);
}
await show(found.item, found.object);

// --- Applied --------------------------------------------------------------------------------

const library = new ScriptLibrary(async (name) => {
  const path = `scripts\\${name}.pex`;
  return vfs.has(path) ? vfs.read(path) : undefined;
});
const warnings: string[] = [];
const runtime = new ScriptRuntime(db, library, { warn: (message) => warnings.push(message) });
const referenceOf = async (name: string | undefined): Promise<number | undefined> => {
  if (name === undefined) return undefined;
  const reference = await find(name);
  if (reference?.type !== 'ACHR' && reference?.type !== 'REFR') {
    console.log(`${name}: not a reference`);
    process.exit(1);
  }
  return reference.formId;
};
const target = (await referenceOf(values.target)) ?? PLAYER_REF;
const caster = await referenceOf(values.caster);
const magic = runtime.magic;
await magic.prepare(target);
if (values.damage !== undefined) await runtime.actors.damage(target, 24, Number(values.damage));

/** The values the effects change, with Health, Magicka and Stamina. */
const watched = new Set([24, 25, 26]);
const watch = async (item: MagicItemRecord): Promise<void> => {
  for (const entry of item.effects) {
    const effect = await effectOf(entry.effect);
    if (effect && effect.actorValue >= 0) watched.add(effect.actorValue);
    if (effect && effect.secondActorValue >= 0) watched.add(effect.secondActorValue);
  }
};
const snapshot = async (): Promise<Map<number, number>> => {
  const now = new Map<number, number>();
  for (const value of watched) now.set(value, (await runtime.actors.value(target, value)).current);
  return now;
};
const listEffects = async (title: string): Promise<void> => {
  console.log(`  ${title}:`);
  const on = magic.effectsOn(target);
  if (on.length === 0) console.log('    none');
  for (const [, entry] of on) {
    const effect = await effectOf(entry.effect);
    const time = entry.lasting ? 'lasting' : `${num(entry.elapsed)} / ${num(entry.duration)} s`;
    console.log(
      `    ${effect?.editorId ?? hex(entry.effect)} from ${await editorId(entry.item)}${entry.source === undefined ? '' : ` on ${await editorId(entry.source)}`}: magnitude ${num(entry.magnitude)}, ${time}${entry.inactive ? ', inactive' : ''}${entry.applied ? `, ${entry.applied.map((part) => `${valueName(part.value)} ${part.amount > 0 ? '+' : ''}${num(part.amount)}`).join(' ')}` : ''}`,
    );
  }
};

async function applyItem(item: MagicItemRecord, object: GameRecord | undefined): Promise<number> {
  await watch(item);
  const by = caster ?? (item.delivery === 0 ? target : undefined);
  switch (item.type) {
    case 'SPEL':
      if (item.kind === 'ability' || item.kind === 'disease' || item.kind === 'addiction') {
        await runtime.actors.addSpell(target, item.formId);
        await magic.syncLasting(target);
        return item.effects.length;
      }
      return (await magic.cast(item.formId, by ?? target, target, by)) ? 1 : 0;
    case 'SCRL':
      return (await magic.cast(item.formId, by ?? target, target)) ? 1 : 0;
    case 'ENCH':
      if (object && item.castType === 0) {
        // Worn: given and equipped (the equip system).
        await runtime.equipment.equip(target, object.formId, { silent: true });
        await magic.syncLasting(target);
        return item.effects.length;
      }
      if (item.castType === 0) return magic.apply(item, target, { caster: target, lasting: true });
      return magic.apply(item, target, { caster: by, source: object?.formId });
    case 'ALCH':
      if (item.kind === 'poison') return magic.apply(item, target, { caster: by });
      await runtime.addItem(target, runtime.formHandle(item.formId), 1, true);
      return (await magic.useItem(target, item.formId)) === 'used' ? item.effects.length : 0;
    case 'INGR':
      await runtime.addItem(target, runtime.formHandle(item.formId), 1, true);
      return (await magic.useItem(target, item.formId)) === 'used' ? 1 : 0;
  }
}

const targetName = target === PLAYER_REF ? 'the player' : await editorId(target);
console.log(
  `\napplied to ${targetName}${caster === undefined ? '' : ` by ${await editorId(caster)}`}${values.dual ? ', dual cast' : ''}:`,
);
await listEffects('effects before');
const steps: { item: MagicItemRecord; object: GameRecord | undefined }[] = [found];
if (values.then) {
  const then = await find(values.then);
  const next = then && (await magicItemOf(then));
  if (!next) {
    console.log(`${values.then}: no magic item`);
    process.exit(1);
  }
  steps.push(next);
}
for (const step of steps) await watch(step.item);
let values0 = await snapshot();
const line = (now: Map<number, number>, before: Map<number, number>): string =>
  [...now]
    .map(([value, amount]) => {
      const was = before.get(value) ?? amount;
      return `${valueName(value)} ${num(amount)}${was === amount ? '' : ` (${amount > was ? '+' : ''}${num(amount - was)})`}`;
    })
    .join(', ');
console.log(`  values: ${line(values0, values0)}`);
for (const [n, step] of steps.entries()) {
  if (n > 0) console.log(`\nthen ${step.item.editorId}:`);
  const applied =
    values.dual && step.item.type === 'SPEL'
      ? await magic.apply(step.item, target, { caster: caster ?? target, dual: true })
      : await applyItem(step.item, step.object);
  await runtime.vm.idle();
  console.log(`  ${String(applied)} effect(s) applied`);
  await listEffects('effects now');
  const at = await snapshot();
  console.log(`  values: ${line(at, values0)}`);
  // Time runs on in steps of a second (the magic system's frames), its changes shown.
  const longest = Math.max(
    0,
    ...magic
      .effectsOn(target)
      .map(([, entry]) => (entry.lasting ? 2 : entry.duration - entry.elapsed)),
  );
  const seconds = Math.min(
    600,
    values.seconds === undefined ? Math.ceil(longest) + 1 : Number(values.seconds),
  );
  let before = at;
  for (let t = 1; t <= seconds; t++) {
    for (let frame = 0; frame < 10; frame++) runtime.update(0.1, 0);
    await runtime.vm.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const now = await snapshot();
    if ([...now].some(([value, amount]) => before.get(value) !== amount) || t === seconds)
      console.log(
        `  ${String(t).padStart(4)} s: ${line(now, before)} | ${String(magic.effectsOn(target).length)} effect(s)`,
      );
    before = now;
  }
  await listEffects(`effects after ${String(seconds)} s`);
  values0 = before;
}
const unique = [...new Set(warnings)];
if (unique.length > 0) {
  console.log(`\n${String(unique.length)} warning(s):`);
  for (const warning of unique.slice(0, 20)) console.log(`  ${warning}`);
}
await db.close();
await vfs.close();
process.exit(0);
