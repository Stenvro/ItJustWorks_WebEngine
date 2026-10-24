// The headless simulation's speed (src/sim/): a new game, one place opened, the world stepped
// at the fixed step; prints how long each part took and the game seconds simulated per real
// second, with the actors of the place and what their packages are.
//
//   node tools/sim-speed.ts --interior 1605e [--seconds 30] [--hour 10]
//   node tools/sim-speed.ts --exterior 1a26f [x y] [--seconds 30] [--grid 1]
//                                             (default: the worldspace's busiest cell)

import { SIM_STEP, SimWorld } from '../src/sim/sim-world.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};
const number = (name: string, fallback: number): number => {
  const value = Number(option(name));
  return Number.isFinite(value) ? value : fallback;
};
const seconds = number('--seconds', 30);
const hour = number('--hour', 10);
const grid = number('--grid', 2);
// The virtual clock replaces performance.now while the simulation runs: real time from Date.
const real = (): number => Date.now();

const started = real();
const vfs = await Vfs.mount(openGameFolder());
const world = await SimWorld.create({ vfs, gridRadius: grid });
world.terminal.echo = args.includes('--warnings');
const created = real();
world.runtime.setClockGlobal(0x38, hour);
await world.step(0);
const interior = option('--interior');
const exterior = args.indexOf('--exterior');
if (interior !== undefined) {
  await world.openInterior(parseInt(interior, 16));
} else if (exterior >= 0) {
  const space = parseInt(args[exterior + 1] ?? '3c', 16);
  // Without a cell: the worldspace's busiest.
  const busiest = (await world.session.worldspace(space)).busiestCell() ?? [0, 0];
  const x = Number(args[exterior + 2] ?? busiest[0]);
  const y = Number(args[exterior + 3] ?? busiest[1]);
  await world.openExterior(space, { cell: [x, y] });
} else {
  throw new Error('--interior <cell> or --exterior <world> <x> <y>');
}
const opened = real();
const steps = Math.round(seconds / SIM_STEP);
await world.run(seconds);
const ran = real();
const actors = [...world.stage.all()];
console.log(
  `new game ${String(created - started)} ms · place ${String(opened - created)} ms ` +
    `(${String(world.loadedCells.length)} cells, ${String(actors.length)} actors, ` +
    `the player ${world.playerView?.avatar ? 'with' : 'without'} a body, ` +
    `${world.play?.spawned === true ? 'standing' : 'not yet standing'})`,
);
const rate = seconds / ((ran - opened) / 1000);
console.log(
  `${String(seconds)} s of game in ${String(steps)} steps: ${((ran - opened) / 1000).toFixed(2)} s ` +
    `real, ${rate.toFixed(2)} game seconds per real second ` +
    `(${((ran - opened) / steps).toFixed(2)} ms a step)`,
);
for (const staged of actors) {
  const current = world.stage.ai.current(staged.reference);
  console.log(
    `  ${staged.reference.toString(16).padStart(8, '0')} ${current?.procedure ?? '-'} ` +
      `${current ? current.id.toString(16) : ''} at ${staged.position.map(Math.round).join(', ')}`,
  );
}
const kinds = new Map<string, number>();
for (const record of world.log.records) {
  const key = record.kind === 'game' ? `game:${record.type}` : record.kind;
  kinds.set(key, (kinds.get(key) ?? 0) + 1);
}
console.log(
  'observed:',
  [...kinds]
    .sort((a, b) => b[1] - a[1])
    .map(([kind, count]) => `${kind} ${String(count)}`)
    .join(', '),
);
console.log(`${String(world.terminal.problems.length)} warnings`);
world.dispose();
process.exit(0);
