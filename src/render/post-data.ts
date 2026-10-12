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
