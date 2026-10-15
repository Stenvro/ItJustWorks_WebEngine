// Character creation (the race menu, racesex_menu.swf): the player's appearance, the sliders
// the menu shows for a race and sex, what each slider does to the appearance, the morph weights
// that shape the head parts (FaceGen TRI morphs) and the face tint composite. Measured against
// the baked FaceGen heads and face tints of vanilla NPCs (tests/chargen.int.test.ts); notes in
// docs/formats/esm.md ("Character creation"). Platform-independent and synchronous: the records
// come in as ChargenRaceData (src/gameplay/chargen-catalog.ts).

import { normalizePath } from '../formats/paths.ts';
import { HeadPartType } from '../world/actor-records.ts';
import {
  FACE_MORPH_COUNT,
  MorphGroup,
  TintMaskType,
  type NpcFace,
  type NpcTintLayer,
  type RaceTintLayer,
  type RaceTintPreset,
} from '../world/chargen-records.ts';

/** RGB: bytes (0..255) for tint colours, 0..1 for the skin tone. */
export type Rgb = readonly [number, number, number];

/** NAMA slots. */
export const FacePart = {
  nose: 0,
  unknown: 1,
  eyes: 2,
  mouth: 3,
} as const;

/**
 * What the player looks like: an NPC_'s face data, kept apart from the Player record so the
 * look builder and the script natives (GetRace, GetSex) can read it (saved in M12).
 */
export interface PlayerAppearance {
  readonly race: number;
  /** 0 male, 1 female. */
  readonly sex: 0 | 1;
  /** NAM7: 0..100. */
  readonly weight: number;
  /** PNAM: the chosen head parts; the race's defaults fill the types not chosen. */
  readonly headParts: readonly number[];
  /** HCLF (CLFM). */
  readonly hairColor: number | undefined;
  /** QNAM: 0..1 RGB, also the body's skin tint. */
  readonly skinTone: Rgb;
  /** NAM9: FACE_MORPH_COUNT values in −1..1 (MORPH_PAIRS). */
  readonly faceMorphs: readonly number[];
  /** NAMA: nose type, unknown (−1), eye type, mouth type (FacePart). */
  readonly faceParts: readonly [number, number, number, number];
  /** Tint layers in ascending race layer index (the order they are composited in). */
  readonly tints: readonly NpcTintLayer[];
  /** FTST: the complexion (TXST; its TX04 is the face's detail map). */
  readonly complexion: number | undefined;
}

/** A colour form (CLFM) with its RGB bytes. */
export interface ChargenColor {
  readonly formId: number;
  readonly rgb: Rgb;
}

export interface ChargenTintPreset extends RaceTintPreset {
  /** The preset colour's RGB bytes. */
  readonly rgb: Rgb;
}

export interface ChargenTintLayer extends Omit<RaceTintLayer, 'presets'> {
  readonly presets: readonly ChargenTintPreset[];
  /** TIND's RGB bytes. */
  readonly defaultRgb: Rgb | undefined;
}

/** Everything the race menu needs to know about one race and sex. */
export interface ChargenRaceData {
  readonly race: number;
  readonly editorId: string;
  readonly name: string;
  readonly description: string;
  readonly sex: 0 | 1;
  /** Editor id of the race whose race morph shapes the head (NAM8, else the race itself). */
  readonly morphRace: string;
  /** Default head parts (RACE HEAD). */
  readonly defaultHeadParts: readonly number[];
  /** The parts the menu offers per HeadPartType, in record order. */
  readonly headPartLists: ReadonlyMap<number, readonly number[]>;
  /** HeadPartType of every head part (to find which part of a type an appearance has). */
  readonly headPartTypes: ReadonlyMap<number, number>;
  /** RPRM / RPRF faces. */
  readonly presets: readonly NpcFace[];
  readonly hairColors: readonly ChargenColor[];
  readonly defaultHairColor: number | undefined;
  /** FTSM / FTSF and DFTM / DFTF. */
  readonly faceDetails: readonly number[];
  readonly defaultFaceTexture: number | undefined;
  /** Per MorphGroup: the face part types offered, ascending. */
  readonly morphTypes: readonly (readonly number[])[];
  readonly tintLayers: readonly ChargenTintLayer[];
}

// --- Categories and sliders ---

/** Filter bits of the categories (a slider shows under a category when its flag & filter). */
export const ChargenCategory = {
  race: 0x2,
  body: 0x4,
  head: 0x8,
  face: 0x10,
  eyes: 0x20,
  brow: 0x40,
  mouth: 0x80,
  hair: 0x100,
} as const;

/** The category bar, in order (RACE 0, BODY 1, HEAD 2 are the movie's constants). */
export const CHARGEN_CATEGORIES: readonly { readonly label: string; readonly flag: number }[] = [
  { label: 'sRSMRace', flag: ChargenCategory.race },
  { label: 'sRSMBody', flag: ChargenCategory.body },
  { label: 'sRSMHead', flag: ChargenCategory.head },
  { label: 'sRSMFace', flag: ChargenCategory.face },
  { label: 'sRSMEyes', flag: ChargenCategory.eyes },
  { label: 'sRSMBrow', flag: ChargenCategory.brow },
  { label: 'sRSMMouth', flag: ChargenCategory.mouth },
  { label: 'sRSMHair', flag: ChargenCategory.hair },
];

/** The GameDelegate callbacks the sliders call with (value, slider id). */
export const SliderCallback = {
  /** The engine's own name: the vanilla movie hardcodes none for the sex slider. */
  sex: 'ChangeSex',
  headPreset: 'ChangeHeadPreset',
  tint: 'ChangeTintingMask',
  weight: 'ChangeWeight',
  faceDetails: 'ChangeFaceDetails',
  headPart: 'ChangeHeadPart',
  hairColor: 'ChangeHairColorPreset',
  faceType: 'ChangePreset',
  morph: 'ChangeDoubleMorph',
} as const;

/**
 * NAM9 index → the two TRI morphs its value drives (weight |value|): `negative` below 0,
 * `positive` above. Fitted on baked FaceGen heads; 2 (jaw height) and 15 (chin length) run
 * against their names: a negative value raises the jaw / chin.
 */
export const MORPH_PAIRS: readonly {
  readonly label: string;
  readonly negative: string;
  readonly positive: string;
}[] = [
  { label: 'sRSMNoseLength', negative: 'NoseShort', positive: 'NoseLong' },
  { label: 'sRSMNoseHeight', negative: 'NoseDown', positive: 'NoseUp' },
  { label: 'sRSMJawHeight', negative: 'JawUp', positive: 'JawDown' },
  { label: 'sRSMJawWidth', negative: 'JawNarrow', positive: 'JawWide' },
  { label: 'sRSMJawForward', negative: 'JawBack', positive: 'JawForward' },
  { label: 'sRSMCheekboneHeight', negative: 'CheeksDown', positive: 'CheeksUp' },
  { label: 'sRSMCheekboneWidth', negative: 'CheeksIn', positive: 'CheeksOut' },
  { label: 'sRSMEyeHeight', negative: 'EyesMoveDown', positive: 'EyesMoveUp' },
  { label: 'sRSMEyeWidth', negative: 'EyesMoveIn', positive: 'EyesMoveOut' },
  { label: 'sRSMBrowHeight', negative: 'BrowDown', positive: 'BrowUp' },
  { label: 'sRSMBrowWidth', negative: 'BrowIn', positive: 'BrowOut' },
  { label: 'sRSMBrowForward', negative: 'BrowBack', positive: 'BrowForward' },
  { label: 'sRSMMouthHeight', negative: 'LipMoveDown', positive: 'LipMoveUp' },
  { label: 'sRSMMouthForward', negative: 'LipMoveIn', positive: 'LipMoveOut' },
  { label: 'sRSMChinWidth', negative: 'ChinThin', positive: 'ChinWide' },
  { label: 'sRSMChinLength', negative: 'ChinMoveUp', positive: 'ChinMoveDown' },
  { label: 'sRSMChinForward', negative: 'Overbite', positive: 'Underbite' },
  { label: 'sRSMEyeDepth', negative: 'EyesBack', positive: 'EyesForward' },
];

/** The morph name prefix of each face part type slider (NAMA value n → `<prefix><n>`). */
const FACE_TYPE_MORPH: readonly { readonly slot: number; readonly prefix: string }[] = [
  { slot: FacePart.nose, prefix: 'NoseType' },
  { slot: FacePart.eyes, prefix: 'EyesType' },
  { slot: FacePart.mouth, prefix: 'LipType' },
];

/** What a slider edits. */
export type SliderSpec =
  | { readonly kind: 'sex' }
  | { readonly kind: 'headPreset' }
  | { readonly kind: 'weight' }
  | { readonly kind: 'complexion' }
  | { readonly kind: 'hairColor' }
  | { readonly kind: 'headPart'; readonly partType: number }
  /** Steps through the presets of the race's one layer of a TintMaskType. */
  | { readonly kind: 'tint'; readonly tint: number }
  /** Picks one of the layers of a TintMaskType that has several (war paint, dirt); 0 none. */
  | { readonly kind: 'tintMask'; readonly tint: number }
  /** Steps through the presets of the picked layer of such a type. */
  | { readonly kind: 'tintColor'; readonly tint: number }
  /** A NAMA slot: the k-th type the race offers in the MorphGroup. */
  | { readonly kind: 'faceType'; readonly group: number; readonly slot: number }
  /** A NAM9 value (−1..1). */
  | { readonly kind: 'morph'; readonly index: number };

export interface SliderDefinition {
  /** The id the movie echoes back (see SLIDER_DEFINITIONS). */
  readonly id: number;
  /** GMST editor id of its label. */
  readonly label: string;
  readonly category: number;
  readonly spec: SliderSpec;
}

const slider = (id: number, label: string, category: number, spec: SliderSpec) => ({
  id,
  label,
  category,
  spec,
});
const morph = (id: number, index: number, category: number): SliderDefinition =>
  slider(id, MORPH_PAIRS[index]?.label ?? '', category, { kind: 'morph', index });
const tint = (id: number, label: string, category: number, type: number): SliderDefinition =>
  slider(id, label, category, { kind: 'tint', tint: type });

const { body, head, face, eyes, brow, mouth, hair } = ChargenCategory;

/**
 * The vanilla sliders in display order. Ids 0..30 follow the movie's developer harness
 * (`FaceChanges`: every call's callback matches); the Face block's ids keep its types at 31
 * (morph), 32 (tint), 39 (type) and 42 (morph), the rest of that block is the engine's choice,
 * as is 46 for Sex.
 */
export const SLIDER_DEFINITIONS: readonly SliderDefinition[] = [
  slider(46, 'sRSMSex', body, { kind: 'sex' }),
  slider(0, 'sRSMHeadPresets', body, { kind: 'headPreset' }),
  tint(1, 'sRSMSkinColor', body, TintMaskType.skinTone),
  slider(2, 'sRSMWeight', body, { kind: 'weight' }),
  slider(3, 'sRSMComplexion', head, { kind: 'complexion' }),
  slider(4, 'sRSMDirt', head, { kind: 'tintMask', tint: TintMaskType.dirt }),
  slider(5, 'sRSMDirtColor', head, { kind: 'tintColor', tint: TintMaskType.dirt }),
  slider(6, 'sRSMScars', head, { kind: 'headPart', partType: HeadPartType.scar }),
  slider(7, 'sRSMPaint', head, { kind: 'tintMask', tint: TintMaskType.paint }),
  slider(8, 'sRSMPaintColor', head, { kind: 'tintColor', tint: TintMaskType.paint }),
  slider(39, 'sRSMNoseTypes', face, {
    kind: 'faceType',
    group: MorphGroup.nose,
    slot: FacePart.nose,
  }),
  morph(40, 1, face),
  morph(31, 0, face),
  morph(41, 3, face),
  morph(42, 2, face),
  morph(43, 4, face),
  morph(44, 5, face),
  morph(45, 6, face),
  tint(32, 'sRSMCheekColor', face, TintMaskType.cheekColor),
  tint(33, 'sRSMLaughLines', face, TintMaskType.laughLines),
  tint(34, 'sRSMCheekColorLower', face, TintMaskType.cheekColorLower),
  tint(35, 'sRSMNoseColor', face, TintMaskType.nose),
  tint(36, 'sRSMChinColor', face, TintMaskType.chin),
  tint(37, 'sRSMNeckColor', face, TintMaskType.neck),
  tint(38, 'sRSMForeheadColor', face, TintMaskType.forehead),
  slider(12, 'sRSMEyeTypes', eyes, {
    kind: 'faceType',
    group: MorphGroup.eyes,
    slot: FacePart.eyes,
  }),
  slider(13, 'sRSMEyeColor', eyes, { kind: 'headPart', partType: HeadPartType.eyes }),
  morph(14, 7, eyes),
  morph(15, 8, eyes),
  morph(16, 17, eyes),
  tint(17, 'sRSMEyelinerColor', eyes, TintMaskType.eyeliner),
  tint(18, 'sRSMEyeSocketUpperColor', eyes, TintMaskType.eyeSocketUpper),
  tint(19, 'sRSMEyeSocketLowerColor', eyes, TintMaskType.eyeSocketLower),
  slider(20, 'sRSMBrowTypes', brow, { kind: 'headPart', partType: HeadPartType.eyebrows }),
  morph(21, 9, brow),
  morph(22, 10, brow),
  morph(23, 11, brow),
  slider(24, 'sRSMMouthTypes', mouth, {
    kind: 'faceType',
    group: MorphGroup.lips,
    slot: FacePart.mouth,
  }),
  morph(25, 12, mouth),
  morph(26, 13, mouth),
  morph(27, 14, mouth),
  morph(28, 15, mouth),
  morph(29, 16, mouth),
  tint(30, 'sRSMLipColor', mouth, TintMaskType.lipColor),
  slider(9, 'sRSMHairPresets', hair, { kind: 'headPart', partType: HeadPartType.hair }),
  slider(10, 'sRSMFacialHairPresets', hair, {
    kind: 'headPart',
    partType: HeadPartType.facialHair,
  }),
  slider(11, 'sRSMHairColorPresets', hair, { kind: 'hairColor' }),
];

/** A slider as SetOptionSliders sends it (with its label still a GMST editor id). */
export interface ChargenSlider {
  readonly id: number;
  readonly label: string;
  readonly filterFlag: number;
  readonly callback: string;
  readonly min: number;
  readonly max: number;
  readonly position: number;
  readonly interval: number;
}

/** Interval of the −1..1 morph sliders and the 0..1 weight slider. TODO(M13): verify. */
const FINE_INTERVAL = 0.01;

const listSlider = (
  definition: SliderDefinition,
  callback: string,
  count: number,
  position: number,
): ChargenSlider | undefined =>
  count <= 0
    ? undefined
    : {
        id: definition.id,
        label: definition.label,
        filterFlag: definition.category,
        callback,
        min: 0,
        max: count - 1,
        position: Math.min(Math.max(position, 0), count - 1),
        interval: 1,
      };

/** The sliders for an appearance, in display order (lists without choices left out). */
export function buildSliders(data: ChargenRaceData, appearance: PlayerAppearance): ChargenSlider[] {
  const sliders: ChargenSlider[] = [];
  for (const definition of SLIDER_DEFINITIONS) {
    const built = buildSlider(data, appearance, definition);
    if (built) sliders.push(built);
  }
  return sliders;
}

function buildSlider(
  data: ChargenRaceData,
  appearance: PlayerAppearance,
  definition: SliderDefinition,
): ChargenSlider | undefined {
  const { spec } = definition;
  switch (spec.kind) {
    case 'sex':
      return listSlider(definition, SliderCallback.sex, 2, appearance.sex);
    case 'headPreset':
      return listSlider(
        definition,
        SliderCallback.headPreset,
        data.presets.length,
        data.presets.findIndex((preset) => sameFace(preset, appearance)),
      );
    case 'weight':
      return {
        id: definition.id,
        label: definition.label,
        filterFlag: definition.category,
        callback: SliderCallback.weight,
        min: 0,
        max: 1,
        position: appearance.weight / 100,
        interval: FINE_INTERVAL,
      };
    case 'complexion':
      return listSlider(
        definition,
        SliderCallback.faceDetails,
        data.faceDetails.length,
        data.faceDetails.indexOf(appearance.complexion ?? data.defaultFaceTexture ?? 0),
      );
    case 'hairColor':
      return listSlider(
        definition,
        SliderCallback.hairColor,
        data.hairColors.length,
        data.hairColors.findIndex(
          (color) => color.formId === (appearance.hairColor ?? data.defaultHairColor),
        ),
      );
    case 'headPart': {
      const list = data.headPartLists.get(spec.partType) ?? [];
      const current = currentHeadPart(data, appearance, spec.partType);
      return listSlider(
        definition,
        SliderCallback.headPart,
        list.length,
        current === undefined ? 0 : list.indexOf(current),
      );
    }
    case 'tint': {
      const layer = tintLayersOfType(data, spec.tint)[0];
      if (!layer) return undefined;
      return listSlider(
        definition,
        SliderCallback.tint,
        layer.presets.length,
        presetIndex(layer, tintOf(appearance, layer.index)),
      );
    }
    case 'tintMask': {
      const layers = tintLayersOfType(data, spec.tint);
      const active = activeTintLayer(data, appearance, spec.tint);
      return listSlider(
        definition,
        SliderCallback.tint,
        layers.length === 0 ? 0 : layers.length + 1,
        active ? layers.indexOf(active) + 1 : 0,
      );
    }
    case 'tintColor': {
      const active = activeTintLayer(data, appearance, spec.tint);
      const layer = active ?? tintLayersOfType(data, spec.tint)[0];
      if (!layer) return undefined;
      return listSlider(
        definition,
        SliderCallback.tint,
        layer.presets.length,
        active ? presetIndex(active, tintOf(appearance, active.index)) : 0,
      );
    }
    case 'faceType': {
      const types = data.morphTypes[spec.group] ?? [];
      return listSlider(
        definition,
        SliderCallback.faceType,
        types.length,
        types.indexOf(appearance.faceParts[spec.slot as 0 | 1 | 2 | 3]),
      );
    }
    case 'morph':
      return {
        id: definition.id,
        label: definition.label,
        filterFlag: definition.category,
        callback: SliderCallback.morph,
        min: -1,
        max: 1,
        position: appearance.faceMorphs[spec.index] ?? 0,
        interval: FINE_INTERVAL,
      };
  }
}

/**
 * The flat argument list of SetOptionSliders: per slider (text, filterFlag, callbackName,
 * sliderMin, sliderMax, position, interval, sliderID).
 */
export function sliderArguments(
  sliders: readonly ChargenSlider[],
  text: (label: string) => string,
): (string | number)[] {
  return sliders.flatMap((s) => [
    text(s.label),
    s.filterFlag,
    s.callback,
    s.min,
    s.max,
    s.position,
    s.interval,
    s.id,
  ]);
}

// --- Applying sliders ---

/** What a change touched: what the look has to rebuild. */
export type AppearanceChange =
  'sex' | 'shape' | 'headParts' | 'tints' | 'skinTone' | 'hairColor' | 'complexion' | 'weight';

export interface SliderResult {
  readonly appearance: PlayerAppearance;
  readonly changes: readonly AppearanceChange[];
  /**
   * The slider list has to be sent again (positions or ranges of other sliders moved). On
   * 'sex' the caller also loads the race data of the new sex and starts from
   * defaultAppearance.
   */
  readonly resendSliders: boolean;
}

const unchanged = (appearance: PlayerAppearance): SliderResult => ({
  appearance,
  changes: [],
  resendSliders: false,
});

const toIndex = (value: number, count: number): number | undefined => {
  if (!Number.isFinite(value) || count <= 0) return undefined;
  return Math.min(Math.max(Math.round(value), 0), count - 1);
};

/** A slider call (callback with (value, sliderID)) applied to the appearance. */
export function applySlider(
  data: ChargenRaceData,
  appearance: PlayerAppearance,
  sliderId: number,
  value: number,
): SliderResult {
  const definition = SLIDER_DEFINITIONS.find((d) => d.id === sliderId);
  if (!definition || !Number.isFinite(value)) return unchanged(appearance);
  const { spec } = definition;
  switch (spec.kind) {
    case 'sex': {
      const sex = value >= 0.5 ? 1 : 0;
      if (sex === appearance.sex) return unchanged(appearance);
      return { appearance: { ...appearance, sex }, changes: ['sex'], resendSliders: true };
    }
    case 'headPreset': {
      const index = toIndex(value, data.presets.length);
      const preset = index === undefined ? undefined : data.presets[index];
      if (!preset) return unchanged(appearance);
      return {
        appearance: applyPreset(data, appearance, preset),
        changes: ['shape', 'headParts', 'tints', 'skinTone', 'hairColor', 'complexion'],
        resendSliders: true,
      };
    }
    case 'weight': {
      const weight = Math.min(Math.max(value, 0), 1) * 100;
      return {
        appearance: { ...appearance, weight },
        changes: ['weight', 'shape'],
        resendSliders: false,
      };
    }
    case 'complexion': {
      const index = toIndex(value, data.faceDetails.length);
      if (index === undefined) return unchanged(appearance);
      return {
        appearance: { ...appearance, complexion: data.faceDetails[index] },
        changes: ['complexion'],
        resendSliders: false,
      };
    }
    case 'hairColor': {
      const index = toIndex(value, data.hairColors.length);
      if (index === undefined) return unchanged(appearance);
      return {
        appearance: { ...appearance, hairColor: data.hairColors[index]?.formId },
        changes: ['hairColor'],
        resendSliders: false,
      };
    }
    case 'headPart': {
      const list = data.headPartLists.get(spec.partType) ?? [];
      const index = toIndex(value, list.length);
      const part = index === undefined ? undefined : list[index];
      if (part === undefined) return unchanged(appearance);
      return {
        appearance: { ...appearance, headParts: withHeadPart(data, appearance.headParts, part) },
        changes: ['headParts'],
        resendSliders: false,
      };
    }
    case 'tint': {
      const layer = tintLayersOfType(data, spec.tint)[0];
      const index = layer && toIndex(value, layer.presets.length);
      const preset = index === undefined ? undefined : layer?.presets[index];
      if (!layer || !preset) return unchanged(appearance);
      return withTintPreset(appearance, layer, preset, false);
    }
    case 'tintMask': {
      const layers = tintLayersOfType(data, spec.tint);
      const index = toIndex(value, layers.length + 1);
      if (index === undefined) return unchanged(appearance);
      const active = activeTintLayer(data, appearance, spec.tint);
      const indices = new Set(layers.map((layer) => layer.index));
      const without = appearance.tints.filter((t) => !indices.has(t.index));
      const layer = layers[index - 1];
      if (!layer) {
        return {
          appearance: { ...appearance, tints: without },
          changes: ['tints'],
          resendSliders: true,
        };
      }
      // Keep the colour picked so far; a new mask starts at its first visible preset.
      const previous = active ? presetIndex(active, tintOf(appearance, active.index)) : -1;
      const presetAt =
        previous >= 0 && previous < layer.presets.length
          ? previous
          : Math.max(
              layer.presets.findIndex((preset) => preset.value > 0),
              0,
            );
      const preset = layer.presets[presetAt];
      if (!preset) return unchanged(appearance);
      return withTintPreset({ ...appearance, tints: without }, layer, preset, true);
    }
    case 'tintColor': {
      const active = activeTintLayer(data, appearance, spec.tint);
      const index = active && toIndex(value, active.presets.length);
      const preset = index === undefined ? undefined : active?.presets[index];
      if (!active || !preset) return unchanged(appearance);
      return withTintPreset(appearance, active, preset, false);
    }
    case 'faceType': {
      const types = data.morphTypes[spec.group] ?? [];
      const index = toIndex(value, types.length);
      const type = index === undefined ? undefined : types[index];
      if (type === undefined) return unchanged(appearance);
      const faceParts: [number, number, number, number] = [...appearance.faceParts];
      faceParts[spec.slot as 0 | 1 | 2 | 3] = type;
      return { appearance: { ...appearance, faceParts }, changes: ['shape'], resendSliders: false };
    }
    case 'morph': {
      const faceMorphs = [...appearance.faceMorphs];
      faceMorphs[spec.index] = Math.min(Math.max(value, -1), 1);
      return {
        appearance: { ...appearance, faceMorphs },
        changes: ['shape'],
        resendSliders: false,
      };
    }
  }
}

/** The head part of a type the appearance shows: its own, else the race's default. */
export function currentHeadPart(
  data: ChargenRaceData,
  appearance: PlayerAppearance,
  partType: number,
): number | undefined {
  const ofType = (parts: readonly number[]) =>
    parts.findLast((part) => data.headPartTypes.get(part) === partType);
  return ofType(appearance.headParts) ?? ofType(data.defaultHeadParts);
}

/** The head parts with `part` replacing the one of its type. */
function withHeadPart(
  data: ChargenRaceData,
  parts: readonly number[],
  part: number,
): readonly number[] {
  const type = data.headPartTypes.get(part);
  return [...parts.filter((p) => data.headPartTypes.get(p) !== type), part];
}

// --- Tints ---

/** The race layers of a TintMaskType that have a mask, in record order. */
export function tintLayersOfType(data: ChargenRaceData, type: number): ChargenTintLayer[] {
  return data.tintLayers.filter((layer) => layer.type === type && layer.mask !== undefined);
}

const tintOf = (appearance: PlayerAppearance, index: number): NpcTintLayer | undefined =>
  appearance.tints.find((t) => t.index === index);

/** The layer of a multi-mask type (war paint, dirt) the appearance wears. */
function activeTintLayer(
  data: ChargenRaceData,
  appearance: PlayerAppearance,
  type: number,
): ChargenTintLayer | undefined {
  const layers = tintLayersOfType(data, type);
  const worn = layers.filter((layer) => tintOf(appearance, layer.index) !== undefined);
  return worn.find((layer) => (tintOf(appearance, layer.index)?.value ?? 0) > 0) ?? worn[0];
}

const sameRgb = (a: Rgb, b: Rgb | undefined): boolean => a.every((value, i) => value === b?.[i]);

/** The preset a tint was chosen from (by TIAS, else by colour); else the layer's default. */
function presetIndex(layer: ChargenTintLayer, worn: NpcTintLayer | undefined): number {
  if (worn) {
    const byId = layer.presets.findIndex((preset) => preset.id === worn.preset);
    if (byId >= 0) return byId;
    const byColor = layer.presets.findIndex((preset) => sameRgb(preset.rgb, worn.color));
    if (byColor >= 0) return byColor;
  }
  return Math.max(
    layer.presets.findIndex((preset) => preset.color === layer.defaultColor),
    0,
  );
}

/** Tint layers kept in ascending index: the order they composite in. */
const sortTints = (tints: readonly NpcTintLayer[]): NpcTintLayer[] =>
  [...tints].sort((a, b) => a.index - b.index);

function withTintPreset(
  appearance: PlayerAppearance,
  layer: ChargenTintLayer,
  preset: ChargenTintPreset,
  resendSliders: boolean,
): SliderResult {
  const tint: NpcTintLayer = {
    index: layer.index,
    color: preset.rgb,
    value: preset.value,
    preset: preset.id,
  };
  const tints = sortTints([...appearance.tints.filter((t) => t.index !== layer.index), tint]);
  const skin = layer.type === TintMaskType.skinTone;
  return {
    appearance: {
      ...appearance,
      tints,
      skinTone: skin ? toUnit(preset.rgb) : appearance.skinTone,
    },
    changes: skin ? ['tints', 'skinTone'] : ['tints'],
    resendSliders,
  };
}

const toUnit = (rgb: Rgb): Rgb => [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];
const toBytes = (rgb: Rgb): Rgb => [
  Math.round(rgb[0] * 255),
  Math.round(rgb[1] * 255),
  Math.round(rgb[2] * 255),
];

/**
 * The tints with a skin tone layer: an actor without one (the Player record has none) gets the
 * race's skin tone layer in its QNAM colour at full strength.
 */
function withSkinToneLayer(
  data: ChargenRaceData,
  tints: readonly NpcTintLayer[],
  skinTone: Rgb,
): NpcTintLayer[] {
  const layer = tintLayersOfType(data, TintMaskType.skinTone)[0];
  if (!layer || tints.some((t) => t.index === layer.index)) return sortTints(tints);
  const color = toBytes(skinTone);
  const preset = layer.presets.find((p) => sameRgb(p.rgb, color));
  return sortTints([...tints, { index: layer.index, color, value: 1, preset: preset?.id ?? -1 }]);
}

// --- Whole appearances ---

/** Does an appearance have a preset's face (shape and parts)? */
function sameFace(preset: NpcFace, appearance: PlayerAppearance): boolean {
  return (
    preset.morphs.every((value, i) => Math.abs(value - (appearance.faceMorphs[i] ?? 0)) < 1e-4) &&
    preset.faceParts.every((value, i) => value === appearance.faceParts[i]) &&
    preset.headParts.length === appearance.headParts.length &&
    preset.headParts.every((part) => appearance.headParts.includes(part))
  );
}

/**
 * A race's look for a new character (race or sex changed): the default head parts and
 * complexion, its default hair colour, a neutral shape (NAM9 0, the first offered face part
 * types) and each tint layer at its default colour. TODO(M13): verify against the game whether
 * vanilla starts from the race's first preset instead. Keeps the weight.
 */
export function defaultAppearance(data: ChargenRaceData, weight = 50): PlayerAppearance {
  const tints: NpcTintLayer[] = [];
  for (const layer of data.tintLayers) {
    if (layer.mask === undefined || layer.defaultColor === undefined || !layer.defaultRgb) continue;
    const preset = layer.presets.find((p) => p.color === layer.defaultColor);
    tints.push({
      index: layer.index,
      color: layer.defaultRgb,
      value: preset?.value ?? (layer.type === TintMaskType.skinTone ? 1 : 0),
      preset: preset?.id ?? -1,
    });
  }
  const skinLayer = tintLayersOfType(data, TintMaskType.skinTone)[0];
  const skinTint = skinLayer && tints.find((t) => t.index === skinLayer.index);
  const skinTone: Rgb = skinTint ? toUnit(skinTint.color) : [1, 1, 1];
  const first = (group: number): number => data.morphTypes[group]?.[0] ?? 0;
  return {
    race: data.race,
    sex: data.sex,
    weight,
    headParts: [],
    hairColor: data.defaultHairColor,
    skinTone,
    faceMorphs: new Array<number>(FACE_MORPH_COUNT).fill(0),
    faceParts: [first(MorphGroup.nose), -1, first(MorphGroup.eyes), first(MorphGroup.lips)],
    tints: withSkinToneLayer(data, tints, skinTone),
    complexion: data.defaultFaceTexture,
  };
}

/** An actor base's look as an appearance (the player's start: the Player record, 0x7). */
export function appearanceFromNpc(data: ChargenRaceData, face: NpcFace): PlayerAppearance {
  const base = defaultAppearance(data, face.weight);
  return applyPreset(data, base, face);
}

/**
 * A face preset (RPRM / RPRF) copied over the appearance: head parts, hair colour,
 * complexion, skin tone, shape and tints; race, sex and weight stay (TODO(M13): verify that
 * vanilla keeps the weight and whether it asks first, sRSMConfirmDestruction).
 */
export function applyPreset(
  data: ChargenRaceData,
  appearance: PlayerAppearance,
  preset: NpcFace,
): PlayerAppearance {
  const skinTone = preset.skinTone ?? appearance.skinTone;
  return {
    ...appearance,
    headParts: [...preset.headParts],
    hairColor: preset.hairColor ?? data.defaultHairColor,
    complexion: preset.faceTexture ?? data.defaultFaceTexture,
    skinTone,
    faceMorphs: [...preset.morphs],
    faceParts: [...preset.faceParts],
    tints: withSkinToneLayer(data, preset.tints, skinTone),
  };
}

// --- Head shape ---

/** SkinnyMorph (in the expression TRIs) weight for a weight of 0..100. */
export const skinnyMorphWeight = (weight: number): number =>
  1 - Math.min(Math.max(weight, 0), 100) / 100;

/**
 * The FaceGen morph weights of an appearance, by lower-case morph name: the race morph (the
 * head parts' race TRIs) at 1, each NAM9 value on its pair, the NAMA types and SkinnyMorph.
 * Applied to every head part by name; a part's TRIs lacking a morph skip it.
 */
export function chargenMorphWeights(
  appearance: Pick<PlayerAppearance, 'faceMorphs' | 'faceParts' | 'weight'>,
  morphRace: string | undefined,
): Map<string, number> {
  const weights = new Map<string, number>();
  const add = (name: string, weight: number) => {
    if (weight === 0) return;
    const key = name.toLowerCase();
    weights.set(key, (weights.get(key) ?? 0) + weight);
  };
  if (morphRace) add(morphRace, 1);
  MORPH_PAIRS.forEach((pair, i) => {
    const value = appearance.faceMorphs[i] ?? 0;
    if (value < 0) add(pair.negative, -value);
    else add(pair.positive, value);
  });
  for (const { slot, prefix } of FACE_TYPE_MORPH) {
    const type = appearance.faceParts[slot as 0 | 1 | 2 | 3];
    if (type > 0) add(`${prefix}${String(type)}`, 1);
  }
  add('SkinnyMorph', skinnyMorphWeight(appearance.weight));
  return weights;
}

// --- Face tint ---

/** A tint mask as RGBA8 pixels (its red channel is the coverage). */
export interface TintMask {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface TintCompositeLayer {
  readonly mask: TintMask;
  /** RGB bytes. */
  readonly color: Rgb;
  /** 0..1. */
  readonly value: number;
}

/** The race masks (VFS paths) of an appearance's tints, in composite order. */
export function faceTintLayers(
  data: ChargenRaceData,
  appearance: PlayerAppearance,
): { readonly mask: string; readonly color: Rgb; readonly value: number }[] {
  const out: { mask: string; color: Rgb; value: number }[] = [];
  for (const tint of appearance.tints) {
    const layer = data.tintLayers.find((l) => l.index === tint.index);
    if (layer?.mask === undefined) continue;
    const path = normalizePath(layer.mask);
    out.push({
      mask: path.startsWith('textures\\') ? path : `textures\\${path}`,
      color: tint.color,
      value: tint.value,
    });
  }
  return out;
}

/**
 * The face tint texture (FaceGen shader slot 6) as RGBA8: the layers in order, each
 * `dst = lerp(dst, colour, mask.red / 255 × value)`, from `base` (the skin tone layer is all
 * white at value 1, so it covers whatever is under it). Masks of another size are sampled at
 * the nearest pixel. Matches the baked facetint textures within 2/255 on average.
 */
export function composeFaceTint(
  layers: readonly TintCompositeLayer[],
  width: number,
  height: number,
  base: Rgb = [0, 0, 0],
): Uint8Array {
  const pixels = width * height;
  const color = new Float32Array(pixels * 3);
  for (let i = 0; i < pixels; i++) color.set(base, i * 3);
  for (const layer of layers) {
    const { mask } = layer;
    if (mask.data.length < mask.width * mask.height * 4) continue;
    const strength = layer.value / 255;
    const [r, g, b] = layer.color;
    for (let y = 0; y < height; y++) {
      const row = Math.floor((y * mask.height) / height) * mask.width;
      for (let x = 0; x < width; x++) {
        const coverage =
          (mask.data[(row + Math.floor((x * mask.width) / width)) * 4] ?? 0) * strength;
        if (coverage === 0) continue;
        const at = (y * width + x) * 3;
        color[at] = (color[at] ?? 0) + (r - (color[at] ?? 0)) * coverage;
        color[at + 1] = (color[at + 1] ?? 0) + (g - (color[at + 1] ?? 0)) * coverage;
        color[at + 2] = (color[at + 2] ?? 0) + (b - (color[at + 2] ?? 0)) * coverage;
      }
    }
  }
  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    out[i * 4] = Math.round(color[i * 3] ?? 0);
    out[i * 4 + 1] = Math.round(color[i * 3 + 1] ?? 0);
    out[i * 4 + 2] = Math.round(color[i * 3 + 2] ?? 0);
    out[i * 4 + 3] = 255;
  }
  return out;
}
