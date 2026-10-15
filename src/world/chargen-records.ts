// What character creation (the race menu) reads from the records: a race's head data per sex
// (face presets, hair colours, complexions, the face part types it offers, its tint layers) and
// an actor base's face (NAM9 morph values, NAMA face parts, tint layers). Layouts: UESP "Skyrim
// Mod:Mod File Format" (RACE, NPC_) and xEdit's wbDefinitionsTES5; notes in docs/formats/esm.md
// ("Character creation"). Platform-independent.

import { view, zstring } from '../formats/esm/fields.ts';
import { NpcFlag, RaceFlag, parseNpc } from './actor-records.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'type' | 'editorId' | 'fields' | 'formIdAt'> &
  Partial<Pick<GameRecord, 'text'>>;

/** RACE MPAI: which face part a MPAV bit set is about. */
export const MorphGroup = {
  nose: 0,
  brow: 1,
  eyes: 2,
  lips: 3,
} as const;

/** RACE TINP: what a tint layer is (absent: none, the layer is not editable). */
export const TintMaskType = {
  none: 0,
  lipColor: 1,
  cheekColor: 2,
  eyeliner: 3,
  eyeSocketUpper: 4,
  eyeSocketLower: 5,
  skinTone: 6,
  paint: 7,
  laughLines: 8,
  cheekColorLower: 9,
  nose: 10,
  chin: 11,
  neck: 12,
  forehead: 13,
  dirt: 14,
} as const;

/** One choice of a race tint layer: TINC colour (CLFM), TINV default value, TIRS its id. */
export interface RaceTintPreset {
  readonly color: number | undefined;
  /** 0..1. */
  readonly value: number;
  /** TIRS: what an actor's TIAS names. */
  readonly id: number;
}

/** A race tint layer: TINI, TINT, TINP, TIND, then its presets. */
export interface RaceTintLayer {
  /** TINI: the layer's index, which an actor's TINI names. */
  readonly index: number;
  /** TINT: the mask (a path under textures\), undefined when the layer has none. */
  readonly mask: string | undefined;
  /** TINP: TintMaskType. */
  readonly type: number;
  /** TIND: the default colour (CLFM). */
  readonly defaultColor: number | undefined;
  readonly presets: readonly RaceTintPreset[];
}

/** The head data of one sex of a race (NAM0 then MNAM or FNAM). */
export interface RaceSexChargen {
  /** HEAD (after INDX): default head parts. */
  readonly headParts: readonly number[];
  /** MPAI + MPAV: per MorphGroup the 8 words of available-type bits (bit n = type n). */
  readonly morphTypes: readonly (Uint32Array | undefined)[];
  /** RPRM / RPRF: the face presets (NPC_). */
  readonly presets: readonly number[];
  /** AHCM / AHCF: the hair colours to choose from (CLFM). */
  readonly hairColors: readonly number[];
  /** FTSM / FTSF: the complexions (TXST). */
  readonly faceDetails: readonly number[];
  /** DFTM / DFTF: the default complexion (TXST). */
  readonly defaultFaceTexture: number | undefined;
  /** TINI..TIRS, in stored order (ascending index). */
  readonly tintLayers: readonly RaceTintLayer[];
}

export interface RaceChargen {
  readonly formId: number;
  readonly editorId: string;
  /** FULL and DESC (the race menu's description). */
  readonly name: string;
  readonly description: string;
  /** DATA flags 0x1: offered by the race menu. */
  readonly playable: boolean;
  /** NAM8: the race whose morphs (the race morph in the head parts' race TRIs) it uses. */
  readonly morphRace: number | undefined;
  /** HCLF: default hair colour of [male, female]. */
  readonly defaultHairColor: readonly [number | undefined, number | undefined];
  readonly sexes: readonly [RaceSexChargen, RaceSexChargen];
}

/** An actor base's tint layer: TINI, TINC, TINV, TIAS. */
export interface NpcTintLayer {
  /** The race tint layer it paints (RaceTintLayer.index). */
  readonly index: number;
  /** TINC: RGB bytes (the fourth byte, alpha, is unused). */
  readonly color: readonly [number, number, number];
  /** TINV / 100: 0..1. */
  readonly value: number;
  /** TIAS: the race preset it was chosen from (RaceTintPreset.id), −1 none. */
  readonly preset: number;
}

/** NAM9: the 18 face slider values in −1..1 (MORPH_PAIRS in src/gameplay/chargen.ts). */
export const FACE_MORPH_COUNT = 18;

/** An actor base's face as character creation edits it. */
export interface NpcFace {
  readonly formId: number;
  readonly editorId: string;
  readonly female: boolean;
  readonly race: number | undefined;
  /** PNAM: its own head parts (the race's defaults fill the other types). */
  readonly headParts: readonly number[];
  /** HCLF (CLFM), FTST (TXST). */
  readonly hairColor: number | undefined;
  readonly faceTexture: number | undefined;
  /** QNAM: 0..1 RGB. */
  readonly skinTone: readonly [number, number, number] | undefined;
  /** NAM7: 0..100. */
  readonly weight: number;
  /** NAM9: FACE_MORPH_COUNT values (zeros without NAM9). */
  readonly morphs: readonly number[];
  /** NAMA: nose type, unknown (−1), eye type, mouth type. */
  readonly faceParts: readonly [number, number, number, number];
  readonly tints: readonly NpcTintLayer[];
}

const formOf = (record: RecordSource, data: Uint8Array): number | undefined => {
  if (data.length < 4) return undefined;
  const formId = record.formIdAt(data);
  return formId === 0 ? undefined : formId;
};

const u16 = (data: Uint8Array): number => (data.length >= 2 ? view(data).getUint16(0, true) : 0);

interface MutableSex {
  headParts: number[];
  morphTypes: (Uint32Array | undefined)[];
  presets: number[];
  hairColors: number[];
  faceDetails: number[];
  defaultFaceTexture: number | undefined;
  tintLayers: {
    index: number;
    mask: string | undefined;
    type: number;
    defaultColor: number | undefined;
    presets: { color: number | undefined; value: number; id: number }[];
  }[];
}

const emptySex = (): MutableSex => ({
  headParts: [],
  morphTypes: [],
  presets: [],
  hairColors: [],
  faceDetails: [],
  defaultFaceTexture: undefined,
  tintLayers: [],
});

/**
 * The race's head data. Everything after NAM0 belongs to the sex whose zero-length marker
 * (MNAM, FNAM) came last; RPRM / RPRF and the other paired fields name their sex themselves.
 */
export function parseRaceChargen(record: RecordSource): RaceChargen {
  const sexes: [MutableSex, MutableSex] = [emptySex(), emptySex()];
  let inHead = false;
  let sex = 0;
  let morphGroup: number | undefined;
  for (const { type, data } of record.fields.list) {
    if (type === 'NAM0' || type === 'NAM1' || type === 'NAM3') {
      inHead = type === 'NAM0';
      sex = 0;
      continue;
    }
    if (type === 'MNAM' && data.length === 0) sex = 0;
    if (type === 'FNAM' && data.length === 0) sex = 1;
    if (!inHead) continue;
    const head = sexes[sex as 0 | 1];
    const form = (): number | undefined => formOf(record, data);
    const layer = head.tintLayers.at(-1);
    switch (type) {
      case 'HEAD': {
        const part = form();
        if (part !== undefined) head.headParts.push(part);
        break;
      }
      case 'MPAI':
        morphGroup = data.length >= 4 ? view(data).getUint32(0, true) : undefined;
        break;
      case 'MPAV':
        if (morphGroup !== undefined && morphGroup < 4) {
          const words = new Uint32Array(Math.floor(data.length / 4));
          for (let i = 0; i < words.length; i++) words[i] = view(data).getUint32(i * 4, true);
          head.morphTypes[morphGroup] = words;
        }
        morphGroup = undefined;
        break;
      case 'RPRM':
      case 'RPRF': {
        const npc = form();
        if (npc !== undefined) sexes[type === 'RPRM' ? 0 : 1].presets.push(npc);
        break;
      }
      case 'AHCM':
      case 'AHCF': {
        const color = form();
        if (color !== undefined) sexes[type === 'AHCM' ? 0 : 1].hairColors.push(color);
        break;
      }
      case 'FTSM':
      case 'FTSF': {
        const set = form();
        if (set !== undefined) sexes[type === 'FTSM' ? 0 : 1].faceDetails.push(set);
        break;
      }
      case 'DFTM':
      case 'DFTF':
        sexes[type === 'DFTM' ? 0 : 1].defaultFaceTexture = form();
        break;
      case 'TINI':
        head.tintLayers.push({
          index: u16(data),
          mask: undefined,
          type: TintMaskType.none,
          defaultColor: undefined,
          presets: [],
        });
        break;
      case 'TINT':
        if (layer) layer.mask = zstring(data) || undefined;
        break;
      case 'TINP':
        if (layer) layer.type = u16(data);
        break;
      case 'TIND':
        if (layer) layer.defaultColor = form();
        break;
      case 'TINC':
        // A preset: TINC, then its TINV and TIRS (always present in the vanilla data).
        layer?.presets.push({ color: form(), value: 0, id: -1 });
        break;
      case 'TINV': {
        const preset = layer?.presets.at(-1);
        if (preset && data.length >= 4) preset.value = view(data).getFloat32(0, true);
        break;
      }
      case 'TIRS': {
        const preset = layer?.presets.at(-1);
        if (preset) preset.id = u16(data);
        break;
      }
    }
  }
  const dataField = record.fields.first('DATA');
  const flags = dataField && dataField.length >= 36 ? view(dataField).getUint32(32, true) : 0;
  const hclf = record.fields.first('HCLF');
  const hairAt = (offset: number): number | undefined =>
    hclf && hclf.length >= offset + 4 ? formOf(record, hclf.subarray(offset)) : undefined;
  const nam8 = record.fields.first('NAM8');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    name: record.text?.('FULL') ?? '',
    description: record.text?.('DESC') ?? '',
    playable: (flags & RaceFlag.playable) !== 0,
    morphRace: nam8 ? formOf(record, nam8) : undefined,
    defaultHairColor: [hairAt(0), hairAt(4)],
    sexes,
  };
}

/** The types a race offers for a MorphGroup: the set bits of its MPAV below `count`. */
export function availableMorphTypes(words: Uint32Array | undefined, count: number): number[] {
  const types: number[] = [];
  if (!words) return types;
  for (let type = 0; type < count && type < words.length * 32; type++) {
    if (((words[type >>> 5] ?? 0) >>> (type & 31)) & 1) types.push(type);
  }
  return types;
}

/** NPC_ tint layers: TINI starts one, TINC / TINV / TIAS fill it. */
function npcTints(record: RecordSource): NpcTintLayer[] {
  const layers: {
    index: number;
    color: [number, number, number];
    value: number;
    preset: number;
  }[] = [];
  for (const { type, data } of record.fields.list) {
    const layer = layers.at(-1);
    switch (type) {
      case 'TINI':
        layers.push({ index: u16(data), color: [0, 0, 0], value: 0, preset: -1 });
        break;
      case 'TINC':
        if (layer && data.length >= 3) layer.color = [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
        break;
      case 'TINV':
        if (layer && data.length >= 4) layer.value = view(data).getInt32(0, true) / 100;
        break;
      case 'TIAS':
        if (layer && data.length >= 2) layer.preset = view(data).getInt16(0, true);
        break;
    }
  }
  return layers;
}

export function parseNpcFace(record: RecordSource): NpcFace {
  const npc = parseNpc(record);
  const nam9 = record.fields.first('NAM9');
  const morphs = Array.from({ length: FACE_MORPH_COUNT }, (_, i) =>
    nam9 && nam9.length >= (i + 1) * 4 ? view(nam9).getFloat32(i * 4, true) : 0,
  );
  const nama = record.fields.first('NAMA');
  const part = (i: number, fallback: number): number =>
    nama && nama.length >= (i + 1) * 4 ? view(nama).getInt32(i * 4, true) : fallback;
  return {
    formId: npc.formId,
    editorId: npc.editorId,
    female: (npc.flags & NpcFlag.female) !== 0,
    race: npc.race,
    headParts: npc.headParts,
    hairColor: npc.hairColor,
    faceTexture: npc.faceTexture,
    skinTone: npc.skinTone,
    weight: npc.weight,
    morphs,
    faceParts: [part(0, 0), part(1, -1), part(2, 0), part(3, 0)],
    tints: npcTints(record),
  };
}
