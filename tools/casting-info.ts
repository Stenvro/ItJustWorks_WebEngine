// Casting against the real files (src/gameplay/magic/casting.ts, shouts.ts, projectile-flight.ts;
// src/world/projectile-data.ts): a spell's cost by its school's skill, its charge, its projectile
// and explosion; a shout's words, spells and recovery.
//
//   node tools/casting-info.ts Firebolt              a spell, scroll or staff (WEAP: its staff
//                                                    enchantment): its base cost, the magicka it
//                                                    costs the player and an NPC by skill (and
//                                                    dual cast), its charge time, cast type and
//                                                    delivery, its costliest effect's sounds,
//                                                    casting art, projectile and explosion
//   node tools/casting-info.ts UnrelentingForce      a shout (SHOU, by editor id or name): its
//                                                    words (dragon tongue, translation), each
//                                                    word's spell (its projectile) and recovery,
//                                                    the hold time for each word
//   node tools/casting-info.ts Firebolt --cast       ... then cast by the player in a runtime on
//                                                    the game data (a shout: held for 1, 2, 3
//                                                    words): its cost, its events, the voice
//   node tools/casting-info.ts --audit               every PROJ and EXPL read: counts by type,
//                                                    the magic effects' projectiles by type

import { parseArgs } from 'node:util';
import {
  CASTING_DEFAULTS,
  CASTING_SETTING_NAMES,
  chargeSeconds,
  itemBaseCost,
  magickaCost,
  staffCastsLeft,
  type CastingSettings,
} from '../src/gameplay/magic/casting.ts';
import { flightKind } from '../src/gameplay/magic/projectile-flight.ts';
import { SHOUT_DEFAULTS, shoutRecovery, wordsByHold } from '../src/gameplay/magic/shouts.ts';
import { CastingSource } from '../src/scripting/runtime/casting-engine.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { ActorValue, actorValueName } from '../src/world/actor-values.ts';
import { GameSettings } from '../src/world/game-settings.ts';
import { effectSound, EffectSound, parseMagicEffect } from '../src/world/magic-effects.ts';
import {
  parseArtObject,
  parseMagicItem,
  type MagicItemRecord,
} from '../src/world/magic-records.ts';
import {
  parseExplosion,
  parseProjectile,
  projectileTypeName,
  type ProjectileRecord,
} from '../src/world/projectile-data.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { parseShout, parseWord } from '../src/world/spell-records.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    audit: { type: 'boolean', default: false },
    cast: { type: 'boolean', default: false },
  },
});

const db = await RecordDatabase.open(await Vfs.mount(openGameFolder()));
const gmst = await GameSettings.read(db);
const read: Record<string, number> = {};
for (const [key, name] of Object.entries(CASTING_SETTING_NAMES)) {
  const value = gmst.number(name);
  if (value !== undefined) read[key] = value;
}
const casting: CastingSettings = { ...CASTING_DEFAULTS, ...read };
const shoutTimes = {
  time1: gmst.number('fShoutTime1') ?? SHOUT_DEFAULTS.time1,
  time2: gmst.number('fShoutTime2') ?? SHOUT_DEFAULTS.time2,
};
const hex = (formId: number | undefined): string =>
  formId === undefined ? '-' : formId.toString(16).toUpperCase().padStart(8, '0');
const num = (value: number): string => String(Number(value.toFixed(2)));
const CAST_TYPES = ['constant', 'fire and forget', 'concentration', 'scroll'];
const DELIVERIES = ['self', 'touch', 'aimed', 'target actor', 'target location'];

async function editorId(formId: number | undefined): Promise<string> {
  if (formId === undefined) return '-';
  return (await db.get(formId))?.editorId ?? hex(formId);
}

/** A record by editor id, hex form id or name, of the given types. */
async function find(wanted: string, types: readonly string[]): Promise<GameRecord | undefined> {
  const asId = /^(0x)?[0-9a-f]{1,8}$/i.test(wanted) ? Number.parseInt(wanted, 16) : undefined;
  if (asId !== undefined) {
    const record = await db.get(asId);
    if (record && types.includes(record.type)) return record;
  }
  const lower = wanted.toLowerCase();
  let byName: GameRecord | undefined;
  for (const type of types) {
    for (const formId of db.formIdsOfType(type)) {
      const record = await db.get(formId);
      if (!record || record.deleted) continue;
      if (record.editorId?.toLowerCase() === lower) return record;
      if (!byName && record.text('FULL')?.toLowerCase() === lower) byName = record;
    }
  }
  return byName;
}

const effects = new Map<number, ReturnType<typeof parseMagicEffect> | undefined>();
async function effectOf(formId: number): Promise<ReturnType<typeof parseMagicEffect> | undefined> {
  if (!effects.has(formId)) {
    const record = await db.get(formId);
    effects.set(formId, record?.type === 'MGEF' ? parseMagicEffect(record) : undefined);
  }
  return effects.get(formId);
}

/** The costliest effect (the school's, the projectile's), as the engine picks it. */
async function mainEffect(item: MagicItemRecord) {
  let best: Awaited<ReturnType<typeof effectOf>>;
  let bestCost = -1;
  for (const entry of item.effects) {
    const effect = await effectOf(entry.effect);
    if (!effect) continue;
    const cost = effect.baseCost * Math.max(1, entry.magnitude);
    if (cost > bestCost) {
      best = effect;
      bestCost = cost;
    }
  }
  return best;
}

function projectileLine(projectile: ProjectileRecord): string {
  return (
    `${projectile.editorId} [${hex(projectile.formId)}] ${projectileTypeName(projectile.type)}` +
    ` (${flightKind(projectile)}), speed ${num(projectile.speed)}, gravity ${num(projectile.gravity)},` +
    ` range ${num(projectile.range)}, radius ${num(projectile.collisionRadius)}` +
    (projectile.coneSpread > 0 ? `, cone ${num(projectile.coneSpread)}°` : '') +
    (projectile.relaunchInterval > 0 ? `, relaunch ${num(projectile.relaunchInterval)} s` : '') +
    (projectile.lifetime > 0 ? `, lifetime ${num(projectile.lifetime)} s` : '') +
    (projectile.impactForce > 0 ? `, impact force ${num(projectile.impactForce)}` : '') +
    `, flags 0x${projectile.flags.toString(16)}`
  );
}

async function printProjectileAndExplosion(
  projectileId: number | undefined,
  explosionId: number | undefined,
  indent: string,
): Promise<void> {
  const record = projectileId === undefined ? undefined : await db.get(projectileId);
  const projectile = record?.type === 'PROJ' ? parseProjectile(record) : undefined;
  if (projectile) {
    console.log(`${indent}projectile: ${projectileLine(projectile)}`);
    console.log(
      `${indent}  model ${projectile.model ?? '-'}, light ${await editorId(projectile.light)}, sound ${await editorId(projectile.sound)}`,
    );
  } else console.log(`${indent}projectile: - (delivered at once)`);
  const burst = (projectile?.flags ?? 0) & 0x2 ? projectile?.explosion : undefined;
  const id = burst ?? explosionId;
  const explosionRecord = id === undefined ? undefined : await db.get(id);
  if (explosionRecord?.type !== 'EXPL') return;
  const explosion = parseExplosion(explosionRecord);
  console.log(
    `${indent}explosion: ${explosion.editorId} [${hex(explosion.formId)}] radius ${num(explosion.radius)}, force ${num(explosion.force)}, damage ${num(explosion.damage)}, enchantment ${await editorId(explosion.enchantment)}, impact data ${await editorId(explosion.impactDataSet)}, sound ${await editorId(explosion.sound)}`,
  );
}

async function printSpell(
  item: MagicItemRecord,
  title: string,
  staffCharge?: number,
): Promise<void> {
  const costs = new Map<number, number>();
  for (const entry of item.effects)
    costs.set(entry.effect, (await effectOf(entry.effect))?.baseCost ?? 0);
  const manual = item.type === 'ENCH' ? (item.flags & 0x1) !== 0 : (item.flags & 0x1) !== 0;
  const base = itemBaseCost(
    { ...item, flags: manual ? 0x1 : 0 },
    (effect) => costs.get(effect) ?? 0,
    casting,
  );
  const main = await mainEffect(item);
  console.log(
    `${title} ${item.editorId} [${hex(item.formId)}] "${item.name}": ${item.kind}, ${CAST_TYPES[item.castType] ?? item.castType}, ${DELIVERIES[item.delivery] ?? item.delivery}`,
  );
  console.log(
    `  base cost ${num(base)}${manual ? ' (its own)' : ' (calculated)'}, charge ${num(chargeSeconds(item.chargeTime, false, casting))} s` +
      (item.castType === 2 ? ', a second' : '') +
      `, school ${main && main.skill >= 0 ? actorValueName(main.skill) : '-'}`,
  );
  if (item.kind === 'spell') {
    const skills = [15, 25, 50, 75, 100];
    const line = (player: boolean, dual: boolean): string =>
      skills
        .map(
          (skill) =>
            `${String(skill)}: ${num(magickaCost({ baseCost: base, skill, player, dual }, casting))}`,
        )
        .join(', ');
    console.log(`  magicka by skill, player: ${line(true, false)}`);
    console.log(`                    dual: ${line(true, true)}`);
    console.log(`                     NPC: ${line(false, false)}`);
    console.log(`  skill uses a cast: ${num(base)} (dual ${num(base * casting.dualCostMult)})`);
  } else if (item.kind === 'staffEnchantment') {
    const charge = staffCharge ?? item.enchantment?.amount ?? 0;
    console.log(
      `  charge a cast: ${num(base)} of ${String(charge)}: ${String(staffCastsLeft(charge, base))} casts`,
    );
  }
  for (const entry of item.effects) {
    const effect = await effectOf(entry.effect);
    console.log(
      `  effect ${effect?.editorId ?? hex(entry.effect)}: magnitude ${num(entry.magnitude)}, area ${String(entry.area)} ft, duration ${String(entry.duration)} s, base cost ${num(effect?.baseCost ?? 0)}`,
    );
  }
  if (!main) return;
  const sounds = [
    ['charge', EffectSound.charge],
    ['ready', EffectSound.ready],
    ['release', EffectSound.release],
    ['loop', EffectSound.concentrationLoop],
    ['hit', EffectSound.onHit],
  ] as const;
  const named: string[] = [];
  for (const [name, type] of sounds) {
    const sound = effectSound(main, type);
    if (sound !== undefined) named.push(`${name} ${await editorId(sound)}`);
  }
  const artRecord = main.castingArt === undefined ? undefined : await db.get(main.castingArt);
  const art = artRecord ? parseArtObject(artRecord) : undefined;
  console.log(`  sounds: ${named.join(', ') || '-'}`);
  console.log(
    `  casting art: ${await editorId(main.castingArt)}${art?.model ? ` (${art.model})` : ''}, impact data ${await editorId(main.impactData)}`,
  );
  await printProjectileAndExplosion(main.projectile, main.explosion, '  ');
}

if (values.audit) {
  const types = new Map<string, number>();
  for (const formId of db.formIdsOfType('PROJ')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const projectile = parseProjectile(record);
    const key = `${projectileTypeName(projectile.type)} (${flightKind(projectile)})`;
    types.set(key, (types.get(key) ?? 0) + 1);
    // The lobbers (runes, thrown things): how they fall, wait and burst.
    if (flightKind(projectile) === 'lobber')
      console.log(
        `  lobber ${projectile.editorId}: flags 0x${projectile.flags.toString(16)}, gravity ${String(projectile.gravity)}, speed ${String(projectile.speed)}, proximity ${String(projectile.proximity)}, timer ${String(projectile.timer)}, lifetime ${String(projectile.lifetime)}, range ${String(projectile.range)}`,
      );
  }
  console.log(`PROJ by type: ${[...types].map(([type, n]) => `${type} ${String(n)}`).join(', ')}`);
  let explosions = 0;
  let enchanted = 0;
  for (const formId of db.formIdsOfType('EXPL')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    explosions++;
    if (parseExplosion(record).enchantment !== undefined) enchanted++;
  }
  console.log(`EXPL: ${String(explosions)}, with an enchantment ${String(enchanted)}`);
  const byType = new Map<string, number>();
  let without = 0;
  for (const formId of db.formIdsOfType('MGEF')) {
    const effect = await effectOf(formId);
    if (!effect || effect.delivery < 2) continue;
    const record = effect.projectile === undefined ? undefined : await db.get(effect.projectile);
    if (record?.type !== 'PROJ') {
      without++;
      continue;
    }
    const type = projectileTypeName(parseProjectile(record).type);
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
  console.log(
    `aimed / target effects' projectiles: ${[...byType].map(([type, n]) => `${type} ${String(n)}`).join(', ')}; none ${String(without)}`,
  );
} else {
  const wanted = positionals[0];
  if (!wanted) {
    console.log('usage: node tools/casting-info.ts <spell|scroll|staff|shout> | --audit');
    process.exit(1);
  }
  const record = await find(wanted, ['SPEL', 'SCRL', 'SHOU', 'WEAP', 'ENCH']);
  if (!record) {
    console.log(`${wanted}: no spell, scroll, staff or shout`);
    process.exit(1);
  }
  if (record.type === 'SHOU') {
    const shout = parseShout(record);
    console.log(`SHOU ${shout.editorId} [${hex(shout.formId)}] "${shout.name}"`);
    console.log(
      `  hold for words: 1 tapped, 2 from ${num(shoutTimes.time1)} s, 3 from ${num(shoutTimes.time2)} s`,
    );
    for (const [index, entry] of shout.words.entries()) {
      const wordRecord = await db.get(entry.word);
      const word = wordRecord?.type === 'WOOP' ? parseWord(wordRecord) : undefined;
      const spellRecord = await db.get(entry.spell);
      const spell = spellRecord ? parseMagicItem(spellRecord) : undefined;
      console.log(
        `  ${String(index + 1)}. ${word?.word ?? '?'} (${word?.translation ?? '?'}) [${hex(entry.word)}]: recovery ${num(shoutRecovery(shout.words, index + 1, 0))} s (Blessing of Talos ${num(shoutRecovery(shout.words, index + 1, 0.2))} s)`,
      );
      if (spell) await printSpell(spell, '    spell');
    }
  } else {
    let item = parseMagicItem(record);
    let staffCharge: number | undefined;
    if (record.type === 'WEAP') {
      const enchantment = record.formIdField('EITM');
      const enchantmentRecord = enchantment === undefined ? undefined : await db.get(enchantment);
      item = enchantmentRecord ? parseMagicItem(enchantmentRecord) : undefined;
      const eamt = record.fields.first('EAMT');
      staffCharge =
        eamt && eamt.length >= 2
          ? new DataView(eamt.buffer, eamt.byteOffset, 2).getUint16(0, true)
          : undefined;
      console.log(
        `WEAP ${record.editorId ?? ''} [${hex(record.formId)}]: charge ${String(staffCharge ?? 0)}`,
      );
    }
    if (!item) {
      console.log(`${wanted}: no magic item`);
      process.exit(1);
    }
    await printSpell(item, item.type, staffCharge);
  }
  if (values.cast) await castInRuntime(record);
}

/**
 * The casting engine on the game data (a script runtime without a world): the player equips the
 * spell, staff or scroll in the right hand (a shout to the voice, its words learned and
 * unlocked), casts it through its charge and releases it; what it cost, and the voice after.
 */
async function castInRuntime(record: GameRecord): Promise<void> {
  const vfs = await Vfs.mount(openGameFolder());
  const library = new ScriptLibrary(async (name) => {
    const path = `scripts\\${name}.pex`;
    return vfs.has(path) ? vfs.read(path) : undefined;
  });
  const runtime = new ScriptRuntime(db, library, { warn: () => undefined });
  const magicka = async (): Promise<number> =>
    (await runtime.actors.value(PLAYER_REF, ActorValue.magicka)).current;
  console.log('\ncast by the player in a runtime on the game data:');
  if (record.type === 'SHOU') {
    const shout = parseShout(record);
    await runtime.actors.addSpell(PLAYER_REF, shout.formId);
    for (const entry of shout.words) runtime.wordsLearned.set(entry.word, true);
    await runtime.equipment.equipShout(PLAYER_REF, shout.formId);
    for (const held of [0.05, 0.5, 1.2]) {
      runtime.state.actor(PLAYER_REF).voiceRecoveryTime = 0;
      const begun = await runtime.casting.beginShout(PLAYER_REF);
      const { shout: times } = await runtime.casting.settings();
      const words = wordsByHold(held, runtime.casting.wordsKnown(PLAYER_REF, shout), times);
      const shouted = await runtime.casting.releaseShout(PLAYER_REF, words);
      console.log(
        `  held ${String(held)} s (${begun ?? '-'}): ${String(words)} words, ${shouted?.item.editorId ?? '-'}, voice recovers ${num(runtime.state.actors.get(PLAYER_REF)?.voiceRecoveryTime ?? 0)} s, meter ${num(runtime.casting.voiceMeter(PLAYER_REF))}`,
      );
    }
    return;
  }
  if (record.type === 'SCRL' || record.type === 'WEAP')
    await runtime.addItem(PLAYER_REF, runtime.formHandle(record.formId), 1, true);
  if (record.type === 'SPEL') {
    await runtime.actors.addSpell(PLAYER_REF, record.formId);
    await runtime.equipment.equipSpell(PLAYER_REF, record.formId, CastingSource.right);
  } else {
    await runtime.equipment.equip(PLAYER_REF, record.formId, { hand: 'right', silent: true });
  }
  const castable = await runtime.casting.castable(PLAYER_REF, CastingSource.right);
  if (!castable) {
    console.log('  nothing castable in the right hand');
    return;
  }
  const cost = await runtime.casting.cost(PLAYER_REF, castable);
  const before = await magicka();
  const begun = await runtime.casting.begin(PLAYER_REF, CastingSource.right);
  console.log(
    `  ${castable.via}: begun ${begun ?? '-'}, magicka ${num(before)}, cost ${num(cost.magicka)}, charge ${num(cost.chargeTime)} s`,
  );
  const events: string[] = [];
  runtime.casting.listeners.add((event) => events.push(event.kind));
  runtime.update(Math.max(cost.chargeTime, 0) + 1, 0);
  await runtime.vm.idle();
  const fired = await runtime.casting.release(PLAYER_REF, CastingSource.right);
  // (What a concentration spell spends is paid in the background.)
  await new Promise((resolve) => setTimeout(resolve, 50));
  console.log(
    `  after ${num(cost.chargeTime + 1)} s: ${events.join(', ')}; ${fired ? `fired ${fired.item.editorId}` : 'nothing fired'}, magicka ${num(await magicka())}`,
  );
}
