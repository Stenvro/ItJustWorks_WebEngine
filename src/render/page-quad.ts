// A flat rectangle showing a texture the engine draws itself: a book menu's page of text on the
// 3D book (the book's own "PageText" shape is such a rectangle, hidden, with an effect shader
// whose source texture the engine fills). Unlit, blended over the paper (the text's background
// is transparent), facing +Z.

import { VertexAttribute } from '../formats/nif/blocks.ts';
import { identity, toHalf } from './math.ts';
import type { EffectMaterial, ModelData } from './model-data.ts';

/** NiAlphaProperty flags: blending on, source alpha over one minus source alpha. */
const BLEND_ALPHA = 0x00ed;
/** SLSF1 ZBuffer_Test. */
const ZBUFFER_TEST = 0x80000000;

/** Position, bitangent X, half-float UV, normal and tangent bytes (as BSTriShape packs them). */
const STRIDE = 28;

/**
 * A `width` × `height` rectangle centred on the origin in the XY plane, its texture (the
 * path a TextureCache provides) upright: U along +X, V down along −Y.
 */
export function pageQuad(width: number, height: number, texture: string): ModelData {
  const x = width / 2;
  const y = height / 2;
  const corners: readonly (readonly [number, number, number, number])[] = [
    [-x, y, 0, 0],
    [-x, -y, 0, 1],
    [x, y, 1, 0],
    [x, -y, 1, 1],
  ];
  const vertices = new Uint8Array(corners.length * STRIDE);
  const view = new DataView(vertices.buffer);
  corners.forEach(([px, py, u, v], i) => {
    const base = i * STRIDE;
    view.setFloat32(base, px, true);
    view.setFloat32(base + 4, py, true);
    view.setFloat32(base + 8, 0, true);
    // Bitangent (0, 1, 0): X here, Y in the normal's w, Z in the tangent's w.
    view.setFloat32(base + 12, 0, true);
    view.setUint16(base + 16, toHalf(u), true);
    view.setUint16(base + 18, toHalf(v), true);
    vertices.set([128, 128, 255, 255], base + 20);
    vertices.set([255, 128, 128, 128], base + 24);
  });
  const material: EffectMaterial = {
    kind: 'effect',
    flags1: ZBUFFER_TEST,
    flags2: 0,
    uvOffset: [0, 0],
    uvScale: [1, 1],
    sourceTexture: texture,
    greyscaleTexture: '',
    baseColor: [1, 1, 1, 1],
    baseColorScale: 1,
    falloff: [1, 1, 1, 1],
    lightingInfluence: 0,
    softFalloffDepth: 0,
    textureClampMode: 0,
  };
  const radius = Math.hypot(x, y);
  return {
    parts: [
      {
        name: 'PageText',
        block: -1,
        shader: -1,
        alphaProperty: -1,
        world: identity(),
        layout: {
          stride: STRIDE,
          attributes:
            VertexAttribute.vertex |
            VertexAttribute.fullPrecision |
            VertexAttribute.uv |
            VertexAttribute.normal |
            VertexAttribute.tangent,
          uv: 16,
          normal: 20,
          tangent: 24,
          color: -1,
        },
        vertices,
        vertexCount: corners.length,
        // Counter-clockwise seen from +Z.
        indices: Uint16Array.from([0, 1, 2, 2, 1, 3]),
        material,
        alpha: { flags: BLEND_ALPHA, threshold: 0 },
        center: [0, 0, 0],
        radius,
      },
    ],
    center: [0, 0, 0],
    radius,
    skipped: [],
    editorMarker: false,
    particles: [],
    addons: [],
  };
}
