// What an actor is besides its look: an NPC_'s stats (level, health, magicka, stamina, skills),
// AI data, spells, perks, factions, crime faction, keywords; its race's starting values and
// abilities; relationships between NPCs (RELA); factions' reactions (FACT) and locations'
// parents, keywords and references (LCTN). Layouts: UESP "Skyrim Mod:Mod File Format"
// (NPC_, RACE, RELA, FACT, LCTN) and xEdit. Notes: docs/formats/esm.md ("Actors").
// Platform-independent.

import { view } from '../formats/esm/fields.ts';
import { conditionAt, type Condition } from '../scripting/conditions.ts';
import { SKILL_COUNT } from './actor-values.ts';
import type { GameRecord } from './record-db.ts';
import { readLocation, type PackageLocation } from '../ai/package-records.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'type' | 'editorId' | 'fields' | 'formIdAt'> &
  Partial<Pick<GameRecord, 'text'>>;

const formAt = (
  record: RecordSource,
  data: Uint8Array | undefined,
  offset = 0,
): number | undefined => {
  if (!data || data.length < offset + 4) return undefined;
  const formId = record.formIdAt(data, offset);
  return formId === 0 ? undefined : formId;
};
const nonEmpty = (text: string | undefined): string | undefined => (text === '' ? undefined : text);
const formField = (record: RecordSource, type: string): number | undefined =>
  formAt(record, record.fields.first(type));
const formList = (record: RecordSource, type: string): number[] =>
  record.fields.all(type).flatMap((data) => {
    const formId = formAt(record, data);
    return formId === undefined ? [] : [formId];
  });
const keywords = (record: RecordSource): number[] => {
  const data = record.fields.first('KWDA');
  const list: number[] = [];
  for (let at = 0; data && at + 4 <= data.length; at += 4) {
    const formId = formAt(record, data, at);
    if (formId !== undefined) list.push(formId);
  }
  return list;
};

/** NPC_ AIDT: the AI values (actor values 0..5) and aggro radii. */
export interface AiData {
  readonly aggression: number;
  readonly confidence: number;
  readonly energy: number;
  readonly morality: number;
  readonly mood: number;
  readonly assistance: number;
  /** Aggro radius behavior on, with its warn / warn-or-attack / attack radii. */
  readonly aggroRadius: readonly [number, number, number] | undefined;
}

export interface NpcStats {
  readonly formId: number;
  readonly name: string | undefined;
  /** ACBS flags (NpcFlag). */
  readonly flags: number;
  /** ACBS template data flags (TemplateFlag). */
  readonly templateFlags: number;
  readonly template: number | undefined;
  /** Level, or the player's level multiplier × 1000 with NpcFlag.pcLevelMult. */
  readonly level: number;
  readonly calcMinLevel: number;
  readonly calcMaxLevel: number;
  readonly healthOffset: number;
  readonly magickaOffset: number;
  readonly staminaOffset: number;
  /** ACBS speed multiplier (%: the SpeedMult actor value). */
  readonly speedMult: number;
  /** ACBS bleedout override. */
  readonly bleedoutOverride: number;
  /** DNAM: the 18 skills (actor values 6..23) and their offsets. */
  readonly skills: readonly number[];
  readonly skillOffsets: readonly number[];
  /** DNAM: health, magicka and stamina as the Creation Kit calculated them (base + offset). */
  readonly health: number;
  readonly magicka: number;
  readonly stamina: number;
  readonly race: number | undefined;
  readonly class: number | undefined;
  /** SPLO: spells (SPEL) and shouts (SHOU). */
  readonly spells: readonly number[];
  /** PRKR: perks. */
  readonly perks: readonly number[];
  /** PRKR's rank of each perk (u8 after the form id; 1 in every vanilla record). */
  readonly perkRanks: ReadonlyMap<number, number>;
  /** SNAM: factions and ranks. */
  readonly factions: ReadonlyMap<number, number>;
  readonly crimeFaction: number | undefined;
  readonly aiData: AiData;
  readonly deathItem: number | undefined;
  readonly keywords: readonly number[];
  readonly voiceType: number | undefined;
  readonly giftFilter: number | undefined;
  readonly combatStyle: number | undefined;
  readonly outfit: number | undefined;
  readonly sleepOutfit: number | undefined;
}

export function parseNpcStats(record: RecordSource): NpcStats {
  const acbs = record.fields.first('ACBS');
  const a = acbs && acbs.length >= 24 ? view(acbs) : undefined;
  const dnam = record.fields.first('DNAM');
  const d = dnam && dnam.length >= 42 ? view(dnam) : undefined;
  const aidt = record.fields.first('AIDT');
  const ai = aidt && aidt.length >= 8 ? aidt : undefined;
  const aiView = aidt && aidt.length >= 20 ? view(aidt) : undefined;
  return {
    formId: record.formId,
    name: nonEmpty(record.text?.('FULL')),
    flags: a?.getUint32(0, true) ?? 0,
    magickaOffset: a?.getInt16(4, true) ?? 0,
    staminaOffset: a?.getInt16(6, true) ?? 0,
    level: a?.getUint16(8, true) ?? 1,
    calcMinLevel: a?.getUint16(10, true) ?? 0,
    calcMaxLevel: a?.getUint16(12, true) ?? 0,
    speedMult: a?.getUint16(14, true) ?? 100,
    templateFlags: a?.getUint16(18, true) ?? 0,
    healthOffset: a?.getInt16(20, true) ?? 0,
    bleedoutOverride: a?.getUint16(22, true) ?? 0,
    template: formField(record, 'TPLT'),
    skills: d ? Array.from({ length: SKILL_COUNT }, (_, i) => d.getUint8(i)) : [],
    skillOffsets: d
      ? Array.from({ length: SKILL_COUNT }, (_, i) => d.getUint8(SKILL_COUNT + i))
      : [],
    health: d?.getUint16(36, true) ?? 0,
    magicka: d?.getUint16(38, true) ?? 0,
    stamina: d?.getUint16(40, true) ?? 0,
    race: formField(record, 'RNAM'),
    class: formField(record, 'CNAM'),
    spells: formList(record, 'SPLO'),
    perks: formList(record, 'PRKR'),
    perkRanks: new Map(
      record.fields.all('PRKR').flatMap((data): [number, number][] => {
        const perk = formAt(record, data);
        return perk !== undefined && data.length >= 5 ? [[perk, data[4] ?? 1]] : [];
      }),
    ),
    factions: new Map(
      record.fields.all('SNAM').flatMap((data): [number, number][] => {
        const faction = formAt(record, data);
        return faction !== undefined && data.length >= 5 ? [[faction, view(data).getInt8(4)]] : [];
      }),
    ),
    crimeFaction: formField(record, 'CRIF'),
    aiData: {
      aggression: ai?.[0] ?? 0,
      confidence: ai?.[1] ?? 2,
      energy: ai?.[2] ?? 50,
      morality: ai?.[3] ?? 3,
      mood: ai?.[4] ?? 0,
      assistance: ai?.[5] ?? 0,
      aggroRadius:
        aiView && ((ai?.[6] ?? 0) & 0x1) !== 0
          ? [aiView.getUint32(8, true), aiView.getUint32(12, true), aiView.getUint32(16, true)]
          : undefined,
    },
    deathItem: formField(record, 'INAM'),
    keywords: keywords(record),
    voiceType: formField(record, 'VTCK'),
    giftFilter: formField(record, 'GNAM'),
    combatStyle: formField(record, 'ZNAM'),
    outfit: formField(record, 'DOFT'),
    sleepOutfit: formField(record, 'SOFT'),
  };
}

export interface RaceStats {
  readonly formId: number;
  /** DATA: up to seven skill boosts (actor value index, bonus). */
  readonly skillBoosts: readonly { readonly actorValue: number; readonly bonus: number }[];
  readonly flags: number;
  readonly startingHealth: number;
  readonly startingMagicka: number;
  readonly startingStamina: number;
  readonly baseCarryWeight: number;
  readonly baseMass: number;
  readonly healthRegen: number;
  readonly magickaRegen: number;
  readonly staminaRegen: number;
  readonly unarmedDamage: number;
  readonly unarmedReach: number;
  /** SPLO: racial spells and abilities. */
  readonly spells: readonly number[];
  readonly keywords: readonly number[];
}

export function parseRaceStats(record: RecordSource): RaceStats {
  const data = record.fields.first('DATA');
  const d = data && data.length >= 104 ? view(data) : undefined;
  const skillBoosts: { actorValue: number; bonus: number }[] = [];
  for (let i = 0; data && d && i < 7; i++) {
    const actorValue = data[i * 2] ?? 0xff;
    if (actorValue !== 0xff) skillBoosts.push({ actorValue, bonus: d.getInt8(i * 2 + 1) });
  }
  return {
    formId: record.formId,
    skillBoosts,
    flags: d?.getUint32(32, true) ?? 0,
    startingHealth: d?.getFloat32(36, true) ?? 50,
    startingMagicka: d?.getFloat32(40, true) ?? 50,
    startingStamina: d?.getFloat32(44, true) ?? 50,
    baseCarryWeight: d?.getFloat32(48, true) ?? 300,
    baseMass: d?.getFloat32(52, true) ?? 1,
    healthRegen: d?.getFloat32(84, true) ?? 0,
    magickaRegen: d?.getFloat32(88, true) ?? 0,
    staminaRegen: d?.getFloat32(92, true) ?? 0,
    unarmedDamage: d?.getFloat32(96, true) ?? 0,
    unarmedReach: d?.getFloat32(100, true) ?? 0,
    spells: formList(record, 'SPLO'),
    keywords: keywords(record),
  };
}

/** RELA: a relationship between two NPCs (GetRelationshipRank: 4 lover .. −4 archnemesis). */
export interface Relationship {
  readonly parent: number;
  readonly child: number;
  /** As GetRelationshipRank returns it: 4 − the stored rank (0 lover .. 8 archnemesis). */
  readonly rank: number;
  readonly secret: boolean;
  readonly association: number | undefined;
}

export function parseRelationship(record: RecordSource): Relationship | undefined {
  const data = record.fields.first('DATA');
  if (!data || data.length < 12) return undefined;
  const parent = formAt(record, data, 0);
  const child = formAt(record, data, 4);
  if (parent === undefined || child === undefined) return undefined;
  const v = view(data);
  return {
    parent,
    child,
    rank: 4 - v.getUint16(8, true),
    secret: (v.getUint16(10, true) & 0x8000) !== 0,
    association: formAt(record, data, 12),
  };
}

/** FACT XNAM: how a faction regards another (combat reaction: 0 neutral, 1 enemy, 2 ally, 3 friend). */
export interface FactionReaction {
  readonly faction: number;
  readonly modifier: number;
  readonly combat: number;
}

export interface FactionRecord {
  readonly formId: number;
  /** DATA flags (hidden from the player 0x1, special combat 0x2, track crime 0x40, ...). */
  readonly flags: number;
  readonly reactions: readonly FactionReaction[];
  /** RNAM ranks (their index). */
  readonly ranks: readonly number[];
  /** A vendor faction's trade (DATA flag 0x4000). */
  readonly vendor?: FactionVendor;
  /** A crime faction's jail and crime values (the Creation Kit's Crime tab), if it has them. */
  readonly crime?: FactionCrime;
}

/**
 * A crime faction's jail and crime gold (xEdit's FACT; CommonLibSSE TESFaction::CRIME_DATA):
 * JAIL the exterior jail marker (where the player is let out), WAIT the follower wait marker,
 * STOL the stolen goods container, PLCN the player inventory container (the evidence chest),
 * CRGR the shared crime faction list, JOUT the jail outfit, CRVA the values (arrest u8, attack
 * on sight u8, murder u16, assault u16, trespass u16, pickpocket u16, unused u16, steal
 * multiplier f32, escape u16, werewolf u16).
 */
export interface FactionCrime {
  readonly exteriorJailMarker: number | undefined;
  readonly followerWaitMarker: number | undefined;
  readonly stolenGoodsContainer: number | undefined;
  readonly playerInventoryContainer: number | undefined;
  readonly sharedCrimeFactions: number | undefined;
  readonly jailOutfit: number | undefined;
  readonly arrest: boolean;
  readonly attackOnSight: boolean;
  readonly murder: number;
  readonly assault: number;
  readonly trespass: number;
  readonly pickpocket: number;
  readonly stealMult: number;
  readonly escape: number;
  readonly werewolf: number;
}

/** What a vendor faction trades, where and when (UESP, xEdit's FACT). */
export interface FactionVendor {
  /** VENV: the hours its members trade (start .. end, past midnight wrapping). */
  readonly startHour: number;
  readonly endHour: number;
  /** VENV: how far from its location it trades. */
  readonly radius: number;
  /**
   * PLVD: where it trades (a package location: in a cell, near a reference, near its editor
   * location, anywhere it is).
   */
  readonly location: PackageLocation | undefined;
  /**
   * VENV: xEdit's "Only Buys Stolen Items": a fence, which buys stolen items too (set on the
   * Thieves Guild's fences, ServicesThievesGuild*, which buy everything else as well; UESP
   * "Skyrim:Fences"). Other vendors do not buy stolen items.
   */
  readonly onlyStolen: boolean;
  /** VENV: it buys what is not in its list (else what is). */
  readonly notInList: boolean;
  /** VEND: the list (FLST of keywords) of what it buys. */
  readonly list: number | undefined;
  /** VENC: the merchant container, its goods and gold. */
  readonly chest: number | undefined;
  /** The conditions under which it trades (CITC, then its CTDA). */
  readonly conditions: readonly Condition[];
}

/** A class (CLAS): the skill its members train others in, and how far (UESP CLAS DATA). */
export interface ClassRecord {
  readonly formId: number;
  /** DATA @4: the skill it trains (0 one-handed .. 17 enchanting); undefined: none. */
  readonly trainingSkill: number | undefined;
  /** DATA @5: the skill level its trainers teach up to. */
  readonly maxTrainingLevel: number;
}

export function parseClass(record: Pick<GameRecord, 'formId' | 'fields'>): ClassRecord {
  const data = record.fields.first('DATA');
  const skill = data && data.length >= 6 ? (data[4] ?? 0xff) : 0xff;
  return {
    formId: record.formId,
    trainingSkill: skill < SKILL_COUNT ? skill : undefined,
    maxTrainingLevel: data?.[5] ?? 0,
  };
}

/** FACT DATA flags. */
export const FactionFlag = { vendor: 0x4000 } as const;

export function parseFaction(record: RecordSource): FactionRecord {
  const data = record.fields.first('DATA');
  return {
    formId: record.formId,
    flags: data && data.length >= 4 ? view(data).getUint32(0, true) : 0,
    reactions: record.fields.all('XNAM').flatMap((xnam): FactionReaction[] => {
      const faction = formAt(record, xnam);
      if (faction === undefined || xnam.length < 12) return [];
      const v = view(xnam);
      return [{ faction, modifier: v.getInt32(4, true), combat: v.getUint32(8, true) }];
    }),
    ranks: record.fields
      .all('RNAM')
      .map((rnam) => (rnam.length >= 4 ? view(rnam).getUint32(0, true) : 0)),
    ...vendorOf(record, data),
    ...crimeOf(record),
  };
}

/** The crime fields of a FACT (FactionCrime), where it has a CRVA or a jail. */
function crimeOf(record: RecordSource): Pick<FactionRecord, 'crime'> {
  const crva = record.fields.first('CRVA');
  if (!crva && !record.fields.has('JAIL') && !record.fields.has('CRGR')) return {};
  const v = crva && crva.length >= 16 ? view(crva) : undefined;
  return {
    crime: {
      exteriorJailMarker: formField(record, 'JAIL'),
      followerWaitMarker: formField(record, 'WAIT'),
      stolenGoodsContainer: formField(record, 'STOL'),
      playerInventoryContainer: formField(record, 'PLCN'),
      sharedCrimeFactions: formField(record, 'CRGR'),
      jailOutfit: formField(record, 'JOUT'),
      arrest: (crva?.[0] ?? 0) !== 0,
      attackOnSight: (crva?.[1] ?? 0) !== 0,
      murder: v?.getUint16(2, true) ?? 0,
      assault: v?.getUint16(4, true) ?? 0,
      trespass: v?.getUint16(6, true) ?? 0,
      pickpocket: v?.getUint16(8, true) ?? 0,
      stealMult: v?.getFloat32(12, true) ?? 0,
      escape: v && crva && crva.length >= 18 ? v.getUint16(16, true) : 0,
      werewolf: v && crva && crva.length >= 20 ? v.getUint16(18, true) : 0,
    },
  };
}

/**
 * VEND the buy/sell list, VENC the merchant container, VENV (start hour u16, end hour u16,
 * radius u32, only buys stolen items u8, buys what is not in the list u8), and its conditions
 * (CITC, CTDA) after them.
 */
function vendorOf(
  record: RecordSource,
  data: Uint8Array | undefined,
): Pick<FactionRecord, 'vendor'> {
  const flags = data && data.length >= 4 ? view(data).getUint32(0, true) : 0;
  const venv = record.fields.first('VENV');
  if ((flags & FactionFlag.vendor) === 0 || !venv || venv.length < 10) return {};
  const v = view(venv);
  const plvd = record.fields.first('PLVD');
  const fields = record.fields.list;
  const conditions: Condition[] = [];
  const citc = fields.findIndex((field) => field.type === 'CITC');
  for (let index = citc + 1; citc >= 0 && index < fields.length; index++) {
    if (fields[index]?.type !== 'CTDA') continue;
    const condition = conditionAt(fields, index, record);
    if (condition) conditions.push(condition);
  }
  return {
    vendor: {
      startHour: v.getUint16(0, true),
      endHour: v.getUint16(2, true),
      radius: v.getUint32(4, true),
      location: plvd ? readLocation(record, plvd) : undefined,
      onlyStolen: v.getUint8(8) !== 0,
      notInList: v.getUint8(9) !== 0,
      list: formField(record, 'VEND'),
      chest: formField(record, 'VENC'),
      conditions,
    },
  };
}

/** A location's reference of a location reference type (LCTN ACSR/LCSR). */
export interface LocationReference {
  readonly type: number;
  readonly reference: number;
  /** The cell or worldspace it is in. */
  readonly space: number | undefined;
}

export interface LocationRecord {
  readonly formId: number;
  readonly parent: number | undefined;
  readonly keywords: readonly number[];
  /** Special references by type ("Boss", "MapMarker", ...): master's and added, less removed. */
  readonly references: readonly LocationReference[];
  /** Unique actors (NPC_ → its ACHR). */
  readonly uniques: ReadonlyMap<number, number>;
  /** Persistent actors of the location (ACHR). */
  readonly persistent: readonly number[];
  /** MNAM: the world location marker. */
  readonly marker: number | undefined;
  /** RNAM: the world location radius. */
  readonly radius: number;
  /** FNAM: the unreported crime faction. */
  readonly crimeFaction: number | undefined;
  readonly music: number | undefined;
}

/**
 * A location from every version of its record, in load order: the lists of its references
 * are the master's (LC**: LCPR, LCUN, LCSR) with what later plugins add (AC**) and remove
 * (RC**); a version that repeats the master lists replaces them. The rest is the last
 * version's. (Skyrim.esm keeps the lists; Dawnguard.esm's overrides carry only ACSR.)
 */
export function parseLocation(versions: readonly RecordSource[]): LocationRecord | undefined {
  const record = versions.at(-1);
  if (!record) return undefined;
  const references = new Map<number, LocationReference>();
  const uniques = new Map<number, number>();
  const persistent = new Set<number>();
  const forms = (source: RecordSource, type: string): number[] =>
    source.fields.all(type).flatMap((data) => {
      const list: number[] = [];
      for (let at = 0; at + 4 <= data.length; at += 4) {
        const formId = formAt(source, data, at);
        if (formId !== undefined) list.push(formId);
      }
      return list;
    });
  const special = (source: RecordSource, type: string): void => {
    for (const data of source.fields.all(type)) {
      for (let at = 0; at + 16 <= data.length; at += 16) {
        const refType = formAt(source, data, at);
        const reference = formAt(source, data, at + 4);
        if (refType === undefined || reference === undefined) continue;
        references.set(reference, {
          type: refType,
          reference,
          space: formAt(source, data, at + 8),
        });
      }
    }
  };
  const unique = (source: RecordSource, type: string): void => {
    for (const data of source.fields.all(type)) {
      for (let at = 0; at + 12 <= data.length; at += 12) {
        const npc = formAt(source, data, at);
        const actor = formAt(source, data, at + 4);
        if (npc !== undefined && actor !== undefined) uniques.set(npc, actor);
      }
    }
  };
  const actors = (source: RecordSource, type: string): void => {
    for (const data of source.fields.all(type)) {
      for (let at = 0; at + 12 <= data.length; at += 12) {
        const actor = formAt(source, data, at);
        if (actor !== undefined) persistent.add(actor);
      }
    }
  };
  for (const version of versions) {
    if (version.fields.has('LCSR')) references.clear();
    if (version.fields.has('LCUN')) uniques.clear();
    if (version.fields.has('LCPR')) persistent.clear();
    special(version, 'LCSR');
    special(version, 'ACSR');
    unique(version, 'LCUN');
    unique(version, 'ACUN');
    actors(version, 'LCPR');
    actors(version, 'ACPR');
    for (const removed of forms(version, 'RCSR')) references.delete(removed);
    for (const removed of forms(version, 'RCUN')) uniques.delete(removed);
    for (const removed of forms(version, 'RCPR')) persistent.delete(removed);
  }
  const rnam = record.fields.first('RNAM');
  return {
    formId: record.formId,
    parent: formField(record, 'PNAM'),
    keywords: keywords(record),
    references: [...references.values()],
    uniques,
    persistent: [...persistent],
    marker: formField(record, 'MNAM'),
    radius: rnam && rnam.length >= 4 ? view(rnam).getFloat32(0, true) : 0,
    crimeFaction: formField(record, 'FNAM'),
    music: formField(record, 'NAM1'),
  };
}
