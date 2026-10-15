// Mipmaps of an image the engine makes itself (the player's face tint): each level a 2×2 box
// filter of the one above, down to 1×1. Platform-independent.

export interface MipLevel {
  readonly width: number;
  readonly height: number;
  /** RGBA8. */
  readonly data: Uint8Array;
}

/** The mip chain of an RGBA8 image, the image itself first. */
export function rgbaMipChain(data: Uint8Array, width: number, height: number): MipLevel[] {
  const levels: MipLevel[] = [{ width, height, data }];
  let level = levels[0];
  while (level && (level.width > 1 || level.height > 1)) {
    const above: MipLevel = level;
    const w = Math.max(1, above.width >> 1);
    const h = Math.max(1, above.height >> 1);
    const out = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      const y0 = Math.min(above.height - 1, y * 2);
      const y1 = Math.min(above.height - 1, y * 2 + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.min(above.width - 1, x * 2);
        const x1 = Math.min(above.width - 1, x * 2 + 1);
        for (let k = 0; k < 4; k++) {
          const at = (yy: number, xx: number): number =>
            above.data[(yy * above.width + xx) * 4 + k] ?? 0;
          out[(y * w + x) * 4 + k] = Math.round(
            (at(y0, x0) + at(y0, x1) + at(y1, x0) + at(y1, x1)) / 4,
          );
        }
      }
    }
    level = { width: w, height: h, data: out };
    levels.push(level);
  }
  return levels;
}
