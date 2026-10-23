// Shows the particle systems of NIFs as the engine builds them (emitters, modifiers,
// controller tracks, add-on nodes; procedural lightning: its bolts' settings and tracks) and
// runs each for a few seconds; with --audit, counts modifier and controller types over every
// mesh.
//
//   node tools/particle-info.ts meshes/mps/mpscandleflame01.nif
//   node tools/particle-info.ts meshes/clutter/common/torchsconce01.nif --seconds 3
//   node tools/particle-info.ts --audit

import { parseArgs } from 'node:util';
import { parseNif } from '../src/formats/nif/nif.ts';
import { identity } from '../src/render/math.ts';
import { buildModel } from '../src/render/model-data.ts';
import { LightningSimulation } from '../src/render/lightning.ts';
import {
  PARTICLE_FLOATS,
  ParticleSimulation,
  type ParticleSource,
} from '../src/render/particle-sim.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    audit: { type: 'boolean', default: false },
    seconds: { type: 'string', default: '2' },
  },
});
const vfs = await Vfs.mount(openGameFolder());
const round = (value: number): number => Math.round(value * 100) / 100;

if (values.audit) {
  const counts = new Map<string, number>();
  const count = (key: string): void => void counts.set(key, (counts.get(key) ?? 0) + 1);
  let files = 0;
  let systems = 0;
  for (const path of vfs.list('meshes').filter((p) => p.endsWith('.nif'))) {
    const nif = parseNif(await vfs.read(path));
    if (!nif.blocks.some((block) => block.kind === 'particle-system')) continue;
    files++;
    for (const block of nif.blocks) {
      if (block.kind === 'particle-modifier') count(`modifier ${block.type}`);
      if (block.kind === 'controller' && block.type.includes('PSys')) {
        count(`controller ${block.type}${(block.flags & 0x20) !== 0 ? ' (manager)' : ''}`);
      }
    }
    for (const system of buildModel(nif).particles) {
      systems++;
      if (!system.tracks.some((track) => track.param === 'birthRate'))
        count('no birth rate (waits)');
      if (system.strip) count('strip');
      if (system.billboards.size > 0) count('below a billboard');
    }
  }
  console.log(`${String(files)} meshes with particles, ${String(systems)} systems`);
  for (const [key, value] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(value).padStart(7)}  ${key}`);
  }
} else {
  const seconds = Number(values.seconds);
  for (const input of positionals) {
    const path = input.replaceAll('/', '\\').toLowerCase();
    const model = buildModel(parseNif(await vfs.read(path)));
    console.log(
      `${path}: ${String(model.parts.length)} parts, ${String(model.particles.length)} particle systems` +
        (model.addons.length > 0
          ? `, add-on nodes ${model.addons.map((addon) => addon.index).join(', ')}`
          : ''),
    );
    for (const system of model.particles) {
      const material = system.material;
      console.log(
        `  ${system.name}: max ${String(system.maxParticles)}, ${system.worldSpace ? 'world' : 'local'} space` +
          `${system.strip ? ', strip' : ''}${system.velocityOriented ? ', velocity oriented' : ''}` +
          `, ${String(system.subtextures.length)} atlas frames` +
          (material?.kind === 'effect' ? `, ${material.sourceTexture}` : ''),
      );
      for (const emitter of system.emitters) {
        console.log(
          `    ${emitter.shape} emitter "${emitter.name}": speed ${String(round(emitter.speed))}, ` +
            `life ${String(round(emitter.lifeSpan))}, radius ${String(round(emitter.radius))}`,
        );
      }
      for (const track of system.tracks) {
        console.log(
          `    track ${track.target}.${track.param} (${track.kind}, ${String(track.source.keys?.keys.length ?? 0)} keys)`,
        );
      }
      const lightning = system.lightning;
      if (lightning) {
        console.log(
          `    procedural lightning: 2^${String(lightning.subdivisions)} segments, ` +
            `${String(lightning.branches)} ± ${String(lightning.branchesVariation)} branches, ` +
            `length ${String(round(lightning.length))} ± ${String(round(lightning.lengthVariation))}, ` +
            `width ${String(round(lightning.width))} (branches × ${String(round(lightning.childWidthMultiplier))}), ` +
            `arc offset ${String(round(lightning.arcOffset))}` +
            (lightning.animateArcOffset ? ' (animated)' : '') +
            (lightning.fadeMainBolt ? ', main bolt fades' : '') +
            (lightning.fadeChildBolts ? ', branches fade' : ''),
        );
        for (const [sequence, tracks] of system.sequenceTracks) {
          console.log(
            `    sequence ${sequence}: ${tracks.map((track) => `${track.param} (${String(track.source.keys?.keys.length ?? 0)} keys)`).join(', ')}`,
          );
        }
      }
      // A graph-driven model's idle sequence (mIdle) plays, as its graph starts it.
      const idle = system.sequenceTracks.has('midle') ? [{ sequence: 'midle', start: 0 }] : [];
      const simulation: ParticleSource = lightning
        ? new LightningSimulation(system, 1)
        : new ParticleSimulation(system, 1);
      const context = {
        seconds: 0,
        dt: 0,
        instanceWorld: identity(),
        animated: undefined,
        camera: [0, -300, 100] as const,
        wind: [0, 0, 0] as const,
        sequences: idle,
      };
      for (let t = 0; t <= seconds; t += 1 / 30) {
        simulation.update({ ...context, seconds: t, dt: t === 0 ? 0 : 1 / 30 });
      }
      const out = new Float32Array(Math.max(1, simulation.instanceCount) * PARTICLE_FLOATS);
      simulation.write(out, 0, { ...context, seconds });
      console.log(
        `    after ${String(seconds)} s: ${String(simulation.count)} particles around ` +
          `${simulation.center.map((v) => Math.round(v)).join(', ')} (radius ${String(Math.round(simulation.radius))})`,
      );
    }
  }
}
await vfs.close();
