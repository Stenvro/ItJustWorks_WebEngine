// Integration test: NIF and DDS parsing on a sample of the local game data.
// Skipped without game data. Full coverage: `node tools/nif-stats.ts --parse` and
// `node tools/dds-stats.ts`.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDds } from '../src/formats/dds/dds.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { identity } from '../src/render/math.ts';
import { buildModel } from '../src/render/model-data.ts';
import type { ParticleSystemData } from '../src/render/particle-data.ts';
import { ParticleSimulation } from '../src/render/particle-sim.ts';
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

  it('builds draw-ready models from a sample of NIFs', async () => {
    const paths = every(
      vfs.list('meshes').filter((p) => p.endsWith('.nif')),
      25,
    );
    let parts = 0;
    for (const path of paths) {
      const model = buildModel(parseNif(await vfs.read(path)));
      for (const part of model.parts) {
        parts++;
        expect(part.vertices.length, path).toBe(part.vertexCount * part.layout.stride);
        expect(Math.max(...part.indices), path).toBeLessThan(part.vertexCount);
        expect([...part.world].every(Number.isFinite), path).toBe(true);
        expect(Number.isFinite(part.radius), path).toBe(true);
      }
    }
    expect(parts).toBeGreaterThan(500);
  }, 120_000);

  it('builds and runs the particle systems of fires, candles and smoke', async () => {
    const model = async (path: string): Promise<ReturnType<typeof buildModel>> =>
      buildModel(parseNif(await vfs.read(path)));
    const runFor = (system: ParticleSystemData, seconds: number): ParticleSimulation => {
      const simulation = new ParticleSimulation(system, 1);
      for (let t = 0; t <= seconds; t += 1 / 30) {
        simulation.update({
          seconds: t,
          dt: t === 0 ? 0 : 1 / 30,
          instanceWorld: identity(),
          animated: undefined,
          camera: [0, -300, 100],
          wind: [0, 0, 0],
        });
      }
      return simulation;
    };

    // A wall torch: its flame emitter stands upright below a BSRotateAboutUp billboard,
    // its embers come from AddOnNode 7 (MPSTorchEmbers01).
    const torch = await model('meshes\\clutter\\common\\torchsconce01.nif');
    expect(torch.addons.map((addon) => addon.index)).toEqual([7]);
    const flame = torch.particles.find((system) => system.name === 'pFireballCore04');
    expect(flame?.billboards.size).toBeGreaterThan(0);
    expect(flame && runFor(flame, 2).count).toBeGreaterThan(0);

    // The candle flame master particle system: flame and glow, emitting on their own.
    const candle = await model('meshes\\mps\\mpscandleflame01.nif');
    expect(candle.parts).toHaveLength(0);
    expect(candle.particles.map((system) => system.name)).toEqual([
      'CandleFlame01',
      'CandleGlow01',
    ]);
    for (const system of candle.particles) expect(runFor(system, 2).count).toBeGreaterThan(0);

    // The forge's idle sequence (AmIdle) runs its idle smoke; the "Playing" smoke waits.
    const forge = await model(
      'meshes\\clutter\\blacksmith\\blacksmithforge01\\blacksmithforge01.nif',
    );
    const smoke = (name: string): ParticleSystemData | undefined =>
      forge.particles.find((system) => system.name === name);
    const idle = smoke('smoke02Idle');
    const playing = smoke('smoke01Activate');
    expect(idle && runFor(idle, 3).count).toBeGreaterThan(10);
    expect(playing && runFor(playing, 3).count).toBe(0);
  }, 120_000);

  it('builds the particle systems of a sample of NIFs', async () => {
    const paths = every(
      vfs.list('meshes').filter((p) => p.endsWith('.nif')),
      5,
    );
    let systems = 0;
    for (const path of paths) {
      const nif = parseNif(await vfs.read(path));
      if (!nif.blocks.some((block) => block.kind === 'particle-system')) continue;
      for (const system of buildModel(nif).particles) {
        systems++;
        expect(system.emitters.length, path).toBeGreaterThan(0);
        expect(system.maxParticles, path).toBeGreaterThan(0);
        for (const frame of system.subtextures) {
          expect(
            frame.every((value) => value >= 0 && value <= 1),
            path,
          ).toBe(true);
        }
      }
    }
    expect(systems).toBeGreaterThan(200);
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
