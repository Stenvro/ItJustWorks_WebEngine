// Water types (WATR) of the load order: their colours, fog, fresnel, sun specular and ripple
// simulators, and the water a cell or a placed water activator takes.
//
//   node tools/water-info.ts                     every water type in one line, problems
//   node tools/water-info.ts DefaultWater        one water type in full
//   node tools/water-info.ts --cell Tamriel 4 -13  a cell's water: its height and type
//   node tools/water-info.ts --area Tamriel 2 -14 8 -9  the cells' water over an area

import { parseCell } from '../src/world/cell-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import {
  cellWater,
  DEFAULT_WATER,
  parseWater,
  type SimulatorValues,
  type WaterType,
} from '../src/world/water.ts';
import type { Rgb } from '../src/world/weather.ts';
import { Worldspace } from '../src/world/worldspace.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const hex = (id: number): string => id.toString(16).padStart(8, '0');
const rgb = (c: Rgb): string => c.map((v) => Math.round(v * 255)).join(',');
const n = (v: number): string => String(Math.round(v * 1000) / 1000);
const sim = (s: SimulatorValues): string =>
  `size ${n(s.startingSize)} force ${n(s.force)} velocity ${n(s.velocity)} ` +
  `falloff ${n(s.falloff)} dampener ${n(s.dampener)}`;

const types = new Map<number, WaterType>();
for (const id of db.formIdsOfType('WATR')) {
  const record = await db.get(id);
  if (record && !record.deleted) types.set(id, parseWater(record));
}

const describe = (type: WaterType): void => {
  console.log(`${hex(type.formId)} ${type.editorId}`);
  console.log(`  shallow ${rgb(type.shallowColor)}  deep ${rgb(type.deepColor)}`);
  console.log(`  reflection ${rgb(type.reflectionColor)}  opacity ${n(type.opacity)}`);
  console.log(
    `  fog near ${n(type.fogNear)} far ${n(type.fogFar)} amount ${n(type.fogAmount)}` +
      `  under water: near ${n(type.underwaterFogNear)} far ${n(type.underwaterFogFar)}` +
      ` amount ${n(type.underwaterFogAmount)}`,
  );
  console.log(
    `  reflectivity ${n(type.reflectivity)} fresnel ${n(type.fresnel)}` +
      ` reflection magnitude ${n(type.reflectionMagnitude)}` +
      ` refraction magnitude ${n(type.refractionMagnitude)}`,
  );
  console.log(
    `  sun specular power ${n(type.sunSpecularPower)} magnitude ${n(type.sunSpecularMagnitude)}` +
      `  sparkle power ${n(type.sunSparklePower)} magnitude ${n(type.sunSparkleMagnitude)}`,
  );
  console.log(
    `  depth: reflections ${n(type.depthReflections)} refraction ${n(type.depthRefraction)}` +
      ` normals ${n(type.depthNormals)} specular ${n(type.depthSpecular)}`,
  );
  console.log(`  displacement: ${sim(type.displacement)}`);
  console.log(`  rain: ${sim(type.rain)}`);
  console.log(`  noise: ${type.noiseTextures.join(', ')}`);
};

if (process.argv[2] === '--area') {
  const [, worldId = 'Tamriel', ...bounds] = process.argv.slice(2);
  const [x0 = 0, y0 = 0, x1 = 0, y1 = 0] = bounds.map(Number);
  const world = (await db.worldspaces()).find((w) => w.editorId === worldId);
  if (!world) throw new Error(`no worldspace ${worldId}`);
  const space = await Worldspace.open(db, world.formId);
  for (let y = y1; y >= y0; y--) {
    const row: string[] = [];
    for (let x = x0; x <= x1; x++) {
      const id = await space.cell(x, y);
      const record = id === undefined ? undefined : await db.get(id);
      const water =
        record &&
        cellWater(parseCell(record), {
          height: space.waterWorld.defaultWaterHeight,
          type: space.waterWorld.water,
        });
      const type = water ? types.get(water.type ?? DEFAULT_WATER)?.editorId : undefined;
      row.push(`${String(x)},${String(y)} ${water ? `${n(water.height)} ${type ?? '?'}` : '-'}`);
    }
    console.log(row.join(' | '));
  }
} else if (process.argv[2] === '--cell') {
  const [, worldId = 'Tamriel', xs = '0', ys = '0'] = process.argv.slice(2);
  const world = (await db.worldspaces()).find((w) => w.editorId === worldId);
  if (!world) throw new Error(`no worldspace ${worldId}`);
  const space = await Worldspace.open(db, world.formId);
  const id = await space.cell(Number(xs), Number(ys));
  const record = id === undefined ? undefined : await db.get(id);
  if (!record) throw new Error(`no cell ${xs},${ys} in ${worldId}`);
  const water = cellWater(parseCell(record), {
    height: space.waterWorld.defaultWaterHeight,
    type: space.waterWorld.water,
  });
  if (!water) {
    console.log('no water');
  } else {
    console.log(`height ${n(water.height)}`);
    const type = types.get(water.type ?? DEFAULT_WATER);
    if (type) describe(type);
  }
} else if (process.argv[2]) {
  const query = process.argv[2].toLowerCase();
  for (const type of types.values()) {
    if (type.editorId.toLowerCase().includes(query)) describe(type);
  }
} else {
  for (const type of types.values()) {
    console.log(
      `${hex(type.formId)} ${type.editorId.padEnd(32)} shallow ${rgb(type.shallowColor)}` +
        ` deep ${rgb(type.deepColor)} fog ${n(type.fogNear)}..${n(type.fogFar)}` +
        ` | displacement ${sim(type.displacement)}`,
    );
  }
  const problems = [...types.values()].filter((t) => t.fogFar < t.fogNear);
  for (const type of problems) console.log(`  problem: ${type.editorId} fog far < near`);
}
await db.close();
await vfs.close();
