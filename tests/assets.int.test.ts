// Integration test: NIF and DDS parsing on a sample of the local game data.
// Skipped without game data. Full coverage: `node tools/nif-stats.ts --parse` and
// `node tools/dds-stats.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDds } from '../src/formats/dds/dds.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const every = <T>(items: readonly T[], step: number): T[] => items.filter((_, i) => i % step === 0);

describe.skipIf(!hasGamedata())('assets in the local game data', () => {
  let vfs: Vfs;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  it('parses a sample of NIFs without problems', async () => {
    const paths = every(
      vfs.list('meshes').filter((p) => p.endsWith('.nif')),
      40,
    );
    expect(paths.length).toBeGreaterThan(400);
    for (const path of paths) {
      const nif = parseNif(await vfs.read(path));
      expect(nif.problems, path).toEqual([]);
      expect(nif.roots.length, path).toBeGreaterThan(0);
      for (const block of nif.blocks) {
        if (block.kind === 'tri-shape' && block.vertexData.length > 0) {
          expect(block.vertexData.length).toBe(block.vertexCount * block.vertexDesc.stride);
          expect(Math.max(...block.triangles)).toBeLessThan(block.vertexCount);
        }
      }
    }
  }, 120_000);

  it('parses a sample of DDS textures', async () => {
    const paths = every(
      vfs.list('textures').filter((p) => p.endsWith('.dds')),
      80,
    );
    expect(paths.length).toBeGreaterThan(300);
    for (const path of paths) {
      const texture = parseDds(await vfs.read(path));
      expect(texture.levels.length, path).toBe(texture.mipCount * texture.layerCount);
    }
  }, 120_000);
});
