// Water types (WATR) and where water is: a cell's water plane (XCLW height, XCWT type, or
// the worldspace's defaults) and water placed as meshes by activators (ACTI WNAM).
// Platform-independent. Layout: docs/formats/esm.md ("Water").

import { view } from '../formats/esm/fields.ts';
import type { GameRecord } from './record-db.ts';
import type { Rgb } from './weather.ts';

/** WATR FNAM flags. */
export const WaterFlag = {
  causesDamage: 0x1,
  /** Rivers: normals follow the cell's flow map (textures\water\<plugin>\flow.x.y.dds). */
  flowmap: 0x8,
  /** Blends the flow map with still-water normals at the edges. */
  blendNormals: 0x10,
} as const;

export interface WaterType {
  readonly formId: number;
  readonly editorId: string;
  /** ANAM / 100. */
  readonly opacity: number;
  readonly flags: number;
  /** Normal maps of the three noise layers (textures\...). */
  readonly noiseTextures: readonly string[];
  readonly shallowColor: Rgb;
  readonly deepColor: Rgb;
  readonly reflectionColor: Rgb;
  readonly sunSpecularPower: number;
  readonly reflectivity: number;
  readonly fresnel: number;
  readonly fogNear: number;
  readonly fogFar: number;
  readonly fogAmount: number;
  readonly underwaterFogNear: number;
  readonly underwaterFogFar: number;
  readonly underwaterFogAmount: number;
  readonly noiseFalloff: number;
  /** Per noise layer: wind direction (degrees), speed, UV scale (units), amplitude. */
  readonly windDirection: readonly number[];
  readonly windSpeed: readonly number[];
  readonly uvScale: readonly number[];
  readonly amplitude: readonly number[];
  readonly refractionMagnitude: number;
  readonly specularPower: number;
  readonly specularRadius: number;
  readonly specularBrightness: number;
  readonly reflectionMagnitude: number;
  readonly sunSparkleMagnitude: number;
  readonly sunSpecularMagnitude: number;
  readonly sunSparklePower: number;
  /** Depth properties: how much reflections, refraction, normals and specular need depth. */
  readonly depthReflections: number;
  readonly depthRefraction: number;
  readonly depthNormals: number;
  readonly depthSpecular: number;
  readonly flowmapScale: number;
}

/** DefaultWater (Skyrim.esm): the type of water meshes nothing else assigns one to. */
export const DEFAULT_WATER = 0x18;

const textureOf = (value: string): string => {
  if (value === '') return '';
  // "Data\Textures\Water\DefaultWater.dds": everything up to Data\ is dropped.
  let normalized = value.replaceAll('/', '\\').toLowerCase();
  const data = normalized.lastIndexOf('data\\');
  if (data >= 0) normalized = normalized.slice(data + 5);
  return normalized.startsWith('textures\\') ? normalized : `textures\\${normalized}`;
};

export function parseWater(record: Pick<GameRecord, 'formId' | 'editorId' | 'fields'>): WaterType {
  const { fields } = record;
  const dnam = fields.first('DNAM') ?? new Uint8Array(0);
  const d = view(dnam);
  // DNAM is a list of 4-byte values (floats, three of them colours); index = UESP number − 1.
  const f = (index: number, fallback = 0): number =>
    index * 4 + 4 <= dnam.length ? d.getFloat32(index * 4, true) : fallback;
  const rgb = (index: number): Rgb =>
    index * 4 + 3 <= dnam.length
      ? [
          (dnam[index * 4] ?? 0) / 255,
          (dnam[index * 4 + 1] ?? 0) / 255,
          (dnam[index * 4 + 2] ?? 0) / 255,
        ]
      : [0, 0, 0];
  const noise = ['NAM2', 'NAM3', 'NAM4'].map((type) => textureOf(fields.zstring(type) ?? ''));
  // Older files list the noise textures as three NNAM fields.
  const nnam = fields
    .all('NNAM')
    .map((data) => textureOf(new TextDecoder().decode(data).replace(/\0.*$/s, '')));
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    opacity: (fields.first('ANAM')?.[0] ?? 100) / 100,
    flags: fields.first('FNAM')?.[0] ?? 0,
    noiseTextures: noise.map((path, i) => (path === '' ? (nnam[i] ?? '') : path)),
    sunSpecularPower: f(4),
    reflectivity: f(5),
    fresnel: f(6),
    fogNear: f(8),
    fogFar: f(9),
    shallowColor: rgb(10),
    deepColor: rgb(11),
    reflectionColor: rgb(12),
    noiseFalloff: f(24),
    windDirection: [f(25), f(26), f(27)],
    windSpeed: [f(28), f(29), f(30)],
    fogAmount: f(33),
    underwaterFogAmount: f(35),
    underwaterFogNear: f(36),
    underwaterFogFar: f(37),
    refractionMagnitude: f(38),
    specularPower: f(39),
    specularRadius: f(41),
    specularBrightness: f(42),
    uvScale: [f(43, 1), f(44, 1), f(45, 1)],
    amplitude: [f(46), f(47), f(48)],
    reflectionMagnitude: f(49),
    sunSparkleMagnitude: f(50),
    sunSpecularMagnitude: f(51),
    depthReflections: f(52),
    depthRefraction: f(53),
    depthNormals: f(54),
    depthSpecular: f(55),
    sunSparklePower: f(56),
    flowmapScale: f(57, 1),
  };
}

/**
 * What a water type does to what is in it (WATR, xEdit's TES5 definition): its current (NAM0
 * linear velocity, NAM1 angular velocity; Havok units a second and radians a second, as the
 * [HAVOK] fDefaultWaterfallCurrentVelocity of 6), its damage (FNAM Causes Damage with DATA's
 * damage per second), its spell (XNAM) and its material (TNAM: the puddles' MaterialWaterPuddle,
 * else the WATER phantoms' Water). Of the 58 vanilla types 35 have a current; none has damage
 * per second or a spell (Apocrypha's two set Causes Damage alone).
 */
export interface WaterBody {
  readonly formId: number;
  readonly linearVelocity: readonly [number, number, number];
  readonly angularVelocity: readonly [number, number, number];
  readonly causesDamage: boolean;
  /** FNAM Enable Flowmap: its rivers flow along their cells' flow maps. */
  readonly flowmap: boolean;
  readonly damagePerSecond: number;
  readonly spell: number | undefined;
  readonly material: number | undefined;
}

export function parseWaterBody(
  record: Pick<GameRecord, 'formId' | 'fields' | 'formIdField'>,
): WaterBody {
  const vec = (type: string): [number, number, number] => {
    const data = record.fields.first(type);
    if (!data || data.length < 12) return [0, 0, 0];
    const d = view(data);
    return [d.getFloat32(0, true), d.getFloat32(4, true), d.getFloat32(8, true)];
  };
  const damage = record.fields.first('DATA');
  const spell = record.formIdField('XNAM');
  const material = record.formIdField('TNAM');
  return {
    formId: record.formId,
    linearVelocity: vec('NAM0'),
    angularVelocity: vec('NAM1'),
    causesDamage: ((record.fields.first('FNAM')?.[0] ?? 0) & WaterFlag.causesDamage) !== 0,
    flowmap: ((record.fields.first('FNAM')?.[0] ?? 0) & WaterFlag.flowmap) !== 0,
    damagePerSecond: damage && damage.length >= 2 ? view(damage).getUint16(0, true) : 0,
    spell: spell === 0 ? undefined : spell,
    material: material === 0 ? undefined : material,
  };
}

/** XCLW of FLT_MAX: the worldspace's default water height. */
const DEFAULT_HEIGHT = 3.4e38;

export interface CellWater {
  readonly height: number;
  /** WATR form id (XCWT, else the world's water). */
  readonly type: number | undefined;
}

/**
 * A cell's water plane, if it has one: DATA flag 0x2 with XCLW (FLT_MAX or none: the
 * world's default height). Other absurd heights (±2^31, 2^32 in a few vanilla cells) mean
 * none. Interior cells have none: their water is placed (water activators and meshes), and the
 * flag's height (0 in all 138 vanilla interiors that set it) would flood 59 of them, the Dark
 * Brotherhood Sanctuary and the Ragged Flagon among them (CommonLibSSE's
 * TESObjectCELL::GetExteriorWaterHeight is minus infinity indoors).
 */
export function cellWater(
  cell: {
    readonly interior: boolean;
    readonly hasWater: boolean;
    readonly waterHeight: number | undefined;
    readonly waterType: number | undefined;
  },
  world: { readonly height: number | undefined; readonly type: number | undefined } = {
    height: undefined,
    type: undefined,
  },
): CellWater | undefined {
  if (cell.interior || !cell.hasWater) return undefined;
  const xclw = cell.waterHeight;
  let height: number | undefined;
  if (xclw === undefined || xclw >= DEFAULT_HEIGHT) height = world.height;
  else if (Math.abs(xclw) < 1e9) height = xclw;
  if (height === undefined) return undefined;
  return { height, type: cell.waterType ?? world.type };
}
