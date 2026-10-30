// Integration test: lighting material rules the shaders rely on, against the local game data.
// Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VertexAttribute } from '../src/formats/nif/blocks.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import type { BSTriShapeBlock, NifBlock, Vec3 } from '../src/formats/nif/types.ts';
import { buildModel } from '../src/render/model-data.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const SHADER_SPARKLE_SNOW = 14;
const SHADER_EYE = 16;
const SLSF2_SNOW = 0x10000000;

/** The vertices' model-space positions and eye data of an eye shape (skinned, dynamic). */
function eyeVertices(blocks: readonly NifBlock[], shape: BSTriShapeBlock): [Vec3, number][] {
  const skin = blocks[shape.skin];
  const partition = skin?.kind === 'skin-instance' ? blocks[skin.partition] : undefined;
  if (partition?.kind !== 'skin-partition' || !partition.vertexDesc) return [];
  const desc = partition.vertexDesc;
  if ((desc.attributes & VertexAttribute.eyeData) === 0) return [];
  const data = partition.vertexData;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const positions = shape.dynamicPositions;
  const out: [Vec3, number][] = [];
  for (let v = 0; v < partition.vertexCount; v++) {
    const at = v * desc.stride;
    const position: Vec3 =
      (desc.attributes & VertexAttribute.vertex) === 0 && positions
        ? [positions[v * 4] ?? 0, positions[v * 4 + 1] ?? 0, positions[v * 4 + 2] ?? 0]
        : [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)];
    out.push([position, view.getFloat32(at + desc.eyeOffset, true)]);
  }
  return out;
}

const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe.skipIf(!hasGamedata())('lighting materials in the local game data', () => {
  let vfs: Vfs;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  it('marks each eye vertex with the eye whose reflection centre is nearer (common.wgsl eyeNormal)', async () => {
    const paths = vfs
      .list('meshes\\actors\\character\\character assets')
      .filter((path) => /\\eyes[^\\]*\.nif$/.test(path));
    expect(paths.length).toBeGreaterThan(5);
    let checked = 0;
    for (const path of paths) {
      const nif = parseNif(await vfs.read(path));
      for (const block of nif.blocks) {
        if (block.kind !== 'tri-shape') continue;
        const shader = nif.blocks[block.shaderProperty];
        if (shader?.kind !== 'lighting-shader' || shader.shaderType !== SHADER_EYE) continue;
        const eye = shader.eye;
        if (!eye) continue;
        for (const [position, side] of eyeVertices(nif.blocks, block)) {
          expect(side === 0 || side === 1).toBe(true);
          const right =
            distance(position, eye.rightReflectionCenter) <
            distance(position, eye.leftReflectionCenter);
          expect(side === 1).toBe(right);
          checked++;
        }
      }
      // The material carries both centres to the shader.
      const model = buildModel(nif);
      const eyes = model.parts.flatMap((part) =>
        part.material?.kind === 'lighting' && part.material.shaderType === SHADER_EYE
          ? [part.material.eyeCenters]
          : [],
      );
      for (const centers of eyes) expect(centers).toHaveLength(2);
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('gives every sparkle snow shape (type 14) the snow flag, whose variant has no sparkles', async () => {
    const paths = vfs
      .list('meshes\\dungeons\\caves\\ice\\clutter')
      .filter((path) => path.endsWith('.nif'));
    let found = 0;
    for (const path of [...paths, 'meshes\\dungeons\\caves\\green\\iceshader.nif']) {
      const nif = parseNif(await vfs.read(path));
      for (const block of nif.blocks) {
        if (block.kind !== 'lighting-shader' || block.shaderType !== SHADER_SPARKLE_SNOW) continue;
        expect(block.flags2 & SLSF2_SNOW).not.toBe(0);
        expect(block.sparkleParameters).toHaveLength(4);
        found++;
      }
    }
    expect(found).toBeGreaterThan(10);
  });
});
