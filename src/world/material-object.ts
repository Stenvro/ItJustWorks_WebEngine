// Directional materials: snow, ash, moss and ice that the engine lays over the upward-facing
// parts of statics (STAT DNAM names a material object, MATO). Platform-independent.
// Notes: docs/formats/esm.md ("Directional materials").

/** The record fields material objects and statics are read from. */
interface RecordSource {
  readonly formId: number;
  readonly editorId?: string | undefined;
  readonly fields: {
    first(type: string): Uint8Array | undefined;
    all(type: string): Uint8Array[];
  };
  /** A form id stored in the record's data, as a global form id. */
  formIdAt(data: Uint8Array, offset?: number): number;
}

/** MATO DATA (BSMaterialObject::DIRECTIONAL_DATA). */
export interface MaterialObject {
  readonly formId: number;
  readonly editorId: string;
  /** How much the noise texture breaks up the edge of the material. */
  readonly falloffScale: number;
  /** How far a surface must face the projection before it gets the material. */
  readonly falloffBias: number;
  /** World units per repeat of the noise texture. */
  readonly noiseUVScale: number;
  /** World units per repeat of the material's own textures (multi-pass). */
  readonly materialUVScale: number;
  /** The direction the material falls in (multi-pass: surfaces facing against it get it). */
  readonly projectionVector: readonly [number, number, number];
  /** Multi-pass: how much of the material's normal map is kept (0 flat .. 1 full). */
  readonly normalDampener: number;
  /** Single pass: the material's colour (0..1). */
  readonly singlePassColor: readonly [number, number, number];
  /**
   * Single pass: the static's own shader blends to the colour (or the engine's projected
   * textures). Otherwise the static is drawn a second time with the material's shader.
   */
  readonly singlePass: boolean;
  /** DATA flags bit 0: the material is snow (no vanilla record sets it). */
  readonly snow: boolean;
  /**
   * DNAM: the material's shader properties as embedded NIF files (a BSLightingShaderProperty
   * or BSEffectShaderProperty, and an NiAlphaProperty); used by multi-pass materials.
   */
  readonly properties: readonly Uint8Array[];
}

export function parseMaterialObject(record: RecordSource): MaterialObject {
  const data = record.fields.first('DATA') ?? new Uint8Array(0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const f = (offset: number, fallback = 0): number =>
    offset + 4 <= data.length ? view.getFloat32(offset, true) : fallback;
  const u = (offset: number): number =>
    offset + 4 <= data.length ? view.getUint32(offset, true) : 0;
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    falloffScale: f(0),
    falloffBias: f(4),
    noiseUVScale: f(8, 1),
    materialUVScale: f(12, 1),
    projectionVector: [f(16), f(20), f(24, -1)],
    normalDampener: f(28, 1),
    singlePassColor: [f(32), f(36), f(40)],
    singlePass: u(44) !== 0,
    // The 48-byte records of the DLCs end before the flags.
    snow: (u(48) & 1) !== 0,
    properties: record.fields.all('DNAM'),
  };
}

/** STAT DNAM: the static's directional material. */
export interface StaticDirectional {
  /** Degrees (30..120): how far from the projection a surface may face and still get it. */
  readonly maxAngle: number;
  /** MATO form id. */
  readonly material: number;
  /** SSE flag: the object counts as snow (the snow shader's mask, rim light and sparkles). */
  readonly consideredSnow: boolean;
}

/** The directional material of a STAT, if it has one (DNAM with a material object). */
export function parseStaticDirectional(record: RecordSource): StaticDirectional | undefined {
  const data = record.fields.first('DNAM');
  if (!data || data.length < 8) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rawMaterial = view.getUint32(4, true);
  const consideredSnow = data.length >= 12 && (view.getUint32(8, true) & 1) !== 0;
  if (rawMaterial === 0 && !consideredSnow) return undefined;
  return {
    maxAngle: view.getFloat32(0, true),
    material: rawMaterial === 0 ? 0 : record.formIdAt(data, 4),
    consideredSnow,
  };
}

/**
 * ProjectedUVParams of the lighting shader for a material laid on at `maxAngle` degrees:
 * x scales the noise, z is the noise texture's repeat per world unit and w the threshold
 * a surface must pass, `dot(normal, up) · vertex alpha − x · noise − w > 0`.
 * The engine computes (1 − a)·r, b and (1 − a)·g + a from an NiColorA (Nukem9's decompiled
 * BSLightingShader::GeometrySetupConstantProjectedUVData). r = falloff scale, g = falloff bias
 * and b = 1 / noise UV scale follow from the units; a = cos(max angle) is inferred: at 90° the
 * material's own values apply unchanged, smaller angles raise the threshold towards 1 (only
 * flat tops) and larger ones lower it (see docs/formats/esm.md).
 */
export function projectedUVParams(
  material: MaterialObject,
  maxAngle: number,
): readonly [number, number, number, number] {
  const a = Math.cos((maxAngle * Math.PI) / 180);
  return [
    (1 - a) * material.falloffScale,
    0,
    material.noiseUVScale > 0 ? 1 / material.noiseUVScale : 0,
    (1 - a) * material.falloffBias + a,
  ];
}

/**
 * The material objects of object LOD, by plugin and id (no record refers to them; the engine
 * knows them): snow on shapes named "objsnow", HD snow on "objsnowHD" and ash (Solstheim) on
 * "objash" and "objashHD".
 */
export const LOD_MATERIALS = {
  snow: { plugin: 'Skyrim.esm', id: 0x050372 },
  snowHd: { plugin: 'Skyrim.esm', id: 0x06ae38 },
  ash: { plugin: 'Dragonborn.esm', id: 0x032720 },
} as const;
/** fLODSnowThresholdAngle: the max angle of LOD snow. */
export const LOD_SNOW_THRESHOLD_ANGLE = 100;
/** fHDLODSnowThresholdAngle: the max angle of HD LOD snow. */
export const HD_LOD_SNOW_THRESHOLD_ANGLE = 87;
