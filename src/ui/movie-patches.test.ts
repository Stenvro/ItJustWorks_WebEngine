import { describe, expect, it } from 'vitest';
import { withAlpha } from './movie-patches.ts';

describe('movie patches', () => {
  it('gives a DefineShape2 alpha by colour', () => {
    // id 1, an empty rect, fills: black and grey, a line (width 20, white), records: 1 fill
    // bit, 1 line bit, then the end.
    const body = Uint8Array.of(
      1,
      0,
      0,
      2,
      0,
      0,
      0,
      0,
      0,
      153,
      153,
      153,
      1,
      20,
      0,
      255,
      255,
      255,
      0x11,
      0,
    );
    const out = withAlpha(body, (rgb) => (rgb[0] === 0 ? 0 : 255));
    expect(out && [...out]).toEqual([
      1, 0, 0, 2, 0, 0, 0, 0, 0, 0, 153, 153, 153, 255, 1, 20, 0, 255, 255, 255, 255, 0x11, 0,
    ]);
  });

  it('leaves gradients alone', () => {
    const body = Uint8Array.of(1, 0, 0, 1, 0x10, 0, 0, 0);
    expect(withAlpha(body, () => 0)).toBeUndefined();
  });
});
