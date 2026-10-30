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
 * The share of the last frame's composite kept at each pixel (where its depth there agrees):
 * [Display] fVolumetricLightingTemporalAccumulationFactor
 * (bVolumetricLightingEnableTemporalAccumulation). Observed in the original: the blend is in
 * screen space, in the composite, never in the froxels.
 */
export const TEMPORAL_FACTOR = 0.75;
/** Frames of the jitter's cycle (the frame index & 7). */
export const JITTER_FRAMES = 8;
/** The noise's coordinate per world unit, over the density size (observed in the original). */
export const NOISE_SCALE = 0.0125;
/** The composite's dither noise, texels a side (TODO(M13): the original's size is unread). */
export const DITHER_SIZE = 32;

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
 * The generate pass's jitter (observed in the original): the frame index & 7 picks a corner of a
 * unit cube (x by its bit 2, y by bit 1, z by bit 0), and each froxel is sampled a thousandth of
 * the volume from its corner towards it (the volume's coordinate is its index over its size,
 * without a half texel).
 */
export function jitterCorner(frame: number): Vec3 {
  const i = frame & (JITTER_FRAMES - 1);
  return [(i >> 2) & 1, (i >> 1) & 1, i & 1];
}

/**
 * The composite's scale of the slices' sum (observed in the original): the intensity over the
 * volume's slice count, so the sum becomes the average of the froxels in front of a pixel.
 */
export function compositeScale(intensity: number, slices: number): number {
  return slices > 0 ? intensity / slices : 0;
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
 * Three-dimensional simplex noise as the original's noise passes compute it (the common
 * mod-289 permutation with the 7 × 7 gradient grid and the 0.6 falloff), returning the
 * corners' sum before any scaling (within about ±1/42).
 */
export function simplexSum(x: number, y: number, z: number): number {
  // The integer steps in single precision, as the GPU takes them (in double precision 147 / 49
  // floors to 2).
  const single = Math.fround;
  const inv289 = single(1 / 289);
  const inv7 = single(1 / 7);
  const mod289 = (v: number): number => v - Math.floor(single(v * inv289)) * 289;
  const permute = (v: number): number => mod289((v * 34 + 1) * v);
  const skew = (x + y + z) / 3;
  const i = [Math.floor(x + skew), Math.floor(y + skew), Math.floor(z + skew)] as const;
  const unskew = (i[0] + i[1] + i[2]) / 6;
  const x0 = [x - i[0] + unskew, y - i[1] + unskew, z - i[2] + unskew] as const;
  // The simplex's other corners by the order of x0's components.
  const g = [x0[0] >= x0[1] ? 1 : 0, x0[1] >= x0[2] ? 1 : 0, x0[2] >= x0[0] ? 1 : 0] as const;
  const l = [1 - g[0], 1 - g[1], 1 - g[2]] as const;
  const i1 = [Math.min(g[0], l[2]), Math.min(g[1], l[0]), Math.min(g[2], l[1])] as const;
  const i2 = [Math.max(g[0], l[2]), Math.max(g[1], l[0]), Math.max(g[2], l[1])] as const;
  const corners = [[0, 0, 0], i1, i2, [1, 1, 1]] as const;
  const m = [mod289(i[0]), mod289(i[1]), mod289(i[2])] as const;
  let sum = 0;
  corners.forEach((o, k) => {
    const p = permute(permute(permute(m[2] + o[2]) + m[1] + o[1]) + m[0] + o[0]);
    // The gradient: p on a 7 × 7 grid folded onto an octahedron.
    const j = p - 49 * Math.floor(single(single(p * inv7) * inv7));
    const gx0 = Math.floor(single(j * inv7));
    const gy0 = Math.floor(j - 7 * gx0);
    let gx = gx0 * (2 / 7) - 13 / 14;
    let gy = gy0 * (2 / 7) - 13 / 14;
    const gz = 1 - Math.abs(gx) - Math.abs(gy);
    if (gz <= 0) {
      gx -= Math.floor(gx) * 2 + 1;
      gy -= Math.floor(gy) * 2 + 1;
    }
    const norm = 1.79284291400159 - 0.85373472095314 * (gx * gx + gy * gy + gz * gz);
    const d = [x0[0] - o[0] + k / 6, x0[1] - o[1] + k / 6, x0[2] - o[2] + k / 6] as const;
    const t = Math.max(0.6 - (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]), 0);
    sum += t * t * t * t * norm * (gx * d[0] + gy * d[1] + gz * d[2]);
  });
  return sum;
}

/**
 * The density noise (observed in the original, which fills it on the GPU at load): a 32³ volume
 * of simplex noise at 80 cells across (each texel at (x + 0.2, y, z) over the size), stored as
 * 21 × the sum + 0.5 (bytes, 0..255).
 */
export function densityNoise(size = NOISE_SIZE): Uint8Array {
  const out = new Uint8Array(size * size * size);
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const v = simplexSum(((x + 0.2) / size) * 80, (y / size) * 80, (z / size) * 80);
        out[x + y * size + z * size * size] = toByte(v * 21 + 0.5);
      }
    }
  }
  return out;
}

/**
 * The composite's dither noise (observed in the original's two-dimensional noise pass):
 * simplex noise at (x, y) × 8, stored as 21 × the sum + 0.5 (bytes).
 */
export function ditherNoise(size = DITHER_SIZE): Uint8Array {
  const out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      out[x + y * size] = toByte(simplexSum(x * 8, y * 8, 0) * 21 + 0.5);
    }
  }
  return out;
}

function toByte(v: number): number {
  return Math.round(Math.max(0, Math.min(1, v)) * 255);
}
