// Effect shaders (EFSH): what a magic effect, a script (EffectShader.Play) or a hit shows over an
// actor or an object: a membrane over its surfaces (a fill texture in its colour keys, and an
// edge glowing where the surface turns away), particles off its surfaces (the particle
// shader), addon models and holes burnt into it. Layout after xEdit's wbDefinitionsTES5 (EFSH:
// ICON the fill texture, ICO2 the particle texture, NAM7 the holes texture, NAM8 the membrane
// palette, NAM9 the particle palette; DATA 400 bytes) and CommonLibSSE's EffectShaderData.
// Platform-independent. Notes: docs/gameplay.md ("Magic effects").

import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'formIdAt'>;

type Rgb = readonly [number, number, number];

/** EFSH DATA flags (xEdit). */
export const EffectShaderFlag = {
  noMembraneShader: 0x1,
  membraneGreyscaleColor: 0x2,
  membraneGreyscaleAlpha: 0x4,
  noParticleShader: 0x8,
  edgeEffectInverse: 0x10,
  affectSkinOnly: 0x20,
  ignoreAlpha: 0x40,
  projectUvs: 0x80,
  ignoreBaseGeometryAlpha: 0x100,
  lighting: 0x200,
  noWeapons: 0x400,
  particleAnimated: 0x8000,
  particleGreyscaleColor: 0x10000,
  particleGreyscaleAlpha: 0x20000,
  useBloodGeometry: 0x1000000,
} as const;

/**
 * Blend modes (xEdit wbBlendModeEnum; D3D's): 1 zero, 2 one, 3 source colour, 4 inverse source
 * colour, 5 source alpha, 6 inverse source alpha, 7 destination alpha, 8 inverse destination
 * alpha, 9 destination colour, 10 inverse destination colour, 11 source alpha saturate.
 */
export type BlendMode = number;

/** An alpha's timeline: in, full, out (seconds), then held at the persistent ratio, pulsing. */
export interface AlphaTimeline {
  readonly fadeIn: number;
  readonly full: number;
  readonly fadeOut: number;
  /** The share of the full alpha it keeps after fading out while it plays on. */
  readonly persistent: number;
  readonly pulseAmplitude: number;
  /** Pulses a second. */
  readonly pulseFrequency: number;
  /** The full alpha (0..1). */
  readonly fullRatio: number;
}

export interface EffectShaderRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly flags: number;
  readonly fillTexture: string;
  readonly particleTexture: string;
  readonly holesTexture: string;
  readonly membranePalette: string;
  readonly particlePalette: string;
  readonly membrane: {
    readonly sourceBlend: BlendMode;
    readonly destBlend: BlendMode;
    /** Z test function (xEdit wbZTestFuncEnum: 3 equal, 4 normal, 8 always shown). */
    readonly zTest: number;
    /** Fill colour keys (0..1) with their scales and times (seconds). */
    readonly colors: readonly {
      readonly color: Rgb;
      readonly scale: number;
      readonly time: number;
    }[];
    readonly fill: AlphaTimeline;
    /** Texture scroll (UV per second) and scale. */
    readonly scroll: readonly [number, number];
    readonly scale: readonly [number, number];
    readonly edgeColor: Rgb;
    readonly edgeFalloff: number;
    readonly edge: AlphaTimeline;
  };
  readonly particles: {
    readonly sourceBlend: BlendMode;
    readonly destBlend: BlendMode;
    readonly zTest: number;
    readonly birthRampUp: number;
    readonly fullBirthTime: number;
    readonly birthRampDown: number;
    /** Particles a second while fully born, and kept on after. */
    readonly fullBirthRatio: number;
    readonly persistentCount: number;
    readonly lifetime: number;
    readonly lifetimeVariation: number;
    readonly speedAlongNormal: number;
    readonly speedAlongNormalVariation: number;
    readonly accelerationAlongNormal: number;
    readonly velocity: readonly [number, number, number];
    readonly acceleration: readonly [number, number, number];
    readonly scaleKeys: readonly [number, number];
    readonly scaleTimes: readonly [number, number];
    readonly colors: readonly {
      readonly color: Rgb;
      readonly alpha: number;
      readonly time: number;
    }[];
    /** Degrees, and degrees a second, each with its variation. */
    readonly rotation: number;
    readonly rotationVariation: number;
    readonly rotationSpeed: number;
    readonly rotationSpeedVariation: number;
    /** The texture's atlas: frames across and down. */
    readonly textureCountU: number;
    readonly textureCountV: number;
  };
  readonly addonModels: number | undefined;
  readonly ambientSound: number | undefined;
  /** Its colour's overall scale. */
  readonly colorScale: number;
}

export function parseEffectShader(record: RecordSource): EffectShaderRecord {
  const data = record.fields.first('DATA');
  const view = data ? new DataView(data.buffer, data.byteOffset, data.byteLength) : undefined;
  const f32 = (at: number): number =>
    view && data && data.length >= at + 4 ? view.getFloat32(at, true) : 0;
  const u32 = (at: number): number =>
    view && data && data.length >= at + 4 ? view.getUint32(at, true) : 0;
  const rgb = (at: number): Rgb =>
    data && data.length >= at + 3
      ? [(data[at] ?? 0) / 255, (data[at + 1] ?? 0) / 255, (data[at + 2] ?? 0) / 255]
      : [0, 0, 0];
  const form = (at: number): number | undefined => {
    if (!data || data.length < at + 4) return undefined;
    const formId = record.formIdAt(data, at);
    return formId === 0 ? undefined : formId;
  };
  const text = (type: string): string =>
    (record.fields.zstring(type) ?? '').replaceAll('/', '\\').toLowerCase();
  const timeline = (at: number, ratio: number): AlphaTimeline => ({
    fadeIn: f32(at),
    full: f32(at + 4),
    fadeOut: f32(at + 8),
    persistent: f32(at + 12),
    pulseAmplitude: f32(at + 16),
    pulseFrequency: f32(at + 20),
    fullRatio: f32(ratio),
  });
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    flags: u32(384),
    fillTexture: text('ICON'),
    particleTexture: text('ICO2'),
    holesTexture: text('NAM7'),
    membranePalette: text('NAM8'),
    particlePalette: text('NAM9'),
    membrane: {
      sourceBlend: u32(4),
      destBlend: u32(92),
      zTest: u32(12),
      colors: [
        { color: rgb(16), scale: f32(320), time: f32(332) },
        { color: rgb(312), scale: f32(324), time: f32(336) },
        { color: rgb(316), scale: f32(328), time: f32(340) },
      ],
      fill: timeline(20, 84),
      scroll: [f32(44), f32(48)],
      scale: [f32(388) || 1, f32(392) || 1],
      edgeColor: rgb(56),
      edgeFalloff: f32(52),
      edge: timeline(60, 88),
    },
    particles: {
      sourceBlend: u32(96),
      destBlend: u32(108),
      zTest: u32(104),
      birthRampUp: f32(112),
      fullBirthTime: f32(116),
      birthRampDown: f32(120),
      fullBirthRatio: f32(124),
      persistentCount: f32(128),
      lifetime: f32(132),
      lifetimeVariation: f32(136),
      speedAlongNormal: f32(140),
      speedAlongNormalVariation: f32(224),
      accelerationAlongNormal: f32(144),
      velocity: [f32(148), f32(152), f32(156)],
      acceleration: [f32(160), f32(164), f32(168)],
      scaleKeys: [f32(172), f32(176)],
      scaleTimes: [f32(180), f32(184)],
      colors: [
        { color: rgb(188), alpha: f32(200), time: f32(212) },
        { color: rgb(192), alpha: f32(204), time: f32(216) },
        { color: rgb(196), alpha: f32(208), time: f32(220) },
      ],
      rotation: f32(228),
      rotationVariation: f32(232),
      rotationSpeed: f32(236),
      rotationSpeedVariation: f32(240),
      textureCountU: u32(276),
      textureCountV: u32(280),
    },
    addonModels: form(244),
    ambientSound: form(308),
    colorScale: f32(344) || 1,
  };
}

/**
 * An alpha timeline's value `t` seconds after the shader began (0..1 of its full alpha): it
 * fades in, holds, fades out to its persistent share, pulsing by its amplitude; `ending`
 * seconds after it was told to stop (undefined: playing on) it fades out from there.
 * TODO(M13): the engine's pulse shape (a sine is taken).
 */
export function timelineAlpha(timeline: AlphaTimeline, t: number, ending?: number): number {
  const { fadeIn, full, fadeOut, persistent } = timeline;
  let alpha: number;
  if (t < fadeIn) alpha = fadeIn > 0 ? t / fadeIn : 1;
  else if (t < fadeIn + full) alpha = 1;
  else if (t < fadeIn + full + fadeOut)
    alpha = 1 - (1 - persistent) * ((t - fadeIn - full) / Math.max(fadeOut, 1e-6));
  else alpha = persistent;
  if (ending !== undefined) {
    const out = fadeOut > 0 ? Math.max(0, 1 - ending / fadeOut) : 0;
    alpha = Math.min(alpha, out);
  }
  const pulse =
    timeline.pulseAmplitude > 0
      ? 1 + timeline.pulseAmplitude * Math.sin(2 * Math.PI * timeline.pulseFrequency * t) * 0.5
      : 1;
  return Math.max(0, alpha * pulse) * (timeline.fullRatio > 0 ? timeline.fullRatio : 1);
}

/** A membrane fill colour at `t` seconds (its keys: colour × scale, between their times). */
export function fillColor(shader: EffectShaderRecord, t: number): Rgb {
  const keys = shader.membrane.colors;
  const scaled = keys.map(({ color, scale }): Rgb => [
    color[0] * scale,
    color[1] * scale,
    color[2] * scale,
  ]);
  const first = keys[0];
  if (!first || t <= first.time) return scaled[0] ?? [1, 1, 1];
  for (let i = 1; i < keys.length; i++) {
    const key = keys[i];
    const before = keys[i - 1];
    if (!key || !before || key.time <= before.time) continue;
    if (t <= key.time) {
      const s = (t - before.time) / (key.time - before.time);
      const a = scaled[i - 1] ?? [1, 1, 1];
      const b = scaled[i] ?? [1, 1, 1];
      return [a[0] + (b[0] - a[0]) * s, a[1] + (b[1] - a[1]) * s, a[2] + (b[2] - a[2]) * s];
    }
  }
  const last = keys.reduce((best, key, i) => (key.time >= (keys[best]?.time ?? 0) ? i : best), 0);
  return scaled[last] ?? [1, 1, 1];
}
