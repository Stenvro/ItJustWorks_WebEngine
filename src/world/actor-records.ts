// Records that make up an actor's look: the actor base (NPC_), its race (RACE), what it wears
// (ARMO and their armor addons ARMA, outfits OTFT), leveled lists (LVLN, LVLI), hair colours
// (CLFM) and head parts (HDPT). Layouts: UESP "Skyrim Mod:Mod File Format" and xEdit's
// wbDefinitionsTES5; notes in docs/formats/esm.md ("Actors"). Platform-independent.

import { view, zstring } from '../formats/esm/fields.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'type' | 'editorId' | 'fields' | 'formIdAt'>;

/** NPC_ ACBS flags. */
export const NpcFlag = {
  female: 0x1,
  essential: 0x2,
  isCharGenFacePreset: 0x4,
  respawn: 0x8,
  autoCalcStats: 0x10,
  unique: 0x20,
  pcLevelMult: 0x80,
  protected: 0x800,
  oppositeGenderAnimations: 0x80000,
  simpleActor: 0x100000,
  ghost: 0x20000000,
  invulnerable: 0x80000000,
} as const;

/** NPC_ ACBS template data flags: what an actor takes from its template (TPLT). */
export const TemplateFlag = {
  traits: 0x1,
  stats: 0x2,
  factions: 0x4,
  spells: 0x8,
  aiData: 0x10,
  aiPackages: 0x20,
  baseData: 0x80,
  inventory: 0x100,
  script: 0x200,
  defaultPackages: 0x400,
  attackData: 0x800,
  keywords: 0x1000,
} as const;

/** RACE DATA flags. */
export const RaceFlag = {
  playable: 0x1,
  faceGenHead: 0x2,
  child: 0x4,
  /** Leans with the ground along its length (four-legged animals). */
  tiltFrontBack: 0x8,
  /** Leans with the ground across too (spiders, chaurus, mudcrabs, mammoths). */
  tiltLeftRight: 0x10,
  noShadow: 0x20,
  swims: 0x40,
  flies: 0x80,
  walks: 0x100,
} as const;

/** Biped object slots (BOD2 / BODT flags): bit i is slot 30 + i. */
export const BipedSlot = {
  head: 30,
  hair: 31,
  body: 32,
  hands: 33,
  forearms: 34,
  amulet: 35,
  ring: 36,
  feet: 37,
  calves: 38,
  shield: 39,
  tail: 40,
  longHair: 41,
  circlet: 42,
  ears: 43,
  decapitateHead: 50,
  decapitate: 51,
  fx01: 61,
} as const;

export const slotBit = (slot: number): number => 2 ** (slot - 30);

export interface InventoryItem {
  readonly item: number;
  readonly count: number;
}

export interface NpcRecord {
  readonly formId: number;
  readonly editorId: string;
  /** ACBS flags (NpcFlag). */
  readonly flags: number;
  /** ACBS template data flags (TemplateFlag). */
  readonly templateFlags: number;
  /** Level, or the level multiplier × 1000 with NpcFlag.pcLevelMult. */
  readonly level: number;
  /** TPLT: the template (NPC_ or LVLN) it takes what its template flags say from. */
  readonly template: number | undefined;
  readonly race: number | undefined;
  /** WNAM: its own skin (ARMO), replacing the race's. */
  readonly skin: number | undefined;
  /** DOFT and SOFT: default and sleep outfit (OTFT). */
  readonly outfit: number | undefined;
  readonly sleepOutfit: number | undefined;
  /** PNAM: head parts (HDPT). */
  readonly headParts: readonly number[];
  /** VTCK: voice type (VTYP; its editor id names the folder of its spoken lines). */
  readonly voiceType: number | undefined;
  /** HCLF: hair colour (CLFM). */
  readonly hairColor: number | undefined;
  /** FTST: head texture set (TXST). */
  readonly faceTexture: number | undefined;
  /** QNAM: skin tone (0..1 per channel). */
  readonly skinTone: readonly [number, number, number] | undefined;
  /** NAM6: height multiplier. NAM7: weight (0..100). */
  readonly height: number;
  readonly weight: number;
  /** CNTO: the inventory. */
  readonly items: readonly InventoryItem[];
}

export interface RaceRecord {
  readonly formId: number;
  readonly editorId: string;
  /** DATA flags (RaceFlag). */
  readonly flags: number;
  /** DATA: height and weight of [male, female]. */
  readonly height: readonly [number, number];
  readonly weight: readonly [number, number];
  /** WNAM: the race's skin (ARMO). */
  readonly skin: number | undefined;
  /** ANAM under MNAM / FNAM: skeleton models of [male, female] (female falls back to male). */
  readonly skeleton: readonly [string | undefined, string | undefined];
  /** NAM3 MODL under MNAM / FNAM: behavior projects of [male, female] (Havok, .hkx). */
  readonly behavior: readonly [string | undefined, string | undefined];
  /** HCLF: default hair colour of [male, female]. */
  readonly hairColor: readonly [number | undefined, number | undefined];
  /** Head data (NAM0): default head parts of [male, female]. */
  readonly headParts: readonly [readonly number[], readonly number[]];
  /** DFTM / DFTF: default face texture of [male, female] (TXST). */
  readonly faceTexture: readonly [number | undefined, number | undefined];
  /** RNAM: the race whose armor addons it wears. */
  readonly armorRace: number | undefined;
  /** NAM8: the race whose morphs (.tri) it uses. */
  readonly morphRace: number | undefined;
}

export interface ArmorRecord {
  readonly formId: number;
  readonly editorId: string;
  /** BOD2 / BODT: the biped slots it covers. */
  readonly slots: number;
  /** MODL: its armor addons (ARMA). */
  readonly addons: readonly number[];
  /** TNAM: the armor it takes its addons from when it lists none. */
  readonly template: number | undefined;
}

/** An addon model with the texture sets it swaps in by shape (MO2S..MO5S). */
export interface AddonModel {
  readonly path: string;
  readonly alternateTextures: readonly AlternateTexture[];
}

/** A texture set replacing the textures of a model's shape. */
export interface AlternateTexture {
  /** The shape's name (its 3D name). */
  readonly shape: string;
  readonly textureSet: number;
  /** The shape's index among the model's shapes. */
  readonly index: number;
}

export interface ArmorAddonRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly slots: number;
  /** RNAM: primary race; MODL: the other races it fits. */
  readonly race: number | undefined;
  readonly races: readonly number[];
  /** DNAM: priority of [male, female] (the higher one owns a shared slot). */
  readonly priority: readonly [number, number];
  /** DNAM: weight slider of [male, female]: _0 and _1 models blended by the actor's weight. */
  readonly weighted: readonly [boolean, boolean];
  /** World models of [male, female] (MOD2, MOD3; the female falls back to the male). */
  readonly models: readonly [AddonModel | undefined, AddonModel | undefined];
  /** First-person models of [male, female] (MOD4, MOD5). */
  readonly firstPerson: readonly [AddonModel | undefined, AddonModel | undefined];
  /** NAM0 / NAM1: the skin texture set of [male, female] (TXST). */
  readonly skinTexture: readonly [number | undefined, number | undefined];
  /** DNAM f32 at 8: how far the armour pushes sheathed weapons out (0..1). */
  readonly weaponAdjust: number;
  /** SNDD: its footstep set (FSTS). */
  readonly footstepSet: number | undefined;
}

export interface LeveledEntry {
  readonly level: number;
  readonly formId: number;
  readonly count: number;
}

/** LVLF flags. */
export const LeveledFlag = {
  allLevels: 0x1,
  eachItem: 0x2,
  useAll: 0x4,
  specialLoot: 0x8,
} as const;

export interface LeveledList {
  readonly formId: number;
  readonly editorId: string;
  /** LVLD: percent chance that it gives nothing. */
  readonly chanceNone: number;
  /** LVLG: a global that holds the chance instead (GLOB). */
  readonly chanceGlobal: number | undefined;
  readonly flags: number;
  readonly entries: readonly LeveledEntry[];
}

/** HDPT PNAM. */
export const HeadPartType = {
  misc: 0,
  face: 1,
  eyes: 2,
  hair: 3,
  facialHair: 4,
  scar: 5,
  eyebrows: 6,
} as const;

/** HDPT NAM0: what a head part's NAM1 file is. */
export const HeadPartFile = {
  raceMorph: 0,
  /** Expressions: phonemes, blinks, looks, moods (src/formats/nif/tri.ts). */
  tri: 1,
  chargenMorph: 2,
} as const;

export interface HeadPartRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly type: number;
  /** HNAM: parts that come with it. */
  readonly extraParts: readonly number[];
  readonly model: string | undefined;
  /** NAM0 + NAM1: its morph files (HeadPartFile), paths under meshes. */
  readonly files: readonly { readonly type: number; readonly path: string }[];
  /** TNAM: texture set; CNAM: colour (CLFM). */
  readonly textureSet: number | undefined;
  readonly color: number | undefined;
}

const formOf = (
  record: RecordSource,
  data: Uint8Array | undefined,
  offset = 0,
): number | undefined => {
  if (!data || data.length < offset + 4) return undefined;
  const formId = record.formIdAt(data, offset);
  return formId === 0 ? undefined : formId;
};

/** A text field's value, undefined when absent or empty. */
const nonEmpty = (text: string | undefined): string | undefined => (text === '' ? undefined : text);

const field = (record: RecordSource, type: string): number | undefined =>
  formOf(record, record.fields.first(type));

/** BOD2 (slots u32, armor type u32) or the older BODT (slots u32, flags, armor type). */
function bipedSlots(record: RecordSource): number {
  const data = record.fields.first('BOD2') ?? record.fields.first('BODT');
  return data && data.length >= 4 ? view(data).getUint32(0, true) : 0;
}

export function parseNpc(record: RecordSource): NpcRecord {
  const acbs = record.fields.first('ACBS');
  const acbsView = acbs && acbs.length >= 24 ? view(acbs) : undefined;
  const qnam = record.fields.first('QNAM');
  const items: InventoryItem[] = [];
  for (const cnto of record.fields.all('CNTO')) {
    const item = formOf(record, cnto);
    if (item !== undefined && cnto.length >= 8) {
      items.push({ item, count: view(cnto).getInt32(4, true) });
    }
  }
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    flags: acbsView?.getUint32(0, true) ?? 0,
    templateFlags: acbsView?.getUint16(18, true) ?? 0,
    level: acbsView?.getUint16(8, true) ?? 1,
    template: field(record, 'TPLT'),
    race: field(record, 'RNAM'),
    skin: field(record, 'WNAM'),
    outfit: field(record, 'DOFT'),
    sleepOutfit: field(record, 'SOFT'),
    headParts: record.fields
      .all('PNAM')
      .map((data) => formOf(record, data))
      .filter((formId): formId is number => formId !== undefined),
    voiceType: field(record, 'VTCK'),
    hairColor: field(record, 'HCLF'),
    faceTexture: field(record, 'FTST'),
    skinTone:
      qnam && qnam.length >= 12
        ? [
            view(qnam).getFloat32(0, true),
            view(qnam).getFloat32(4, true),
            view(qnam).getFloat32(8, true),
          ]
        : undefined,
    height: record.fields.f32('NAM6') ?? 1,
    weight: record.fields.f32('NAM7') ?? 0,
    items,
  };
}

export function parseRace(record: RecordSource): RaceRecord {
  const data = record.fields.first('DATA');
  const dataView = data && data.length >= 36 ? view(data) : undefined;
  const skeleton: [string | undefined, string | undefined] = [undefined, undefined];
  const behavior: [string | undefined, string | undefined] = [undefined, undefined];
  const headParts: [number[], number[]] = [[], []];
  const faceTexture: [number | undefined, number | undefined] = [undefined, undefined];
  let armorRace: number | undefined;
  let morphRace: number | undefined;
  // MNAM and FNAM mark the male and female halves of the section they follow: the top level
  // (skeletons), NAM1 (body textures), NAM3 (behavior projects) and NAM0 (head data).
  let section = 'top';
  let sex = 0;
  for (const { type, data: value } of record.fields.list) {
    switch (type) {
      case 'NAM0':
      case 'NAM1':
      case 'NAM3':
        section = type;
        sex = 0;
        break;
      case 'MNAM':
        if (value.length === 0) sex = 0;
        break;
      case 'FNAM':
        if (value.length === 0) sex = 1;
        break;
      case 'ANAM':
        if (section === 'top') skeleton[sex] = zstring(value) || undefined;
        break;
      case 'MODL':
        if (section === 'NAM3') behavior[sex] = zstring(value) || undefined;
        break;
      case 'HEAD': {
        const part = formOf(record, value);
        if (section === 'NAM0' && part !== undefined) headParts[sex]?.push(part);
        break;
      }
      case 'DFTM':
        faceTexture[0] = formOf(record, value);
        break;
      case 'DFTF':
        faceTexture[1] = formOf(record, value);
        break;
      case 'RNAM':
        armorRace = formOf(record, value);
        break;
      case 'NAM8':
        morphRace = formOf(record, value);
        break;
    }
  }
  const hclf = record.fields.first('HCLF');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    flags: dataView?.getUint32(32, true) ?? 0,
    height: [dataView?.getFloat32(16, true) ?? 1, dataView?.getFloat32(20, true) ?? 1],
    weight: [dataView?.getFloat32(24, true) ?? 1, dataView?.getFloat32(28, true) ?? 1],
    skin: field(record, 'WNAM'),
    skeleton: [skeleton[0], skeleton[1] ?? skeleton[0]],
    behavior: [behavior[0], behavior[1] ?? behavior[0]],
    hairColor: [formOf(record, hclf, 0), formOf(record, hclf, 4)],
    headParts,
    faceTexture,
    armorRace,
    morphRace,
  };
}

export function parseArmor(record: RecordSource): ArmorRecord {
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    slots: bipedSlots(record),
    addons: record.fields
      .all('MODL')
      .map((data) => formOf(record, data))
      .filter((formId): formId is number => formId !== undefined),
    template: field(record, 'TNAM'),
  };
}

/**
 * MO2S..MO5S: count (u32), then per entry the shape name (u32 length + text), the texture
 * set (form id) and the shape's index (u32).
 */
function alternateTextures(record: RecordSource, data: Uint8Array | undefined): AlternateTexture[] {
  if (!data || data.length < 4) return [];
  const dataView = view(data);
  const count = dataView.getUint32(0, true);
  const out: AlternateTexture[] = [];
  let at = 4;
  for (let i = 0; i < count && at + 4 <= data.length; i++) {
    const length = dataView.getUint32(at, true);
    at += 4;
    if (at + length + 8 > data.length) break;
    const shape = String.fromCharCode(...data.subarray(at, at + length)).replace(/\0+$/, '');
    at += length;
    const textureSet = formOf(record, data, at);
    const index = dataView.getUint32(at + 4, true);
    at += 8;
    if (textureSet !== undefined) out.push({ shape, textureSet, index });
  }
  return out;
}

export function parseArmorAddon(record: RecordSource): ArmorAddonRecord {
  const dnam = record.fields.first('DNAM');
  const model = (type: string, swaps: string): AddonModel | undefined => {
    const path = record.fields.zstring(type);
    return path
      ? { path, alternateTextures: alternateTextures(record, record.fields.first(swaps)) }
      : undefined;
  };
  const male = model('MOD2', 'MO2S');
  const maleFirst = model('MOD4', 'MO4S');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    slots: bipedSlots(record),
    race: field(record, 'RNAM'),
    races: record.fields
      .all('MODL')
      .map((data) => formOf(record, data))
      .filter((formId): formId is number => formId !== undefined),
    priority: [dnam?.[0] ?? 0, dnam?.[1] ?? 0],
    weighted: [((dnam?.[2] ?? 0) & 0x2) !== 0, ((dnam?.[3] ?? 0) & 0x2) !== 0],
    models: [male, model('MOD3', 'MO3S') ?? male],
    firstPerson: [maleFirst, model('MOD5', 'MO5S') ?? maleFirst],
    skinTexture: [field(record, 'NAM0'), field(record, 'NAM1')],
    weaponAdjust: dnam && dnam.length >= 12 ? view(dnam).getFloat32(8, true) : 0,
    footstepSet: field(record, 'SNDD'),
  };
}

/** OTFT INAM: the items (ARMO or LVLI) of an outfit. */
export function parseOutfit(record: RecordSource): number[] {
  const data = record.fields.first('INAM');
  const items: number[] = [];
  for (let at = 0; data && at + 4 <= data.length; at += 4) {
    const item = formOf(record, data, at);
    if (item !== undefined) items.push(item);
  }
  return items;
}

/** LVLN / LVLI: LVLO entries are level u16, unused u16, form id, count u16, unused u16. */
export function parseLeveledList(record: RecordSource): LeveledList {
  const entries: LeveledEntry[] = [];
  for (const lvlo of record.fields.all('LVLO')) {
    const formId = formOf(record, lvlo, 4);
    if (formId === undefined || lvlo.length < 10) continue;
    const entryView = view(lvlo);
    entries.push({
      level: entryView.getUint16(0, true),
      formId,
      count: entryView.getUint16(8, true),
    });
  }
  const lvld = record.fields.first('LVLD');
  const lvlf = record.fields.first('LVLF');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    chanceNone: lvld?.[0] ?? 0,
    chanceGlobal: field(record, 'LVLG'),
    flags: lvlf?.[0] ?? 0,
    entries,
  };
}

/** CLFM CNAM: an RGBA colour, as 0..1 RGB. */
export function parseColor(record: RecordSource): [number, number, number] {
  const data = record.fields.first('CNAM');
  return [(data?.[0] ?? 255) / 255, (data?.[1] ?? 255) / 255, (data?.[2] ?? 255) / 255];
}

/** NAM0 (the type) followed by NAM1 (the file), in order. */
function headPartFiles(record: RecordSource): { type: number; path: string }[] {
  const files: { type: number; path: string }[] = [];
  let type: number | undefined;
  for (const field of record.fields.list) {
    if (field.type === 'NAM0') {
      type = field.data.length >= 4 ? view(field.data).getUint32(0, true) : undefined;
    } else if (field.type === 'NAM1' && type !== undefined) {
      const path = zstring(field.data);
      if (path !== '') files.push({ type, path });
      type = undefined;
    }
  }
  return files;
}

export function parseHeadPart(record: RecordSource): HeadPartRecord {
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    type: record.fields.u32('PNAM') ?? HeadPartType.misc,
    extraParts: record.fields
      .all('HNAM')
      .map((data) => formOf(record, data))
      .filter((formId): formId is number => formId !== undefined),
    model: nonEmpty(record.fields.zstring('MODL')),
    files: headPartFiles(record),
    textureSet: field(record, 'TNAM'),
    color: field(record, 'CNAM'),
  };
}
