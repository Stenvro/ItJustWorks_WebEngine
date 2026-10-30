// The volumetric lighting's froxel volume as the original lays it out (volumetric-volume.ts,
// shaders/volumetric.wgsl): its size by quality, how its depth slices are spread along the view,
// the density noise and how the noise drifts. Platform-independent.

type Vec3 = readonly [number, number, number];

/**
 * The volume's froxels (width, height, depth slices) by [Display] iVolumetricLightingQuality:
 * Low (0), Medium (1, the default), High (2); the iVolumetricLightingTexture{Width,Height,Depth}
 * {Low,Medium,High} defaults.
 */
export const VOLUME_SIZES: readonly (readonly [number, number, number])[] = [
  [160, 96, 50],
  [224, 128, 70],
  [320, 192, 90],
];

/** The froxel size of a quality setting (out of range: Medium). */
export function volumeSize(quality: number): readonly [number, number, number] {
  const index = Number.isInteger(quality) && quality >= 0 && quality <= 2 ? quality : 1;
  return VOLUME_SIZES[index] ?? [224, 128, 70];
}

/**
 * The near plane the volume's depth is measured with: [Display] fNearDistance. The original's
 * slices are spread over its camera's clip depth, so they keep its near plane whatever ours is.
 */
export const VOLUME_NEAR = 15;
/** The farthest view distance a slice reaches (the clip depth's 1 is at infinity). */
export const VOLUME_MAX_DISTANCE = 400000;
/** Entries of the original's depth tables (both directions). */
export const DEPTH_TABLE_SIZE = 4096;
/** The noise volume's size ([Display] iVolumetricLightingNoiseTexture{Width,Height,Depth}). */
export const NOISE_SIZE = 32;
/**
 * The share of the last frame kept in each froxel: [Display]
 * fVolumetricLightingTemporalAccumulationFactor (bVolumetricLightingEnableTemporalAccumulation).
 */
export const TEMPORAL_FACTOR = 0.75;
/** Frames of the slice jitter's cycle (the frame index modulo 8). */
export const JITTER_FRAMES = 8;

/**
 * The clip depth (0 at the near plane, 1 at infinity) of a slice coordinate s (0..1): s to the
 * power 1 / the range factor (VOLI NNAM; 40 in vanilla). The original keeps this as a 4096-entry
 * table the generate pass reads; with 40 the slices crowd near the camera and thin out with
 * distance, half of them within some 900 units.
 */
export function sliceClipDepth(s: number, rangeFactor: number): number {
  const r = rangeFactor > 0 ? rangeFactor : 40;
  return Math.pow(Math.max(0, Math.min(1, s)), 1 / r);
}

/** The slice coordinate of a clip depth: its inverse, the clip depth to the range factor. */
export function clipDepthSlice(depth: number, rangeFactor: number): number {
  const r = rangeFactor > 0 ? rangeFactor : 40;
  return Math.pow(Math.max(0, Math.min(1, depth)), r);
}

/** The view distance of a clip depth (D3D's 0..1 with the far plane at infinity). */
export function clipDepthDistance(depth: number): number {
  return depth >= 1
    ? VOLUME_MAX_DISTANCE
    : Math.min(VOLUME_MAX_DISTANCE, VOLUME_NEAR / (1 - depth));
}

/** The clip depth of a view distance (0 at and before the near plane). */
export function distanceClipDepth(distance: number): number {
  return distance <= VOLUME_NEAR ? 0 : 1 - VOLUME_NEAR / distance;
}

/** The view distance of a slice coordinate. */
export function sliceDistance(s: number, rangeFactor: number): number {
  return clipDepthDistance(sliceClipDepth(s, rangeFactor));
}

/**
 * Where the k-th slice is sampled this frame: the frame index modulo 8 moves the samples
 * through the slice (the temporal blend averages them).
 */
export function sliceJitter(frame: number): number {
  return ((frame % JITTER_FRAMES) + 0.5) / JITTER_FRAMES;
}

/**
 * One frame's drift of the density noise (world units, added to the offset the noise is read
 * at): it moves with the weather's wind by the frame time × the density size × the wind speed
 * (VOLI JNAM) and falls by the falling speed (KNAM) × the frame time × the density size, each
 * times a random share of 0..1 (`random`). `wind`: the wind's direction on the ground (unit)
 * times the weather's wind speed (0..1).
 */
export function noiseDrift(
  dt: number,
  densitySize: number,
  windSpeed: number,
  fallingSpeed: number,
  wind: readonly [number, number],
  random: () => number,
): Vec3 {
  const step = dt * densitySize;
  return [
    -random() * wind[0] * windSpeed * step,
    random() * wind[1] * windSpeed * step,
    random() * fallingSpeed * step,
  ];
}

/**
 * The density noise: a 32³ volume of tileable value noise in two octaves (bytes, 0..255),
 * the same each session (a fixed seed). TODO(M13): the original fills its noise volume on the
 * GPU at load; its function is unread.
 */
export function densityNoise(size = NOISE_SIZE, seed = 0x5eed): Uint8Array {
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const octave = (cells: number): Float32Array => {
    const lattice = Float32Array.from({ length: cells * cells * cells }, next);
    const out = new Float32Array(size * size * size);
    const at = (x: number, y: number, z: number): number =>
      lattice[(x % cells) + (y % cells) * cells + (z % cells) * cells * cells] ?? 0;
    const smooth = (t: number): number => t * t * (3 - 2 * t);
    for (let z = 0; z < size; z++) {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const [fx, fy, fz] = [(x * cells) / size, (y * cells) / size, (z * cells) / size];
          const [x0, y0, z0] = [Math.floor(fx), Math.floor(fy), Math.floor(fz)];
          const [tx, ty, tz] = [smooth(fx - x0), smooth(fy - y0), smooth(fz - z0)];
          const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
          const plane = (zz: number): number =>
            lerp(
              lerp(at(x0, y0, zz), at(x0 + 1, y0, zz), tx),
              lerp(at(x0, y0 + 1, zz), at(x0 + 1, y0 + 1, zz), tx),
              ty,
            );
          out[x + y * size + z * size * size] = lerp(plane(z0), plane(z0 + 1), tz);
        }
      }
    }
    return out;
  };
  const coarse = octave(4);
  const fine = octave(8);
  return Uint8Array.from(coarse, (value, i) =>
    Math.round(Math.max(0, Math.min(1, value * 0.65 + (fine[i] ?? 0) * 0.35)) * 255),
  );
}
