import { describe, expect, it } from 'vitest';
import { blendWeight, swapTextures, thinModelPath } from './actor-model.ts';
import { identity } from './math.ts';
import type { LightingMaterial, ModelData, ModelPart } from './model-data.ts';
import { withDynamicPositions } from './skinning.ts';

const material = (shaderType: number, textures: string[]): LightingMaterial => ({
  kind: 'lighting',
  shaderType,
  flags1: 0,
  flags2: 0,
  uvOffset: [0, 0],
  uvScale: [1, 1],
  textures,
  emissiveColor: [0, 0, 0],
  emissiveMultiple: 1,
  alpha: 1,
  glossiness: 1,
  specularColor: [1, 1, 1],
  specularStrength: 1,
  environmentMapScale: 0,
  tintColor: undefined,
  refractionStrength: 0,
  softLightRolloff: 0,
  rimLightPower: 0,
  multiLayer: undefined,
  sparkle: undefined,
});

/** One vertex: position xyz, bitangent x, normal bytes at 16 (stride 20). */
function part(name: string, x: number, normal: number, shaderType = 0): ModelPart {
  const vertices = new Uint8Array(20);
  const view = new DataView(vertices.buffer);
  view.setFloat32(0, x, true);
  view.setFloat32(4, 2 * x, true);
  view.setUint8(16, normal);
  return {
    name,
    block: 0,
    shader: -1,
    alphaProperty: -1,
    world: identity(),
    layout: { stride: 20, attributes: 0x409, uv: -1, normal: 16, tangent: -1, color: -1 },
    vertices,
    vertexCount: 1,
    indices: Uint16Array.of(0, 0, 0),
    material: material(shaderType, ['textures\\a.dds', 'textures\\a_n.dds']),
    alpha: undefined,
    center: [0, 0, 0],
    radius: 1,
  };
}

const model = (parts: ModelPart[]): ModelData => ({
  parts,
  center: [0, 0, 0],
  radius: 1,
  skipped: [],
  editorMarker: false,
  particles: [],
  addons: [],
});

const x = (data: ModelData, i = 0): number[] => {
  const p = data.parts[i];
  if (!p) return [];
  const view = new DataView(p.vertices.buffer, p.vertices.byteOffset);
  return [view.getFloat32(0, true), view.getFloat32(4, true), view.getUint8(16)];
};

describe('actor models', () => {
  it('names the thin model of a weighted addon', () => {
    expect(thinModelPath('meshes\\armor\\steel\\cuirasslight_1.nif')).toBe(
      'meshes\\armor\\steel\\cuirasslight_0.nif',
    );
    expect(thinModelPath('meshes\\armor\\steel\\shield.nif')).toBeUndefined();
  });

  it('blends the thin and heavy models by weight', () => {
    const thin = model([part('Body', 10, 100)]);
    const heavy = model([part('Body', 20, 200)]);
    expect(x(blendWeight(thin, heavy, 25))).toEqual([12.5, 25, 125]);
    expect(blendWeight(thin, heavy, 100)).toBe(heavy);
    // Parts that do not match keep the heavy vertices.
    const odd = model([{ ...part('Body', 10, 100), vertexCount: 2 }]);
    expect(x(blendWeight(odd, heavy, 0))).toEqual([20, 40, 200]);
  });

  it('swaps the skin texture set into skin shapes and texture sets into named shapes', () => {
    const data = model([part('Body', 0, 0, 5), part('Cloth', 0, 0), part('Trim', 0, 0)]);
    const swapped = swapTextures(data, {
      skin: ['textures\\skin.dds', '', '', 'textures\\skin_detail.dds'],
      shapes: [{ shape: 'cloth', textures: ['textures\\red.dds'] }],
    });
    const textures = (i: number): readonly string[] => {
      const m = swapped.parts[i]?.material;
      return m?.kind === 'lighting' ? m.textures : [];
    };
    expect(textures(0)).toEqual([
      'textures\\skin.dds',
      'textures\\a_n.dds',
      '',
      'textures\\skin_detail.dds',
    ]);
    expect(textures(1)).toEqual(['textures\\red.dds', 'textures\\a_n.dds']);
    expect(textures(2)).toEqual(['textures\\a.dds', 'textures\\a_n.dds']);
  });

  it('puts the dynamic positions of a BSDynamicTriShape in front of its vertices', () => {
    // FaceGen vertex data without positions: UV at 0, skin weights at 4 (stride 16).
    const desc = {
      stride: 16,
      uvOffset: 0,
      normalOffset: 0,
      tangentOffset: 0,
      colorOffset: 0,
      skinningOffset: 4,
      eyeOffset: 0,
      attributes: 0x442,
    };
    const data = Uint8Array.from({ length: 32 }, (_, i) => i);
    const built = withDynamicPositions(desc, data, 2, Float32Array.of(1, 2, 3, 0.5, 4, 5, 6, -0.5));
    expect(built.desc.stride).toBe(32);
    expect([built.desc.uvOffset, built.desc.skinningOffset]).toEqual([16, 20]);
    expect(built.desc.attributes & 0x401).toBe(0x401);
    const view = new DataView(built.data.buffer);
    expect([view.getFloat32(32, true), view.getFloat32(44, true)]).toEqual([4, -0.5]);
    expect(built.data[48]).toBe(16);
  });
});
