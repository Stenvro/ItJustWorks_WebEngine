// Magic effects (MGEF): what an effect of a potion, a scroll, a spell or an enchantment does,
// and what the menus show of it. An effect's description (DNAM) names its magnitude and
// duration with <mag> and <dur> (and its area with <area>), filled in with the item's values
// (Creation Kit: "Magic Effect"). DATA (152 bytes, xEdit wbDefinitionsTES5 MGEF; the members in
// memory: CommonLibSSE EffectSetting::EffectSettingData): its flags (hostile, recover,
// detrimental, no duration / magnitude / area, hidden from the interface, ...), base cost, the
// form its archetype uses (a summon's NPC_, a bound weapon, a cloak's spell, a light), magic
// skill, resist value, archetype and actor values, the shaders and art shown on the target, the
// image-space modifier while it lasts, an equip ability; KWDA its keywords, ESCE its counter
// effects, SNDD its sounds, CTDA its own conditions. Platform-independent.
// Notes: docs/formats/esm.md ("Items"), docs/gameplay.md ("Magic effects").

import { view } from '../formats/esm/fields.ts';
import { conditionAt, type Condition } from '../scripting/conditions.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'text' | 'formIdAt'>;

/** MGEF DATA flags (xEdit; CommonLibSSE EffectSettingData::Flag). */
export const EffectFlag = {
  hostile: 0x1,
  /** What it changed of an actor value is undone as it ends (Fortify, abilities). */
  recover: 0x2,
  /** Its magnitude is taken from the actor value, not added (Damage, poisons). */
  detrimental: 0x4,
  snapToNavmesh: 0x8,
  noHitEvent: 0x10,
  /** It dispels the target's effects that share one of its keywords. */
  dispelWithKeywords: 0x100,
  noDuration: 0x200,
  noMagnitude: 0x400,
  noArea: 0x800,
  /** Its visuals last as long as it does. */
  fxPersist: 0x1000,
  goryVisuals: 0x4000,
  hideInUi: 0x8000,
  /** It cannot be cast on a target that has it already. */
  noRecast: 0x20000,
  powerAffectsMagnitude: 0x200000,
  powerAffectsDuration: 0x400000,
  painless: 0x4000000,
  noHitEffect: 0x8000000,
  /** It stays on an actor that dies. */
  noDeathDispel: 0x10000000,
} as const;

/** MGEF DATA archetypes (xEdit; CommonLibSSE EffectArchetypes::ArchetypeID). */
export const EffectArchetype = {
  valueModifier: 0,
  script: 1,
  dispel: 2,
  cureDisease: 3,
  absorb: 4,
  dualValueModifier: 5,
  calm: 6,
  demoralize: 7,
  frenzy: 8,
  disarm: 9,
  commandSummoned: 10,
  invisibility: 11,
  light: 12,
  darkness: 13,
  nightEye: 14,
  lock: 15,
  open: 16,
  boundWeapon: 17,
  summonCreature: 18,
  detectLife: 19,
  telekinesis: 20,
  paralysis: 21,
  reanimate: 22,
  soulTrap: 23,
  turnUndead: 24,
  guide: 25,
  werewolfFeed: 26,
  cureParalysis: 27,
  cureAddiction: 28,
  curePoison: 29,
  concussion: 30,
  valueAndParts: 31,
  accumulateMagnitude: 32,
  stagger: 33,
  peakValueModifier: 34,
  cloak: 35,
  werewolf: 36,
  slowTime: 37,
  rally: 38,
  enhanceWeapon: 39,
  spawnHazard: 40,
  etherealize: 41,
  banish: 42,
  spawnScriptedRef: 43,
  disguise: 44,
  grabActor: 45,
  vampireLord: 46,
} as const;

/** The archetypes' names (the Creation Kit's), by archetype. */
export const ARCHETYPE_NAMES: readonly string[] = [
  'Value Modifier',
  'Script',
  'Dispel',
  'Cure Disease',
  'Absorb',
  'Dual Value Modifier',
  'Calm',
  'Demoralize',
  'Frenzy',
  'Disarm',
  'Command Summoned',
  'Invisibility',
  'Light',
  'Darkness',
  'Night Eye',
  'Lock',
  'Open',
  'Bound Weapon',
  'Summon Creature',
  'Detect Life',
  'Telekinesis',
  'Paralysis',
  'Reanimate',
  'Soul Trap',
  'Turn Undead',
  'Guide',
  'Werewolf Feed',
  'Cure Paralysis',
  'Cure Addiction',
  'Cure Poison',
  'Concussion',
  'Value and Parts',
  'Accumulate Magnitude',
  'Stagger',
  'Peak Value Modifier',
  'Cloak',
  'Werewolf',
  'Slow Time',
  'Rally',
  'Enhance Weapon',
  'Spawn Hazard',
  'Etherealize',
  'Banish',
  'Spawn Scripted Ref',
  'Disguise',
  'Grab Actor',
  'Vampire Lord',
];

/** SNDD sound types (xEdit wbMagicEffectSounds). */
export const EffectSound = {
  sheatheDraw: 0,
  charge: 1,
  ready: 2,
  release: 3,
  concentrationLoop: 4,
  onHit: 5,
} as const;

export interface MagicEffectRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly name: string;
  /** DNAM: the description, with <mag>, <dur>, <area> where the values go. */
  readonly description: string;
  readonly flags: number;
  readonly baseCost: number;
  /** The form its archetype uses: a summon's NPC_, a bound weapon, a cloak's SPEL, a LIGH. */
  readonly associatedItem: number | undefined;
  /** The magic skill it belongs to (an actor value index; -1 none). */
  readonly skill: number;
  /** The actor value that resists it (FireResist, PoisonResist, ...; -1 none). */
  readonly resistValue: number;
  /** The light it casts (Candlelight). */
  readonly light: number | undefined;
  readonly taperWeight: number;
  /** EFSH on the target (hit), and on an enchanted item. */
  readonly hitShader: number | undefined;
  readonly enchantShader: number | undefined;
  /** DATA: the skill level it needs (its spells' level: novice 0 .. master 100). */
  readonly minimumSkill: number;
  readonly taperCurve: number;
  readonly taperDuration: number;
  /** The second actor value's share of the magnitude (Dual Value Modifier: frost's stamina). */
  readonly secondValueWeight: number;
  /** DATA: its archetype (value modifier, script, ...) and the actor values it changes. */
  readonly archetype: number;
  readonly actorValue: number;
  readonly secondActorValue: number;
  readonly projectile: number | undefined;
  readonly explosion: number | undefined;
  /** Casting type (0 constant, 1 fire and forget, 2 concentration) and delivery (0 self ..). */
  readonly castingType: number;
  readonly delivery: number;
  /** ARTO: on the caster's hands, on the target, on an enchanted item. */
  readonly castingArt: number | undefined;
  readonly hitEffectArt: number | undefined;
  readonly enchantArt: number | undefined;
  readonly impactData: number | undefined;
  readonly skillUsageMult: number;
  /** DUAL: the dual-cast art, and its scale. */
  readonly dualCastArt: number | undefined;
  readonly dualCastScale: number;
  /** RFCT: the visual effect on the target, and on an enchanted item. */
  readonly hitVisuals: number | undefined;
  readonly enchantVisuals: number | undefined;
  /** SPEL: the ability its enchanted item's wearer has. */
  readonly equipAbility: number | undefined;
  /** IMAD: on the screen while it lasts on the player. */
  readonly imageSpaceModifier: number | undefined;
  readonly perk: number | undefined;
  readonly castingSoundLevel: number;
  readonly keywords: readonly number[];
  /** ESCE: the effects it dispels. */
  readonly counterEffects: readonly number[];
  /** SNDD: sounds by EffectSound type. */
  readonly sounds: readonly { readonly type: number; readonly sound: number }[];
  /** CTDA: its own conditions (on the target; run on "target": the caster). */
  readonly conditions: readonly Condition[];
  /** VMAD: it runs scripts (as an ActiveMagicEffect). */
  readonly scripted: boolean;
}

export function parseMagicEffect(record: RecordSource): MagicEffectRecord {
  const data = record.fields.first('DATA');
  const d = data && data.length >= 72 ? view(data) : undefined;
  const full = data && data.length >= 152 ? data : undefined;
  const form = (at: number): number | undefined => {
    if (!full) return undefined;
    const formId = record.formIdAt(full, at);
    return formId === 0 ? undefined : formId;
  };
  const f32 = (at: number): number => (full ? view(full).getFloat32(at, true) : 0);
  const i32 = (at: number, fallback: number): number =>
    full ? view(full).getInt32(at, true) : fallback;
  const keywords: number[] = [];
  for (const kwda of record.fields.all('KWDA')) {
    for (let at = 0; at + 4 <= kwda.length; at += 4) keywords.push(record.formIdAt(kwda, at));
  }
  const sounds: { type: number; sound: number }[] = [];
  for (const sndd of record.fields.all('SNDD')) {
    for (let at = 0; at + 8 <= sndd.length; at += 8)
      sounds.push({ type: view(sndd).getUint32(at, true), sound: record.formIdAt(sndd, at + 4) });
  }
  const conditions: Condition[] = [];
  const fields = record.fields.list;
  for (let i = 0; i < fields.length; i++) {
    const condition = conditionAt(fields, i, record);
    if (condition) conditions.push(condition);
  }
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    name: record.text('FULL') ?? '',
    description: record.text('DNAM') ?? '',
    flags: d?.getUint32(0, true) ?? 0,
    baseCost: d?.getFloat32(4, true) ?? 0,
    associatedItem: form(8),
    skill: d?.getInt32(12, true) ?? -1,
    resistValue: i32(16, -1),
    light: form(24),
    taperWeight: f32(28),
    hitShader: form(32),
    enchantShader: form(36),
    minimumSkill: d?.getUint32(40, true) ?? 0,
    taperCurve: f32(52),
    taperDuration: f32(56),
    secondValueWeight: f32(60),
    archetype: d?.getUint32(64, true) ?? 0,
    actorValue: d?.getInt32(68, true) ?? -1,
    projectile: form(72),
    explosion: form(76),
    castingType: i32(80, 0),
    delivery: i32(84, 0),
    secondActorValue: i32(88, -1),
    castingArt: form(92),
    hitEffectArt: form(96),
    impactData: form(100),
    skillUsageMult: f32(104),
    dualCastArt: form(108),
    dualCastScale: f32(112),
    enchantArt: form(116),
    hitVisuals: form(120),
    enchantVisuals: form(124),
    equipAbility: form(128),
    imageSpaceModifier: form(132),
    perk: form(136),
    castingSoundLevel: i32(140, 0),
    keywords,
    counterEffects: record.fields
      .all('ESCE')
      .filter((esce) => esce.length >= 4)
      .map((esce) => record.formIdAt(esce)),
    sounds,
    conditions,
    scripted: record.fields.has('VMAD'),
  };
}

/** Its sound of a type (SNDD), if it has one. */
export function effectSound(effect: MagicEffectRecord, type: number): number | undefined {
  return effect.sounds.find((entry) => entry.type === type)?.sound;
}

/**
 * An effect's description with its values filled in: <mag> the magnitude, <dur> the duration
 * (seconds), <area> the area (feet), each a whole number.
 */
export function effectText(
  effect: Pick<MagicEffectRecord, 'description'>,
  magnitude: number,
  duration: number,
  area: number,
): string {
  const whole = (value: number): string => String(Math.round(value));
  return effect.description
    .replace(/<mag>/gi, whole(magnitude))
    .replace(/<dur>/gi, whole(duration))
    .replace(/<area>/gi, whole(area));
}
