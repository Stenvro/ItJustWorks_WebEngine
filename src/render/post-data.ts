// Platform-independent parts of the post-processing (src/render/post.ts).

/** Taps per side of the bloom blur, the centre included. */
export const MAX_BLUR_TAPS = 16;

/** Gaussian weights for offsets 0..15 (one side) of a blur radius, summing to 1 overall. */
export function blurWeights(radius: number): Float32Array {
  const weights = new Float32Array(MAX_BLUR_TAPS);
  const taps = Math.min(MAX_BLUR_TAPS - 1, Math.ceil(radius));
  if (taps <= 0) {
    weights[0] = 1;
    return weights;
  }
  const sigma = Math.max(radius / 2, 0.5);
  let sum = 0;
  for (let i = 0; i <= taps; i++) {
    const w = Math.exp(-(i * i) / (2 * sigma * sigma));
    weights[i] = w;
    sum += i === 0 ? w : 2 * w;
  }
  for (let i = 0; i <= taps; i++) weights[i] = (weights[i] ?? 0) / sum;
  return weights;
}

/**
 * The image-space modifiers' full-screen blur (radius 0..7): the blurred copy's radius in
 * pixels at half size, and how far the image turns into it (a radius below 1 fades it in).
 * TODO(M13): calibrate against the game's ISBlur passes.
 */
export function screenBlur(radius: number): { pixels: number; amount: number } {
  const r = Math.max(0, Math.min(7, radius));
  return { pixels: 1 + r, amount: Math.min(1, r) };
}

/**
 * How far the two images of double vision lie apart (texture coordinates): the strength,
 * swaying with time as the Creation Kit says the effect "animates automatically".
 * TODO(M13): calibrate the sway against the game's ISDoubleVision parameters.
 */
export function doubleVisionOffset(strength: number, seconds: number): [number, number] {
  return [
    strength * (0.75 + 0.25 * Math.sin(seconds * 2)),
    strength * 0.25 * Math.sin(seconds * 1.3),
  ];
}

/**
 * The full-screen motion blur's share of the previous image each frame: strength s keeps
 * s / (1 + s) of it per 60th of a second, the same per second at any frame rate.
 * TODO(M13): calibrate against the game.
 */
export function motionBlurHistory(strength: number, deltaSeconds: number): number {
  if (!(strength > 0)) return 0;
  const perFrame = strength / (1 + strength);
  return Math.min(0.98, perFrame ** Math.max(0, deltaSeconds * 60));
}
