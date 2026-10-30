// The image-based lens flare of bright lights (bIBLFEnable; image-lens-flare.ts,
// shaders/image-lens-flare.wgsl) as the original lays it out: its [Display] settings, its blur
// kernels, the sizes of its targets and the passes over them. Platform-independent.
//
// Observed in the original: the effect is a chain of image-space passes over the HDR scene
// (before the volumetric light is added), with no list of lights: whatever pixel has a channel
// above fIBLFLightsRangeDownshift feeds it (lamps, candles, fires, the sun, glowing surfaces).
// 1. Downsample to a quarter (4 × 4): of four taps at (±1, ±1) source texels the one with the
//    highest luminance (0.3, 0.59, 0.11), then averaged half and half with the last frame's
//    result at the place the pixel's motion leads to (the "ping" and "pong" targets swap each
//    frame).
// 2. The lights filter: a pixel passes as saturate(colour) where any channel is above the
//    downshift, else black; times fIBLFGlobalIntensity.
// 3. Downsample across to 16 × 4 (four taps at -1.5, -0.5, 0.5, 1.5 texels, the brightest,
//    with the same temporal average).
// 4. The filter again over 16 × 4, the downshift 0, uIBLFLateralRepeat taps either side summed,
//    times the intensity again.
// 5. Downsample across to 32 × 4 (two taps at ±0.5 texels, the brightest, temporal).
// 6. The bloom: the lights filter blurred across then down by uIBLFBloomRadius (1..7), each
//    pass's weights times √fIBLFBloomIntensity (0 in vanilla: black).
// 7. The near streaks: three times the 16 × 4 image blurred across by uIBLFBlurRadiusX and down
//    by uIBLFBlurRadiusY, each pass's weights times √fIBLFAnamorphicsIntensity.
// 8. The far streaks: three times the 32 × 4 image blurred down then across by the same radii,
//    times √fIBLFAnamorphicsIntensityFar.
// 9. The far streaks are added to the near ones, those to the bloom, and the sum is added to
//    the scene (ISCompositeLensFlare, or with the volumetric light ISCompositeLensFlare
//    VolumetricLighting: the volume's amount × its colour + the flare, in one additive pass).
// The engine reads uIBLFLensesCount, fIBLFFlaresDispersal, fIBLFLightsBurn, the channels'
// distortions, fIBLFHaloFetch and fIBLFHaloWidthPow (and the console's ConfigureIBLF sets
// them), and loads Effects\LensFlares\Ramps.dds and Masks.dds, but no pass it draws reads them.

/** The [Display] settings the passes read (their defaults are the engine's). */
export interface ImageLensFlareSettings {
  /** bIBLFEnable. */
  readonly enabled: boolean;
  /** fIBLFLightsRangeDownshift: the channel value a light must pass. */
  readonly downshift: number;
  /** fIBLFGlobalIntensity: the lights filter's scale (applied in both filter passes). */
  readonly intensity: number;
  /** uIBLFLateralRepeat: the second filter's taps either side. */
  readonly lateralRepeat: number;
  /** uIBLFBlurRadiusX / uIBLFBlurRadiusY: the streaks' blur radii (0: that pass is skipped). */
  readonly blurRadiusX: number;
  readonly blurRadiusY: number;
  /** uIBLFBloomRadius (clamped to 1..7) and fIBLFBloomIntensity. */
  readonly bloomRadius: number;
  readonly bloomIntensity: number;
  /** fIBLFAnamorphicsIntensity / fIBLFAnamorphicsIntensityFar. */
  readonly anamorphics: number;
  readonly anamorphicsFar: number;
}

export const IMAGE_LENS_FLARE_DEFAULTS: ImageLensFlareSettings = {
  enabled: true,
  downshift: 1,
  intensity: 0.7,
  lateralRepeat: 0,
  blurRadiusX: 7,
  blurRadiusY: 2,
  bloomRadius: 2,
  bloomIntensity: 0,
  anamorphics: 0.1,
  anamorphicsFar: 1,
};

/** How many times each streak is blurred across and down (a fixed count in the original). */
export const STREAK_ITERATIONS = 3;
/** The most taps a blur takes (radius 7 either side). */
export const MAX_BLUR_TAPS = 15;

/** One blur tap: its offset in source texels and its weight. */
export interface BlurTap {
  readonly offset: number;
  readonly weight: number;
}

/**
 * A blur's taps for a radius setting, as the original builds them: radius 1..7 a Gaussian of
 * 2r + 1 taps with σ = r / 2, normalised to 1; the setting 8 a box of 15 taps (1 / 15 each);
 * above 8 radius 7; 0 none (the pass is skipped).
 */
export function blurTaps(radius: number): readonly BlurTap[] {
  const r = Math.floor(radius);
  if (!(r > 0)) return [];
  if (r === 8) {
    return Array.from({ length: MAX_BLUR_TAPS }, (_, i) => ({
      offset: i - 7,
      weight: 1 / MAX_BLUR_TAPS,
    }));
  }
  const n = Math.min(r, 7);
  const sigma = n / 2;
  const raw = Array.from({ length: 2 * n + 1 }, (_, i) =>
    Math.exp(-((i - n) * (i - n)) / (2 * sigma * sigma)),
  );
  const total = raw.reduce((a, b) => a + b, 0);
  return raw.map((w, i) => ({ offset: i - n, weight: w / total }));
}

/** The bloom's radius: uIBLFBloomRadius held to 1..7 (never the box). */
export function bloomTaps(radius: number): readonly BlurTap[] {
  return blurTaps(Math.min(Math.max(Math.floor(radius) || 1, 1), 7));
}

/** The targets' sizes for a scene of this size (each at least 1 × 1). */
export interface ImageLensFlareSizes {
  /** 4 × 4 down: the first downsample, the lights filter and the bloom. */
  readonly quarter: readonly [number, number];
  /** 16 across, 4 down: the second downsample and the near streaks. */
  readonly near: readonly [number, number];
  /** 32 across, 4 down: the third downsample and the far streaks. */
  readonly far: readonly [number, number];
}

export function imageLensFlareSizes(width: number, height: number): ImageLensFlareSizes {
  const size = (x: number, y: number): readonly [number, number] => [
    Math.max(1, Math.floor(width / x)),
    Math.max(1, Math.floor(height / y)),
  ];
  return { quarter: size(4, 4), near: size(16, 4), far: size(32, 4) };
}

/** The downsample passes' taps (offsets in source texels): the brightest of them is kept. */
export const DOWNSAMPLE_TAPS = {
  /** The scene to 4 × 4: the corners of a 2-texel square. */
  quarter: [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ],
  /** 4 × 4 to 16 × 4: four across. */
  near: [
    [-1.5, 0],
    [-0.5, 0],
    [0.5, 0],
    [1.5, 0],
  ],
  /** 16 × 4 to 32 × 4: two across. */
  far: [
    [-0.5, 0],
    [0.5, 0],
  ],
} as const satisfies Record<string, readonly (readonly [number, number])[]>;

/** The Rec. 601 luminance the downsamples compare their taps by. */
export function tapLuminance(r: number, g: number, b: number): number {
  return 0.3 * r + 0.59 * g + 0.11 * b;
}

/**
 * The lights filter at one pixel (the shader's rule, for tests): saturate(colour) where any
 * channel is above the downshift, else black; times the intensity.
 */
export function lightsFilter(
  color: readonly [number, number, number],
  downshift: number,
  intensity: number,
): [number, number, number] {
  const passes = color.some((c) => c > downshift);
  const sat = (c: number): number => (passes ? Math.min(Math.max(c, 0), 1) * intensity : 0);
  return [sat(color[0]), sat(color[1]), sat(color[2])];
}

/** The settings from an INI reader (missing keys take the engine's defaults). */
export function imageLensFlareSettings(
  read: (key: string) => number | undefined,
): ImageLensFlareSettings {
  const d = IMAGE_LENS_FLARE_DEFAULTS;
  const num = (key: string, fallback: number): number => {
    const v = read(key);
    return v !== undefined && Number.isFinite(v) ? v : fallback;
  };
  const count = (key: string, fallback: number): number =>
    Math.max(0, Math.floor(num(key, fallback)));
  return {
    enabled: num('bIBLFEnable', 1) !== 0,
    downshift: num('fIBLFLightsRangeDownshift', d.downshift),
    intensity: num('fIBLFGlobalIntensity', d.intensity),
    lateralRepeat: count('uIBLFLateralRepeat', d.lateralRepeat),
    blurRadiusX: count('uIBLFBlurRadiusX', d.blurRadiusX),
    blurRadiusY: count('uIBLFBlurRadiusY', d.blurRadiusY),
    bloomRadius: count('uIBLFBloomRadius', d.bloomRadius),
    bloomIntensity: Math.max(0, num('fIBLFBloomIntensity', d.bloomIntensity)),
    anamorphics: Math.max(0, num('fIBLFAnamorphicsIntensity', d.anamorphics)),
    anamorphicsFar: Math.max(0, num('fIBLFAnamorphicsIntensityFar', d.anamorphicsFar)),
  };
}
