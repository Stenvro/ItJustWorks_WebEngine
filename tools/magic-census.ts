// The magic of the load order counted (docs/gameplay.md, "Magic effects", "Casting and shouts"):
// how many magic effects (MGEF) have each archetype, casting type, delivery and flag, how many
// taper and what skill usage multipliers they carry; how many spells (SPEL) of each type, cast
// type and delivery and with each SPIT flag; how many enchantments (ENCH) of each kind and cast
// type, and how many scrolls (SCRL). The conformance suites sweep the classes with it
// (tests/conformance/magic/).
//
//   node tools/magic-census.ts

import { ARCHETYPE_NAMES, EffectFlag, parseMagicEffect } from '../src/world/magic-effects.ts';
import { EnchantType, parseMagicItem } from '../src/world/magic-records.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { openGameFolder } from './gamedata-path.ts';

export interface MagicCensus {
  /** Magic effects (the winning MGEF of each form, not deleted). */
  readonly effects: number;
  /** Magic effects by archetype name (ARCHETYPE_NAMES). */
  readonly archetypes: ReadonlyMap<string, number>;
  /** By casting type (0 constant, 1 fire and forget, 2 concentration) and delivery (0 self ..). */
  readonly castingTypes: ReadonlyMap<number, number>;
  readonly deliveries: ReadonlyMap<number, number>;
  /** Magic effects setting each DATA flag bit, by bit. */
  readonly flags: ReadonlyMap<number, number>;
  /** Effects with a taper (a taper duration past 0), and of them those that recover. */
  readonly tapering: number;
  readonly taperingRecover: number;
  /** Tapering effects by their resist value (an actor value index; -1 none). */
  readonly taperingByResist: ReadonlyMap<number, number>;
  /** Effects whose skill usage multiplier is not 1, by the multiplier. */
  readonly skillUsageMults: ReadonlyMap<number, number>;
  /** Spells by SPIT type name (MagicItemRecord kind), cast type and delivery. */
  readonly spellKinds: ReadonlyMap<string, number>;
  readonly spellCastTypes: ReadonlyMap<number, number>;
  readonly spellDeliveries: ReadonlyMap<number, number>;
  /** Spells setting each SPIT flag bit, by bit. */
  readonly spellFlags: ReadonlyMap<number, number>;
  /** Enchantments (ENCH) by kind (enchantment, staff) and by cast type. */
  readonly enchantmentKinds: ReadonlyMap<string, number>;
  readonly enchantmentCastTypes: ReadonlyMap<number, number>;
  /** Enchantments whose charge is their own (ENIT 0x1, no auto calc). */
  readonly enchantmentsManual: number;
  readonly scrolls: number;
}

const add = <K>(map: Map<K, number>, key: K): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};
const eachBit = (value: number, use: (bit: number) => void): void => {
  for (let i = 0; i < 32; i++) if ((value & (1 << i)) !== 0) use((1 << i) >>> 0);
};
const sorted = <K>(map: Map<K, number>): Map<K, number> =>
  new Map([...map].sort((a, b) => b[1] - a[1]));

/** Counts the load order's magic effects, spells, enchantments and scrolls. */
export async function magicCensus(db: RecordDatabase): Promise<MagicCensus> {
  const archetypes = new Map<string, number>();
  const castingTypes = new Map<number, number>();
  const deliveries = new Map<number, number>();
  const flags = new Map<number, number>();
  const taperingByResist = new Map<number, number>();
  const skillUsageMults = new Map<number, number>();
  let effects = 0;
  let tapering = 0;
  let taperingRecover = 0;
  for (const formId of db.formIdsOfType('MGEF')) {
    const record = await db.get(formId);
    if (!record || record.deleted) continue;
    const effect = parseMagicEffect(record);
    effects++;
    add(archetypes, ARCHETYPE_NAMES[effect.archetype] ?? String(effect.archetype));
    add(castingTypes, effect.castingType);
    add(deliveries, effect.delivery);
    eachBit(effect.flags, (bit) => {
      add(flags, bit);
    });
    const taperFlags = EffectFlag.noMagnitude | EffectFlag.noDuration;
    if (effect.taperDuration > 0 && (effect.flags & taperFlags) === 0) {
      tapering++;
      if ((effect.flags & EffectFlag.recover) !== 0) taperingRecover++;
      add(taperingByResist, effect.resistValue);
    }
    if (effect.skillUsageMult !== 1) add(skillUsageMults, Number(effect.skillUsageMult.toFixed(3)));
  }
  const spellKinds = new Map<string, number>();
  const spellCastTypes = new Map<number, number>();
  const spellDeliveries = new Map<number, number>();
  const spellFlags = new Map<number, number>();
  for (const formId of db.formIdsOfType('SPEL')) {
    const record = await db.get(formId);
    const item = record && !record.deleted ? parseMagicItem(record) : undefined;
    if (!item) continue;
    add(spellKinds, item.kind);
    add(spellCastTypes, item.castType);
    add(spellDeliveries, item.delivery);
    eachBit(item.flags, (bit) => {
      add(spellFlags, bit);
    });
  }
  const enchantmentKinds = new Map<string, number>();
  const enchantmentCastTypes = new Map<number, number>();
  let enchantmentsManual = 0;
  for (const formId of db.formIdsOfType('ENCH')) {
    const record = await db.get(formId);
    const item = record && !record.deleted ? parseMagicItem(record) : undefined;
    if (!item) continue;
    add(enchantmentKinds, item.kind);
    add(enchantmentCastTypes, item.castType);
    if ((item.flags & 0x1) !== 0) enchantmentsManual++;
  }
  let scrolls = 0;
  for (const formId of db.formIdsOfType('SCRL')) {
    const record = await db.get(formId);
    if (record && !record.deleted && parseMagicItem(record)) scrolls++;
  }
  return {
    effects,
    archetypes: sorted(archetypes),
    castingTypes,
    deliveries,
    flags,
    tapering,
    taperingRecover,
    taperingByResist: sorted(taperingByResist),
    skillUsageMults: sorted(skillUsageMults),
    spellKinds: sorted(spellKinds),
    spellCastTypes,
    spellDeliveries,
    spellFlags,
    enchantmentKinds,
    enchantmentCastTypes,
    enchantmentsManual,
    scrolls,
  };
}

/** The enchant types ENCH has (for the printout). */
export const ENCHANT_TYPES = EnchantType;

if (import.meta.main) {
  const vfs = await Vfs.mount(openGameFolder());
  const db = await RecordDatabase.open(vfs);
  // --show A,B: those magic effects' cost, skill, taper and skill usage multiplier.
  const showAt = process.argv.indexOf('--show');
  if (showAt >= 0) {
    const wanted = new Set((process.argv[showAt + 1] ?? '').toLowerCase().split(','));
    for (const formId of db.formIdsOfType('MGEF')) {
      const record = await db.get(formId);
      if (!record?.editorId || !wanted.has(record.editorId.toLowerCase())) continue;
      const e = parseMagicEffect(record);
      console.log(
        `${e.editorId} [${formId.toString(16)}] ${ARCHETYPE_NAMES[e.archetype] ?? '?'} cost ${String(e.baseCost)} ` +
          `skill ${String(e.skill)} flags 0x${e.flags.toString(16)} cast ${String(e.castingType)} ` +
          `delivery ${String(e.delivery)} taper w ${String(e.taperWeight)} c ${String(e.taperCurve)} ` +
          `d ${String(e.taperDuration)} skillUse ${String(e.skillUsageMult)}`,
      );
    }
    process.exit(0);
  }
  const census = await magicCensus(db);
  const hex = (bit: number): string => `0x${bit.toString(16)}`;
  const show = <K>(
    title: string,
    map: ReadonlyMap<K, number>,
    key: (k: K) => string = (k) => String(k),
  ): void => {
    console.log(`${title}:`);
    for (const [k, n] of map) console.log(`  ${key(k).padEnd(24)} ${String(n)}`);
  };
  console.log(`${String(census.effects)} magic effects`);
  show('archetypes', census.archetypes);
  show('casting types', census.castingTypes);
  show('deliveries', census.deliveries);
  show('flags', census.flags, hex);
  console.log(`tapering ${String(census.tapering)} (recover ${String(census.taperingRecover)})`);
  show('tapering by resist value', census.taperingByResist);
  show('skill usage multipliers (not 1)', census.skillUsageMults);
  show('spells by kind', census.spellKinds);
  show('spell cast types', census.spellCastTypes);
  show('spell deliveries', census.spellDeliveries);
  show('spell flags', census.spellFlags, hex);
  show('enchantments by kind', census.enchantmentKinds);
  show('enchantment cast types', census.enchantmentCastTypes);
  console.log(`enchantments with their own charge ${String(census.enchantmentsManual)}`);
  console.log(`${String(census.scrolls)} scrolls`);
  await db.close();
  await vfs.close();
}
