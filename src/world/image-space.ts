// Imagespaces (IMGS): the HDR, cinematic and tint settings of the final image, per weather
// time of day or per interior cell. Platform-independent.
// Layout: docs/formats/esm.md ("Imagespaces"); UESP "Skyrim Mod:Mod File Format/IMGS".

import { view } from '../formats/esm/fields.ts';
import type { GameRecord } from './record-db.ts';
import type { Rgb } from './weather.ts';

export interface ImageSpaceHdr {
  readonly eyeAdaptSpeed: number;
  readonly bloomBlurRadius: number;
  readonly bloomThreshold: number;
  readonly bloomScale: number;
  readonly receiveBloomThreshold: number;
  readonly white: number;
  readonly sunlightScale: number;
  readonly skyScale: number;
  readonly eyeAdaptStrength: number;
}

/**
 * Which side of the focus distance the depth of field blurs (ImageSpaceModifierInstanceDOF's
 * DepthOfFieldMode). Imagespaces blur the distance ('back'); modifiers may pick any.
 */
export type DepthOfFieldMode = 'frontBack' | 'front' | 'back' | 'none';

/**
 * What image-space modifiers (IMAD) do beyond the imagespace's own values (the engine's
 * ImageSpaceModData): a full-screen colour faded over the image, blur, double vision, radial
 * blur and full-screen motion blur. Built by src/world/image-space-modifiers.ts.
 */
export interface ScreenEffects {
  /** Fade colour (rgb) laid over the finished image by `fadeAmount` (0..1). */
  readonly fadeColor: Rgb;
  readonly fadeAmount: number;
  /** Full-screen blur radius 0..7 (0: none). */
  readonly blurRadius: number;
  /** Double vision strength (0: none; vanilla 0..0.1). */
  readonly doubleVision: number;
  readonly radialBlur: {
    readonly strength: number;
    readonly rampUp: number;
    readonly start: number;
    readonly rampDown: number;
    readonly downStart: number;
    /** Centre on the screen (0..1, y down). */
    readonly center: readonly [number, number];
  };
  /** Full-screen motion blur strength (0: none; vanilla 0..10). */
  readonly motionBlur: number;
}

export interface ImageSpace {
  readonly hdr: ImageSpaceHdr;
  readonly saturation: number;
  readonly brightness: number;
  readonly contrast: number;
  readonly tintAmount: number;
  readonly tintColor: Rgb;
  readonly depthOfField: {
    readonly strength: number;
    readonly distance: number;
    readonly range: number;
    /** Blur radius 0..7. */
    readonly blurRadius: number;
    /** Whether the sky is blurred too (else only beside geometry). */
    readonly sky: boolean;
    /**
     * The world map's blur instead (ISWorldMap: src/shell/world-map-view.ts): a 7×7 box whose
     * step (pixels) grows by `scale` per unit away from `focal`, up to `maxBlur`, times
     * `nearScale` before it; the sky too unless `sky` is false.
     */
    readonly worldMap?: {
      readonly focal: number;
      readonly maxBlur: number;
      readonly scale: number;
      readonly nearScale: number;
    };
    /** Which side of the focus is blurred; absent: the distance ('back'). */
    readonly mode?: DepthOfFieldMode;
  };
  /** The image-space modifiers' screen effects; absent: none. */
  readonly effects?: ScreenEffects;
}

/** DefaultImageSpaceInterior (Skyrim.esm): interiors without XCIM use it. */
export const DEFAULT_INTERIOR_IMAGE_SPACE = 0x160;

/** No change to the image: no adaptation or bloom, identity tone curve and grading. */
export const NEUTRAL_IMAGE_SPACE: ImageSpace = {
  hdr: {
    eyeAdaptSpeed: 0,
    bloomBlurRadius: 0,
    bloomThreshold: 1,
    bloomScale: 0,
    receiveBloomThreshold: 0,
    white: 1,
    sunlightScale: 1,
    skyScale: 1,
    eyeAdaptStrength: 0,
  },
  saturation: 1,
  brightness: 1,
  contrast: 1,
  tintAmount: 0,
  tintColor: [1, 1, 1],
  depthOfField: { strength: 0, distance: 0, range: 0, blurRadius: 0, sky: true },
};

/** Screen effects that change nothing. */
export const NO_SCREEN_EFFECTS: ScreenEffects = {
  fadeColor: [0, 0, 0],
  fadeAmount: 0,
  blurRadius: 0,
  doubleVision: 0,
  radialBlur: { strength: 0, rampUp: 0, start: 0, rampDown: 0, downStart: 0, center: [0.5, 0.5] },
  motionBlur: 0,
};

/**
 * DNAM's fourth value (f32) packs the blur radius and the "no sky" flag:
 * 2 + 8 × radius + 4 × no sky (vanilla values 2, 6, 22, 30, 34, 38, 42).
 */
export function depthOfFieldBlur(value: number | undefined): { blurRadius: number; sky: boolean } {
  if (value === undefined || !Number.isFinite(value) || value < 2) {
    return { blurRadius: 0, sky: true };
  }
  const code = Math.round((value - 2) / 4);
  return { blurRadius: Math.min(7, code >> 1), sky: (code & 1) === 0 };
}

export function parseImageSpace(record: Pick<GameRecord, 'fields'>): ImageSpace {
  const floats = (type: string): number[] => {
    const data = record.fields.first(type);
    if (!data) return [];
    const d = view(data);
    return Array.from({ length: Math.floor(data.length / 4) }, (_, i) => d.getFloat32(i * 4, true));
  };
  const n = NEUTRAL_IMAGE_SPACE;
  const hnam = floats('HNAM');
  const cnam = floats('CNAM');
  const tnam = floats('TNAM');
  const dnam = floats('DNAM');
  const enam = floats('ENAM');
  // ENAM (two vanilla records) packs HDR and cinematic values without White and Eye Adapt
  // Strength: speed, blur radius, threshold, scale, receive threshold, sunlight scale, sky
  // scale, saturation, brightness, contrast.
  const at = (values: number[], index: number, fallback: number): number =>
    values[index] ?? fallback;
  const hdr: ImageSpaceHdr =
    hnam.length > 0 || enam.length === 0
      ? {
          eyeAdaptSpeed: at(hnam, 0, n.hdr.eyeAdaptSpeed),
          bloomBlurRadius: at(hnam, 1, n.hdr.bloomBlurRadius),
          bloomThreshold: at(hnam, 2, n.hdr.bloomThreshold),
          bloomScale: at(hnam, 3, n.hdr.bloomScale),
          receiveBloomThreshold: at(hnam, 4, n.hdr.receiveBloomThreshold),
          white: at(hnam, 5, n.hdr.white),
          sunlightScale: at(hnam, 6, n.hdr.sunlightScale),
          skyScale: at(hnam, 7, n.hdr.skyScale),
          eyeAdaptStrength: at(hnam, 8, n.hdr.eyeAdaptStrength),
        }
      : {
          eyeAdaptSpeed: at(enam, 0, n.hdr.eyeAdaptSpeed),
          bloomBlurRadius: at(enam, 1, n.hdr.bloomBlurRadius),
          bloomThreshold: at(enam, 2, n.hdr.bloomThreshold),
          bloomScale: at(enam, 3, n.hdr.bloomScale),
          receiveBloomThreshold: at(enam, 4, n.hdr.receiveBloomThreshold),
          white: n.hdr.white,
          sunlightScale: at(enam, 5, n.hdr.sunlightScale),
          skyScale: at(enam, 6, n.hdr.skyScale),
          eyeAdaptStrength: n.hdr.eyeAdaptStrength,
        };
  const cinematic = cnam.length > 0 ? cnam : enam.slice(7, 10);
  return {
    hdr,
    saturation: at(cinematic, 0, n.saturation),
    brightness: at(cinematic, 1, n.brightness),
    contrast: at(cinematic, 2, n.contrast),
    tintAmount: at(tnam, 0, n.tintAmount),
    tintColor: [at(tnam, 1, 1), at(tnam, 2, 1), at(tnam, 3, 1)],
    depthOfField: {
      strength: at(dnam, 0, 0),
      distance: at(dnam, 1, 0),
      range: at(dnam, 2, 0),
      ...depthOfFieldBlur(dnam[3]),
    },
  };
}

/** Weighted blend of imagespaces (weights need not add up to 1). */
export function blendImageSpaces(
  list: readonly { readonly space: ImageSpace; readonly weight: number }[],
): ImageSpace {
  const total = list.reduce((sum, entry) => sum + entry.weight, 0);
  if (total <= 0) return NEUTRAL_IMAGE_SPACE;
  const mix = (pick: (space: ImageSpace) => number): number =>
    list.reduce((sum, entry) => sum + pick(entry.space) * entry.weight, 0) / total;
  const hdr = (key: keyof ImageSpaceHdr): number => mix((space) => space.hdr[key]);
  return {
    hdr: {
      eyeAdaptSpeed: hdr('eyeAdaptSpeed'),
      bloomBlurRadius: hdr('bloomBlurRadius'),
      bloomThreshold: hdr('bloomThreshold'),
      bloomScale: hdr('bloomScale'),
      receiveBloomThreshold: hdr('receiveBloomThreshold'),
      white: hdr('white'),
      sunlightScale: hdr('sunlightScale'),
      skyScale: hdr('skyScale'),
      eyeAdaptStrength: hdr('eyeAdaptStrength'),
    },
    saturation: mix((s) => s.saturation),
    brightness: mix((s) => s.brightness),
    contrast: mix((s) => s.contrast),
    tintAmount: mix((s) => s.tintAmount),
    tintColor: [mix((s) => s.tintColor[0]), mix((s) => s.tintColor[1]), mix((s) => s.tintColor[2])],
    depthOfField: {
      strength: mix((s) => s.depthOfField.strength),
      distance: mix((s) => s.depthOfField.distance),
      range: mix((s) => s.depthOfField.range),
      blurRadius: Math.round(mix((s) => s.depthOfField.blurRadius)),
      sky: mix((s) => (s.depthOfField.sky ? 1 : 0)) >= 0.5,
    },
  };
}
