// Integration test: dynamic decals on the world find the shapes under the struck collision's
// node in the vanilla meshes. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseNif } from '../src/formats/nif/nif.ts';
import { buildCollision } from '../src/physics/collision-data.ts';
import { buildModel } from '../src/render/model-data.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('world decals in the local game data', () => {
  let vfs: Vfs;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  it('finds drawn shapes under the node of every collision body of the architecture', async () => {
    const paths = vfs
      .list('meshes\\architecture\\whiterun')
      .filter((path) => path.endsWith('.nif'))
      .slice(0, 80);
    expect(paths.length).toBeGreaterThan(20);
    let bodies = 0;
    for (const path of paths) {
      const file = parseNif(await vfs.read(path));
      const parts = buildModel(file).parts.filter((part) => !part.skin);
      for (const body of buildCollision(file).bodies) {
        const node = body.node.toLowerCase();
        // A decal struck on this body has shapes to go on (the shapes under its node).
        const under = parts.filter((part) => part.ancestors?.includes(node) === true);
        if (parts.length > 0) expect(under.length, `${path}: ${body.node}`).toBeGreaterThan(0);
        bodies++;
      }
    }
    expect(bodies).toBeGreaterThan(20);
  });
});
