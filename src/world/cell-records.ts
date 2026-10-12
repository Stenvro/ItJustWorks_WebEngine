// Typed views of the records needed to load a cell: CELL (with lighting), placed references,
// lights and the model paths of base objects. Layouts: docs/formats/esm.md

import { requireSize, view } from '../formats/esm/fields.ts';
import { RecordFlag } from '../formats/esm/record.ts';
import type { GameRecord } from './record-db.ts';

export type Rgb = readonly [number, number, number];

/** Colour stored as r, g, b, unused bytes → 0..1. */
function color(data: DataView, offset: number): Rgb {
  return [
    data.getUint8(offset) / 255,
    data.getUint8(offset + 1) / 255,
    data.getUint8(offset + 2) / 255,
  ];
}

export interface DirectionalAmbient {
  readonly xPositive: Rgb;
  readonly xNegative: Rgb;
  readonly yPositive: Rgb;
  readonly yNegative: Rgb;
  readonly zPositive: Rgb;
  readonly zNegative: Rgb;
  readonly specular: Rgb;
  readonly fresnelPower: number;
}

export interface CellLighting {
  readonly ambient: Rgb;
  readonly directional: Rgb;
  /** Degrees. */
  readonly directionalRotationXY: number;
  readonly directionalRotationZ: number;
  readonly directionalFade: number;
  readonly fogNearColor: Rgb;
  readonly fogFarColor: Rgb;
  readonly fogNear: number;
  readonly fogFar: number;
  readonly fogPower: number;
  readonly fogMax: number;
  readonly clipDistance: number;
  readonly directionalAmbient: DirectionalAmbient;
  readonly lightFadeBegin: number;
  readonly lightFadeEnd: number;
}

/** XCLL "inherit from lighting template" flags. */
export const LightingInherit = {
  ambient: 0x1,
  directional: 0x2,
  fogColor: 0x4,
  fogNear: 0x8,
  fogFar: 0x10,
  directionalRotation: 0x20,
  directionalFade: 0x40,
  clipDistance: 0x80,
  fogPower: 0x100,
  fogMax: 0x200,
  lightFadeDistances: 0x400,
} as const;

function directionalAmbient(data: DataView, offset: number): DirectionalAmbient {
  return {
    xPositive: color(data, offset),
    xNegative: color(data, offset + 4),
    yPositive: color(data, offset + 8),
    yNegative: color(data, offset + 12),
    zPositive: color(data, offset + 16),
    zNegative: color(data, offset + 20),
    // Older records stop after the six colours (24 bytes): no specular, fresnel power 1.
    specular: data.byteLength >= offset + 28 ? color(data, offset + 24) : [0, 0, 0],
    fresnelPower: data.byteLength >= offset + 32 ? data.getFloat32(offset + 28, true) : 1,
  };
}

/** XCLL (cell) and LGTM DATA share this layout up to the inherit flags. */
function lightingFrom(data: DataView, ambientColors: DirectionalAmbient): CellLighting {
  return {
    ambient: color(data, 0),
    directional: color(data, 4),
    fogNearColor: color(data, 8),
    fogNear: data.getFloat32(12, true),
    fogFar: data.getFloat32(16, true),
    directionalRotationXY: data.getInt32(20, true),
    directionalRotationZ: data.getInt32(24, true),
    directionalFade: data.getFloat32(28, true),
    clipDistance: data.getFloat32(32, true),
    fogPower: data.getFloat32(36, true),
    directionalAmbient: ambientColors,
    // Older LGTM records (72 bytes) stop after the directional ambient: the far fog colour
    // then equals the near one and fog is not capped.
    fogFarColor: data.byteLength >= 76 ? color(data, 72) : color(data, 8),
    fogMax: data.byteLength >= 80 ? data.getFloat32(76, true) : 1,
    lightFadeBegin: data.byteLength >= 84 ? data.getFloat32(80, true) : 0,
    lightFadeEnd: data.byteLength >= 88 ? data.getFloat32(84, true) : 0,
  };
}

export interface CellRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly name: string;
  readonly interior: boolean;
  /** XCLL, if the cell has its own lighting. */
  readonly lighting: CellLighting | undefined;
  /** Which XCLL values come from the lighting template instead. */
  readonly inheritFlags: number;
  /** LTMP: lighting template (LGTM) form id. */
  readonly lightingTemplate: number | undefined;
  /** XCIM: the interior's imagespace (IMGS). */
  readonly imageSpace: number | undefined;
  /** DATA flag 0x2: the cell has a water plane. */
  readonly hasWater: boolean;
  /** XCLW as stored (FLT_MAX: the worldspace's default). */
  readonly waterHeight: number | undefined;
  /** XCWT: the cell's water type (WATR). */
  readonly waterType: number | undefined;
}

const nonZero = (id: number | undefined): number | undefined => (id === 0 ? undefined : id);

function cellImageSpace(record: GameRecord): number | undefined {
  return nonZero(record.formIdField('XCIM'));
}

export function parseCell(record: GameRecord): CellRecord {
  const data = record.fields.first('DATA');
  const xcll = record.fields.first('XCLL');
  let lighting: CellLighting | undefined;
  let inheritFlags = 0;
  if (xcll) {
    const xcllView = requireSize(xcll, 92, 'CELL XCLL');
    lighting = lightingFrom(xcllView, directionalAmbient(xcllView, 40));
    inheritFlags = xcllView.getUint32(88, true);
  }
  const ltmp = record.formIdField('LTMP');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    name: record.text('FULL') ?? '',
    interior: data !== undefined && data.length > 0 && ((data[0] ?? 0) & 0x1) !== 0,
    lighting,
    inheritFlags,
    lightingTemplate: ltmp === 0 ? undefined : ltmp,
    imageSpace: cellImageSpace(record),
    hasWater: ((data?.[0] ?? 0) & 0x2) !== 0,
    waterHeight: record.fields.f32('XCLW'),
    waterType: nonZero(record.formIdField('XCWT')),
  };
}

/** LGTM: lighting template (DATA plus DALC directional ambient). */
export function parseLightingTemplate(record: GameRecord): CellLighting {
  // DATA comes in 92-, 88-, 72- and 64-byte versions (the shorter ones stop after the
  // directional ambient, which may lack specular and fresnel); DALC in 32 and 24 bytes.
  const data = requireSize(record.fields.first('DATA') ?? new Uint8Array(), 64, 'LGTM DATA');
  const dalc = record.fields.first('DALC');
  const ambient = dalc
    ? directionalAmbient(requireSize(dalc, 24, 'LGTM DALC'), 0)
    : directionalAmbient(data, 40);
  return lightingFrom(data, ambient);
}

/** Cell lighting with inherited values taken from the template, like the engine does. */
export function resolveCellLighting(
  cell: CellRecord,
  template: CellLighting | undefined,
): CellLighting | undefined {
  const own = cell.lighting;
  if (!own) return template;
  if (!template) return own;
  const pick = <K extends keyof CellLighting>(
    flag: number,
    ...keys: K[]
  ): Pick<CellLighting, K> => {
    const source = (cell.inheritFlags & flag) !== 0 ? template : own;
    return Object.fromEntries(keys.map((key) => [key, source[key]])) as Pick<CellLighting, K>;
  };
  return {
    ...own,
    ...pick(LightingInherit.ambient, 'ambient', 'directionalAmbient'),
    ...pick(LightingInherit.directional, 'directional'),
    ...pick(LightingInherit.fogColor, 'fogNearColor', 'fogFarColor'),
    ...pick(LightingInherit.fogNear, 'fogNear'),
    ...pick(LightingInherit.fogFar, 'fogFar'),
    ...pick(LightingInherit.directionalRotation, 'directionalRotationXY', 'directionalRotationZ'),
    ...pick(LightingInherit.directionalFade, 'directionalFade'),
    ...pick(LightingInherit.clipDistance, 'clipDistance'),
    ...pick(LightingInherit.fogPower, 'fogPower'),
    ...pick(LightingInherit.fogMax, 'fogMax'),
    ...pick(LightingInherit.lightFadeDistances, 'lightFadeBegin', 'lightFadeEnd'),
  };
}

// --- References -----------------------------------------------------------------

export interface PlacedReference {
  readonly formId: number;
  /** Only some references have one (e.g. enable-parent markers). */
  readonly editorId: string;
  readonly type: string;
  readonly base: number;
  readonly position: readonly [number, number, number];
  /** Euler angles in radians (x, y, z). */
  readonly rotation: readonly [number, number, number];
  readonly scale: number;
  readonly deleted: boolean;
  readonly initiallyDisabled: boolean;
  readonly enableParent: { readonly formId: number; readonly opposite: boolean } | undefined;
  /** XRDS: added to the base light's radius (vanilla values range from -322 to +55). */
  readonly radiusOffset: number;
}

export function parseReference(record: GameRecord): PlacedReference {
  const data = record.fields.first('DATA');
  const placement = data && data.length >= 24 ? view(data) : undefined;
  const xesp = record.fields.first('XESP');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    type: record.type,
    base: record.formIdField('NAME') ?? 0,
    position: placement
      ? [
          placement.getFloat32(0, true),
          placement.getFloat32(4, true),
          placement.getFloat32(8, true),
        ]
      : [0, 0, 0],
    rotation: placement
      ? [
          placement.getFloat32(12, true),
          placement.getFloat32(16, true),
          placement.getFloat32(20, true),
        ]
      : [0, 0, 0],
    scale: record.fields.f32('XSCL') ?? 1,
    deleted: record.deleted,
    initiallyDisabled: (record.flags & RecordFlag.initiallyDisabled) !== 0,
    enableParent:
      xesp && xesp.length >= 5
        ? { formId: record.formIdAt(xesp), opposite: ((xesp[4] ?? 0) & 0x1) !== 0 }
        : undefined,
    radiusOffset: record.fields.f32('XRDS') ?? 0,
  };
}

// --- Base objects ---------------------------------------------------------------

/** Base object types that are drawn from a NIF in the world. */
const MODEL_FIELD: Readonly<Record<string, string>> = {
  ACTI: 'MODL',
  ALCH: 'MODL',
  AMMO: 'MODL',
  APPA: 'MODL',
  ARMO: 'MOD2', // world model (male)
  BOOK: 'MODL',
  CONT: 'MODL',
  DOOR: 'MODL',
  FLOR: 'MODL',
  FURN: 'MODL',
  IDLM: 'MODL',
  INGR: 'MODL',
  KEYM: 'MODL',
  LIGH: 'MODL',
  MISC: 'MODL',
  MSTT: 'MODL',
  SCRL: 'MODL',
  SLGM: 'MODL',
  STAT: 'MODL',
  TACT: 'MODL',
  TREE: 'MODL',
  WEAP: 'MODL',
};

/** `meshes\...` path of a base object's world model, or undefined if it has none. */
export function baseModelPath(record: GameRecord): string | undefined {
  const field = MODEL_FIELD[record.type];
  if (!field) return undefined;
  const model = record.fields.zstring(field);
  if (!model || model.trim() === '') return undefined;
  const normalized = model.replaceAll('/', '\\').replace(/^\\+/, '').toLowerCase();
  return normalized.startsWith('meshes\\') ? normalized : `meshes\\${normalized}`;
}

export interface LightRecord {
  readonly radius: number;
  readonly color: Rgb;
  readonly flags: number;
  readonly falloffExponent: number;
  readonly fade: number;
}

export const LightFlag = {
  dynamic: 0x1,
  canCarry: 0x2,
  negative: 0x4,
  flicker: 0x8,
  offByDefault: 0x20,
  flickerSlow: 0x40,
  pulse: 0x80,
  shadowSpotlight: 0x400,
  shadowHemisphere: 0x800,
  shadowOmnidirectional: 0x1000,
} as const;

/** LIGH DATA (48 bytes in Skyrim SE) and FNAM fade. */
export function parseLight(record: GameRecord): LightRecord {
  const data = requireSize(record.fields.first('DATA') ?? new Uint8Array(), 24, 'LIGH DATA');
  return {
    radius: data.getUint32(4, true),
    color: color(data, 8),
    flags: data.getUint32(12, true),
    falloffExponent: data.getFloat32(16, true),
    fade: record.fields.f32('FNAM') ?? 1,
  };
}
