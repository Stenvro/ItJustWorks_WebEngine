// The rivers' flow maps (textures\water\<plugin>\flow.<x>.<y>.dds) of the load order: how many
// each plugin has, their sizes and formats (each must be 64 texels a side, its place in the
// composite the water shader reads: src/world/flow-map.ts flowCompositeAt), and the flow normals
// (WATR NAM5) the water types move along them.
//
//   node tools/flow-maps.ts            a line per plugin folder, problems
//   node tools/flow-maps.ts --cells    also every map and every water type's flow normals

import { parseDds } from '../src/formats/dds/dds.ts';
import { FLOW_TEXELS_PER_CELL } from '../src/world/flow-map.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { parseWater, WaterFlag } from '../src/world/water.ts';
import { openGameFolder } from './gamedata-path.ts';

const cells = process.argv.includes('--cells');
const vfs = await Vfs.mount(openGameFolder());
const paths = vfs.list('textures\\water').filter((path) => /\\flow\.-?\d+\.-?\d+\.dds$/.test(path));
const byFolder = new Map<string, string[]>();
for (const path of paths) {
  const folder = path.slice(0, path.lastIndexOf('\\'));
  byFolder.set(folder, [...(byFolder.get(folder) ?? []), path]);
}
let problems = 0;
for (const [folder, list] of [...byFolder].sort()) {
  const sizes = new Map<string, number>();
  for (const path of list) {
    const dds = parseDds(await vfs.read(path));
    const key = `${String(dds.width)}x${String(dds.height)} ${dds.format}`;
    sizes.set(key, (sizes.get(key) ?? 0) + 1);
    if (dds.width !== FLOW_TEXELS_PER_CELL || dds.height !== FLOW_TEXELS_PER_CELL) {
      console.log(`  not ${String(FLOW_TEXELS_PER_CELL)} texels a side: ${path} (${key})`);
      problems++;
    }
    if (cells) console.log(`  ${path.slice(folder.length + 1)} ${key}`);
  }
  const summary = [...sizes].map(([key, count]) => `${String(count)} × ${key}`).join(', ');
  console.log(`${folder}: ${String(list.length)} maps (${summary})`);
}
// The water types' flow normals (NAM5) the flow maps move.
const db = await RecordDatabase.open(vfs);
let named = 0;
for (const id of db.formIdsOfType('WATR')) {
  const record = await db.get(id);
  if (!record || record.deleted) continue;
  const type = parseWater(record);
  if (type.flowNormals === '') continue;
  named++;
  const found = vfs.has(type.flowNormals);
  if (!found) problems++;
  const flowmap = (type.flags & WaterFlag.flowmap) !== 0 ? 'flow map' : 'no flow map';
  if (cells || !found) {
    console.log(`  ${type.editorId}: ${type.flowNormals} (${flowmap})${found ? '' : ' missing'}`);
  }
}
console.log(`${String(named)} water types name flow normals (NAM5)`);
console.log(`${String(paths.length)} flow maps, ${String(problems)} problems`);
