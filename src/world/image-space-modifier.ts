// Image-space modifiers (IMAD): keyframed changes to the final image that spells, explosions,
// scripts and the engine (menus, low health) lay over the cell's or weather's imagespace.
// Parsing and evaluation at a point of the modifier's timeline. Platform-independent.
// Layout: docs/formats/esm.md ("Image-space modifiers"); xEdit wbDefinitionsTES5.pas (IMAD),
// CommonLibSSE TESImageSpaceModifier / ImageSpaceModifierData. Combining active modifiers onto
// an imagespace: src/world/image-space-modifiers.ts.

import { view } from '../formats/esm/fields.ts';
import type { DepthOfFieldMode, ImageSpaceHdr } from './image-space.ts';
import type { GameRecord } from './record-db.ts';

/** A key of a float curve: `time` is a share of the modifier's duration (0..1). */
export interface FloatKey {
  readonly time: number;
  readonly value: number;
}

export type Rgba = readonly [number, number, number, number];

/** A key of a colour curve (TNAM tint, NAM3 fade): rgb and alpha, 0..1 each. */
export interface ColorKey {
  readonly time: number;
  readonly color: Rgba;
}

/** One multiply/add channel: the value becomes value × mult + add. */
export interface MultAddCurves {
  readonly mult: readonly FloatKey[];
  readonly add: readonly FloatKey[];
}

/** The 21 multiply/add channels of DNAM: 17 HDR (most unused), then 4 cinematic. */
export const IMAD_CHANNEL_COUNT = 21;

/**
 * The HDR channel of each imagespace HDR value. xEdit and CommonLibSSE keep Fallout's names for
 * channels 4 and 5 ("Target Lum Min/Max"); they sit where the imagespace (HNAM) has Receive
 * Bloom Threshold and White, and channel 8 (unused by vanilla modifiers but ISMExterior) where
 * it has Eye Adapt Strength, so they are read as those.
 * TODO(M13): check the positional mapping of channels 4, 5 and 8 against the game.
 */
export const IMAD_HDR_CHANNELS: Readonly<Record<keyof ImageSpaceHdr, number>> = {
  eyeAdaptSpeed: 0,
  bloomBlurRadius: 1,
  bloomThreshold: 2,
  bloomScale: 3,
  receiveBloomThreshold: 4,
  white: 5,
  sunlightScale: 6,
  skyScale: 7,
  eyeAdaptStrength: 8,
};

/** The cinematic channels (17..19; 20 is unused). */
export const IMAD_CINEMATIC_CHANNELS = { saturation: 17, brightness: 18, contrast: 19 } as const;

export interface ImageSpaceModifier {
  readonly formId: number;
  readonly editorId: string;
  /** Animated over `duration`; otherwise static (the keys at time 0) until removed. */
  readonly animatable: boolean;
  /** Seconds the animation takes (ignored unless animatable; 0 keeps time 0). */
  readonly duration: number;
  /** Multiply/add channels by index (IMAD_HDR_CHANNELS, IMAD_CINEMATIC_CHANNELS). */
  readonly channels: readonly MultAddCurves[];
  /** Tint colour: alpha is the tint amount. */
  readonly tint: readonly ColorKey[];
  /** Fade colour laid over the finished image by its alpha. */
  readonly fade: readonly ColorKey[];
  /** Full-screen blur radius (0..7). */
  readonly blurRadius: readonly FloatKey[];
  readonly doubleVision: readonly FloatKey[];
  readonly radialBlur: {
    readonly strength: readonly FloatKey[];
    readonly rampUp: readonly FloatKey[];
    readonly start: readonly FloatKey[];
    readonly rampDown: readonly FloatKey[];
    readonly downStart: readonly FloatKey[];
    /** Centre on the screen (0..1). */
    readonly center: readonly [number, number];
    /** Centred on the modifier's target (an explosion, a spell's target) instead. */
    readonly useTarget: boolean;
  };
  readonly depthOfField: {
    readonly strength: readonly FloatKey[];
    readonly distance: readonly FloatKey[];
    readonly range: readonly FloatKey[];
    /** Focused on the modifier's target instead of the distance. */
    readonly useTarget: boolean;
    readonly mode: DepthOfFieldMode;
    /** Whether the sky is blurred too. */
    readonly sky: boolean;
    /** Blur radius 0..7. */
    readonly blurRadius: number;
  };
  /** Full-screen motion blur strength. */
  readonly motionBlur: readonly FloatKey[];
}

/** A channel's factor and summand at one point of the timeline. */
export interface MultAdd {
  readonly mult: number;
  readonly add: number;
}

/** What a modifier does at one point of its timeline (at full strength). */
export interface ModifierFrame {
  readonly hdr: Readonly<Record<keyof ImageSpaceHdr, MultAdd>>;
  readonly saturation: MultAdd;
  readonly brightness: MultAdd;
  readonly contrast: MultAdd;
  readonly tint: Rgba;
  readonly fade: Rgba;
  readonly blurRadius: number;
  readonly doubleVision: number;
  readonly radialBlur: {
    readonly strength: number;
    readonly rampUp: number;
    readonly start: number;
    readonly rampDown: number;
    readonly downStart: number;
    readonly center: readonly [number, number];
    readonly useTarget: boolean;
  };
  readonly depthOfField: {
    readonly strength: number;
    readonly distance: number;
    readonly range: number;
    readonly mode: DepthOfFieldMode;
    readonly sky: boolean;
    readonly blurRadius: number;
    readonly useTarget: boolean;
  };
  readonly motionBlur: number;
}

/** DNAM size in Skyrim SE (ImageSpaceModifierData). */
export const IMAD_DNAM_SIZE = 0xf4;

const DOF_MODES: readonly DepthOfFieldMode[] = ['frontBack', 'front', 'back', 'none'];

/** The multiply/add subrecords of channel `index`: "\x00IAD".."\x14IAD" and "@IAD".."TIAD". */
export const channelSignatures = (index: number): { mult: string; add: string } => ({
  mult: `${String.fromCharCode(index)}IAD`,
  add: `${String.fromCharCode(0x40 + index)}IAD`,
});

const byTime = <T extends { readonly time: number }>(keys: T[]): T[] =>
  keys.sort((a, b) => a.time - b.time);

function floatKeys(data: Uint8Array | undefined): FloatKey[] {
  if (!data) return [];
  const d = view(data);
  return byTime(
    Array.from({ length: Math.floor(data.length / 8) }, (_, i) => ({
      time: d.getFloat32(i * 8, true),
      value: d.getFloat32(i * 8 + 4, true),
    })),
  );
}

function colorKeys(data: Uint8Array | undefined): ColorKey[] {
  if (!data) return [];
  const d = view(data);
  const f = (offset: number): number => d.getFloat32(offset, true);
  return byTime(
    Array.from({ length: Math.floor(data.length / 20) }, (_, i) => {
      const at = i * 20;
      return { time: f(at), color: [f(at + 4), f(at + 8), f(at + 12), f(at + 16)] as const };
    }),
  );
}

/**
 * Reads an IMAD record. DNAM's key counts repeat the subrecords' sizes (vanilla: always equal),
 * so the keys are read from the subrecords; a short or missing DNAM leaves its flags at their
 * defaults.
 */
export function parseImageSpaceModifier(
  record: Pick<GameRecord, 'fields' | 'formId' | 'editorId'>,
): ImageSpaceModifier {
  const { fields } = record;
  const dnam = fields.first('DNAM');
  const d = dnam ? view(dnam) : undefined;
  const u8 = (offset: number): number => (d && offset < d.byteLength ? d.getUint8(offset) : 0);
  const f32 = (offset: number, fallback: number): number =>
    d && offset + 4 <= d.byteLength ? d.getFloat32(offset, true) : fallback;
  const dofFlags = u8(0xe1);
  const keys = (type: string): FloatKey[] => floatKeys(fields.first(type));
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    animatable: u8(0x00) !== 0,
    duration: Math.max(0, f32(0x04, 0)),
    channels: Array.from({ length: IMAD_CHANNEL_COUNT }, (_, index) => {
      const signatures = channelSignatures(index);
      return { mult: keys(signatures.mult), add: keys(signatures.add) };
    }),
    tint: colorKeys(fields.first('TNAM')),
    fade: colorKeys(fields.first('NAM3')),
    blurRadius: keys('BNAM'),
    doubleVision: keys('VNAM'),
    radialBlur: {
      strength: keys('RNAM'),
      rampUp: keys('SNAM'),
      start: keys('UNAM'),
      rampDown: keys('NAM1'),
      downStart: keys('NAM2'),
      center: [f32(0xcc, 0.5), f32(0xd0, 0.5)],
      useTarget: u8(0xc8) !== 0,
    },
    depthOfField: {
      strength: keys('WNAM'),
      distance: keys('XNAM'),
      range: keys('YNAM'),
      useTarget: u8(0xe0) !== 0,
      // Flags: mode in bits 0-1 (DepthOfFieldMode), "no sky" bit 2, and bits 3-5 (xEdit:
      // unknown) read as the blur radius 0..7 the Creation Kit's form has.
      // TODO(M13): check bits 3-5 against the game (vanilla values 0x20, 0x38, 0x0a).
      mode: DOF_MODES[dofFlags & 3] ?? 'frontBack',
      sky: (dofFlags & 4) === 0,
      blurRadius: (dofFlags >> 3) & 7,
    },
    motionBlur: keys('NAM4'),
  };
}

/** A curve's value at `time`: linear between keys, held before the first and after the last. */
export function sampleFloat(keys: readonly FloatKey[], time: number, fallback: number): number {
  const first = keys[0];
  if (!first) return fallback;
  if (time <= first.time) return first.value;
  for (let i = 1; i < keys.length; i++) {
    const next = keys[i];
    const previous = keys[i - 1];
    if (!next || !previous) break;
    if (time <= next.time) {
      const span = next.time - previous.time;
      const t = span > 0 ? (time - previous.time) / span : 1;
      return previous.value + (next.value - previous.value) * t;
    }
  }
  return keys[keys.length - 1]?.value ?? fallback;
}

/** A colour curve's value at `time` (linear per component, held at the ends). */
export function sampleColor(keys: readonly ColorKey[], time: number, fallback: Rgba): Rgba {
  const first = keys[0];
  if (!first) return fallback;
  if (time <= first.time) return first.color;
  for (let i = 1; i < keys.length; i++) {
    const next = keys[i];
    const previous = keys[i - 1];
    if (!next || !previous) break;
    if (time <= next.time) {
      const span = next.time - previous.time;
      const t = span > 0 ? (time - previous.time) / span : 1;
      const [r, g, b, a] = previous.color;
      const [nr, ng, nb, na] = next.color;
      return [r + (nr - r) * t, g + (ng - g) * t, b + (nb - b) * t, a + (na - a) * t];
    }
  }
  return keys[keys.length - 1]?.color ?? fallback;
}

/**
 * Where on its timeline (0..1, the keys' time) a modifier is `seconds` after it was applied.
 * Static modifiers (not animatable, or no duration) stay at 0; animated ones run once over
 * their duration and hold the end, or start over when `loop`.
 */
export function modifierKeyTime(
  modifier: Pick<ImageSpaceModifier, 'animatable' | 'duration'>,
  seconds: number,
  loop = false,
): number {
  if (!modifier.animatable || modifier.duration <= 0) return 0;
  const share = Math.max(0, seconds) / modifier.duration;
  return loop ? share - Math.floor(share) : Math.min(1, share);
}

/** Whether an animated modifier has played its duration (a static one never has). */
export function modifierFinished(
  modifier: Pick<ImageSpaceModifier, 'animatable' | 'duration'>,
  seconds: number,
): boolean {
  return modifier.animatable && modifier.duration > 0 && seconds >= modifier.duration;
}

const NO_COLOR: Rgba = [1, 1, 1, 0];

/** What a modifier does at a point of its timeline (`time`: 0..1, see modifierKeyTime). */
export function evaluateModifier(modifier: ImageSpaceModifier, time: number): ModifierFrame {
  const channel = (index: number): MultAdd => {
    const curves = modifier.channels[index];
    return {
      mult: curves ? sampleFloat(curves.mult, time, 1) : 1,
      add: curves ? sampleFloat(curves.add, time, 0) : 0,
    };
  };
  const value = (keys: readonly FloatKey[]): number => sampleFloat(keys, time, 0);
  const h = IMAD_HDR_CHANNELS;
  const c = IMAD_CINEMATIC_CHANNELS;
  const radial = modifier.radialBlur;
  const field = modifier.depthOfField;
  return {
    hdr: {
      eyeAdaptSpeed: channel(h.eyeAdaptSpeed),
      bloomBlurRadius: channel(h.bloomBlurRadius),
      bloomThreshold: channel(h.bloomThreshold),
      bloomScale: channel(h.bloomScale),
      receiveBloomThreshold: channel(h.receiveBloomThreshold),
      white: channel(h.white),
      sunlightScale: channel(h.sunlightScale),
      skyScale: channel(h.skyScale),
      eyeAdaptStrength: channel(h.eyeAdaptStrength),
    },
    saturation: channel(c.saturation),
    brightness: channel(c.brightness),
    contrast: channel(c.contrast),
    tint: sampleColor(modifier.tint, time, NO_COLOR),
    fade: sampleColor(modifier.fade, time, NO_COLOR),
    blurRadius: value(modifier.blurRadius),
    doubleVision: value(modifier.doubleVision),
    radialBlur: {
      strength: value(radial.strength),
      rampUp: value(radial.rampUp),
      start: value(radial.start),
      rampDown: value(radial.rampDown),
      downStart: value(radial.downStart),
      center: radial.center,
      useTarget: radial.useTarget,
    },
    depthOfField: {
      strength: value(field.strength),
      distance: value(field.distance),
      range: value(field.range),
      mode: field.mode,
      sky: field.sky,
      blurRadius: field.blurRadius,
      useTarget: field.useTarget,
    },
    motionBlur: value(modifier.motionBlur),
  };
}
