import { describe, expect, it } from 'vitest';
import { LOD_LANDSCAPE_NOISE, lightingSlots, missingTextures } from './material-slots.ts';

describe('lightingSlots', () => {
  it('binds an eye’s cube map and mask by Eye_Environment_Mapping alone', () => {
    // Vanilla eyes (type 16) carry SLSF1 0x20000, not Environment_Mapping (0x80).
    const eye = lightingSlots(16, 0x20000, 0);
    expect(eye[3]).toBe(4);
    expect(eye[4]).toBe(5);
    expect(lightingSlots(16, 0, 0)[3]).toBe(-1);
  });

  it('binds the environment by Environment_Mapping and for multi-layer parallax', () => {
    expect(lightingSlots(1, 0x80, 0).slice(3, 5)).toEqual([4, 5]);
    expect(lightingSlots(11, 0, 0).slice(3, 5)).toEqual([4, 5]);
    expect(lightingSlots(0, 0, 0).slice(3, 5)).toEqual([-1, -1]);
  });

  it('samples slot 2 for a glow map or soft and rim lighting only', () => {
    expect(lightingSlots(2, 0, 0x40)[2]).toBe(2);
    expect(lightingSlots(5, 0, 0x2000000)[2]).toBe(2);
    expect(lightingSlots(4, 0, 0)[2]).toBe(-1);
  });

  it('gives FaceGen its tint and detail maps and parallax its height map', () => {
    const face = lightingSlots(4, 0, 0);
    expect([face[6], face[7]]).toEqual([6, 3]);
    expect(lightingSlots(3, 0, 0)[6]).toBe(3);
    expect(LOD_LANDSCAPE_NOISE).toBe('textures\\terrain\\noise.dds');
  });
});

describe('missingTextures', () => {
  it('gives a missing diffuse and normal map the default normal map', () => {
    const plain = missingTextures(0, 0x80000101, 0x21);
    expect(plain.slice(0, 2)).toEqual(['normal', 'normal']);
    // An environment-mapped material without a mask reflects nothing; its cube is the black one.
    const env = missingTextures(1, 0x80, 0);
    expect([env[3], env[4]]).toEqual(['cube', 'none']);
  });

  it('takes the built-in glow, rim / soft, back light and specular defaults', () => {
    expect(missingTextures(2, 0, 0x40)[2]).toBe('white');
    expect(missingTextures(0, 0, 0x2000000)[2]).toBe('normal');
    expect(missingTextures(0, 0, 0x8000000)[5]).toBe('normal');
    // Model-space normals with Specular: the specular map in slot 7 is black.
    expect(missingTextures(0, 0x1001, 0)[5]).toBe('black');
    // Back lighting wins over the specular map.
    expect(missingTextures(0, 0x1001, 0x8000000)[5]).toBe('normal');
  });

  it('gives FaceGen a grey tint, the detail default and a black skin map', () => {
    const face = missingTextures(4, 0x400, 0x2000000);
    expect([face[2], face[6], face[7]]).toEqual(['black', 'grey', 'detail']);
    expect(missingTextures(3, 0x800, 0)[6]).toBe('black');
    const layered = missingTextures(11, 0, 0x1000000);
    expect([layered[4], layered[6]]).toEqual(['normal', 'normal']);
    expect(missingTextures(16, 0x20000, 0)[4]).toBe('normal');
  });
});
