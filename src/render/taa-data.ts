// The temporal anti-aliasing's numbers (taa.ts): each frame's sub-pixel offset of the
// projection, and the matrix that finds a pixel in the last frame. Platform-independent.

import { multiply, type Mat4 } from './math.ts';
import { invert } from './frustum.ts';

/** Frames of the jitter's cycle (Halton 2, 3). */
export const JITTER_FRAMES = 8;

/** The radical inverse of `index` in `base` (the Halton sequence, 0..1). */
export function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  let i = index;
  while (i > 0) {
    result += (i % base) * fraction;
    i = Math.floor(i / base);
    fraction /= base;
  }
  return result;
}

/** A frame's sub-pixel offset in pixels (-0.5..0.5 on each axis). */
export function jitterPixels(frame: number): [number, number] {
  const index = (frame % JITTER_FRAMES) + 1;
  return [halton(index, 2) - 0.5, halton(index, 3) - 0.5];
}

/**
 * Moves a view-projection's image by `pixels` on a `width` × `height` target (in place): clip
 * x and y gain the offset times w, so every point shifts by the same share of a pixel.
 */
export function jitterProjection(
  matrix: Mat4,
  pixels: readonly [number, number],
  width: number,
  height: number,
): void {
  const x = (pixels[0] * 2) / Math.max(1, width);
  const y = (-pixels[1] * 2) / Math.max(1, height);
  for (let column = 0; column < 4; column++) {
    const w = matrix[column * 4 + 3] ?? 0;
    matrix[column * 4] = (matrix[column * 4] ?? 0) + x * w;
    matrix[column * 4 + 1] = (matrix[column * 4 + 1] ?? 0) + y * w;
  }
}

/**
 * The matrix from this frame's clip space (x, y, depth, 1) to the last frame's: the last
 * frame's view-projection times the inverse of this one's. Undefined if it cannot be inverted.
 */
export function reprojection(previous: Mat4, current: Mat4): Mat4 | undefined {
  const inverse = invert(current);
  return inverse && multiply(previous, inverse);
}
