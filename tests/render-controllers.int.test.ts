// Integration test: the scene graph's controllers on the local game data: motion along paths
// (NiPathInterpolator), the camera models' animated place and field of view
// (BSFrustumFOVController) and look-ats (NiLookAtInterpolator). Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseNif, type NifFile } from '../src/formats/nif/nif.ts';
import { buildAnimation, animate } from '../src/render/animation.ts';
import { readCameraModel, sampleCameraModel } from '../src/render/camera-model.ts';
import { pathSource, samplePath } from '../src/render/path-motion.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

/** Folders that hold every vanilla path interpolator (73 in 25 models). */
const PATH_FOLDERS = [
  'meshes\\cameras',
  'meshes\\critters',
  'meshes\\effects',
  'meshes\\dlc01\\critters',
  'meshes\\dlc01\\effects\\ambient',
  'meshes\\dlc02\\critters',
  'meshes\\dungeons\\dwemer\\animated',
  'meshes\\creationclub\\bgssse001\\critters',
];

describe.skipIf(!hasGamedata())('scene graph controllers on the local game data', () => {
  let vfs: Vfs;
  const nif = async (path: string): Promise<NifFile> => parseNif(await vfs.read(path));

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  it('moves every path interpolator along its path over its controller time', async () => {
    let paths = 0;
    for (const folder of PATH_FOLDERS) {
      for (const path of vfs.list(folder)) {
        if (!path.endsWith('.nif')) continue;
        const file = await nif(path);
        for (const [ref, block] of file.blocks.entries()) {
          if (block.kind !== 'path-interpolator') continue;
          const source = pathSource(file, ref);
          expect(source, path).toBeDefined();
          if (!source) continue;
          paths++;
          const keys = source.percent.keys;
          const from = keys[0]?.time ?? 0;
          const to = keys[keys.length - 1]?.time ?? 1;
          for (let i = 0; i <= 8; i++) {
            const at = samplePath(source, from + ((to - from) * i) / 8);
            expect(at.translation.every(Number.isFinite), path).toBe(true);
            if (at.rotation) expect(Math.hypot(...at.rotation)).toBeCloseTo(1, 4);
          }
        }
      }
    }
    expect(paths).toBe(73);
  }, 120_000);

  it('flies the hawks and the kill camera path from their first key', async () => {
    const hawk = await nif('meshes\\critters\\fchawk\\fchawknonest.nif');
    const animation = buildAnimation(hawk);
    expect(animation).toBeDefined();
    if (!animation) return;
    const root = hawk.blocks.findIndex((b) => 'name' in b && b.name === 'birdOPreyRoot01');
    const early = animate(animation, 10).worlds.get(root);
    const later = animate(animation, 40).worlds.get(root);
    expect(early).toBeDefined();
    expect(later).toBeDefined();
    // It has flown off its first key (and turned along the way: Follow).
    expect(
      Math.hypot((later?.[12] ?? 0) - (early?.[12] ?? 0), (later?.[13] ?? 0) - (early?.[13] ?? 0)),
    ).toBeGreaterThan(100);
    const base = readCameraModel(await nif('meshes\\cameras\\base.nif'));
    expect(base).toBeDefined();
    if (!base) return;
    const start = sampleCameraModel(base, 0);
    expect(start.position[0]).toBeCloseTo(185.72, 1);
    expect(sampleCameraModel(base, 2.5).position[0]).toBeLessThan(0);
  });

  it('animates every camera model, its field of view from its frustum', async () => {
    let models = 0;
    let animatedFov = 0;
    for (const path of vfs.list('meshes\\cameras')) {
      if (!path.endsWith('.nif')) continue;
      const file = await nif(path);
      const model = readCameraModel(file);
      if (!model) continue;
      models++;
      const camera = file.blocks.find((b) => b.kind === 'camera');
      if (camera?.kind !== 'camera') continue;
      const atStart = sampleCameraModel(model, 0);
      expect(atStart.position.every(Number.isFinite), path).toBe(true);
      if (model.fov) {
        animatedFov++;
        // The controller's value at time 0 is the frustum's own right edge.
        expect(atStart.fovY, path).toBeCloseTo(2 * Math.atan(Math.abs(camera.frustum.top)), 2);
      }
    }
    expect(models).toBeGreaterThan(100);
    expect(animatedFov).toBeGreaterThanOrEqual(45);
    const wide = readCameraModel(await nif('meshes\\cameras\\base.nif'));
    if (!wide) throw new Error('no camera');
    // base.nif narrows from about 51 degrees to about 35 and back.
    expect(sampleCameraModel(wide, 2.1666).fovY).toBeLessThan(sampleCameraModel(wide, 0).fovY);
  });

  it('turns the forge marker preview camera toward its target', async () => {
    const file = await nif('meshes\\furniture\\blacksmithforgemarker.nif');
    const animation = buildAnimation(file, true);
    expect(animation).toBeDefined();
    if (!animation) return;
    const frame = animate(animation, 0);
    const cam = file.blocks.findIndex((b) => 'name' in b && b.name === 'PreviewCam');
    const target = file.blocks.findIndex((b) => 'name' in b && b.name === 'PreviewCamTarget');
    const world = frame.worlds.get(cam);
    expect(world).toBeDefined();
    const block = file.blocks[target];
    if (!world || !block || !('transform' in block)) return;
    const to = block.transform.translation;
    const way = [to[0] - (world[12] ?? 0), to[1] - (world[13] ?? 0), to[2] - (world[14] ?? 0)];
    const length = Math.hypot(way[0] ?? 0, way[1] ?? 0, way[2] ?? 0);
    // LookAtFlags 4: its z axis (the matrix's third column) points at the target.
    const dot =
      ((world[8] ?? 0) * (way[0] ?? 0) +
        (world[9] ?? 0) * (way[1] ?? 0) +
        (world[10] ?? 0) * (way[2] ?? 0)) /
      length;
    expect(dot).toBeCloseTo(1, 3);
  });
});
