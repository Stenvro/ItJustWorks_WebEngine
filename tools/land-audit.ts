// Checks every landscape (LAND) in the load order: heights, normals and colours decode, every
// layer's texture set resolves to textures that exist and parse, and how many layers a
// quadrant blends (the terrain shader draws the base and up to 7 layers).
//
//   node tools/land-audit.ts            all LAND records, summary

import { parseDds } from '../src/formats/dds/dds.ts';
import { TERRAIN_TEXTURES } from '../src/render/terrain-data.ts';
import { landTexture, parseLand } from '../src/world/land.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);

const problems = new Map<string, number>();
const problem = (text: string): void => {
  problems.set(text, (problems.get(text) ?? 0) + 1);
};
const layerCounts = new Map<number, number>();
const ltexUse = new Map<number, number>();
let lands = 0;
let minHeight = Infinity;
let maxHeight = -Infinity;
let noNormals = 0;
let noColors = 0;
let defaultBase = 0;

const started = performance.now();
for (const formId of db.formIdsOfType('LAND')) {
  const record = await db.get(formId);
  if (!record || record.deleted) continue;
  lands++;
  const land = parseLand(record);
  for (const h of land.heights) {
    if (!Number.isFinite(h)) problem('non-finite height');
    minHeight = Math.min(minHeight, h);
    maxHeight = Math.max(maxHeight, h);
  }
  if (!land.normals) noNormals++;
  if (!land.colors) noColors++;
  for (const quadrant of land.quadrants) {
    layerCounts.set(quadrant.layers.length, (layerCounts.get(quadrant.layers.length) ?? 0) + 1);
    if (quadrant.layers.length > TERRAIN_TEXTURES - 1) problem('quadrant with more than 7 layers');
    if (quadrant.base === undefined) defaultBase++;
    else ltexUse.set(quadrant.base, (ltexUse.get(quadrant.base) ?? 0) + 1);
    for (const layer of quadrant.layers) {
      ltexUse.set(layer.texture, (ltexUse.get(layer.texture) ?? 0) + 1);
      for (const a of layer.alpha) if (!(a >= 0 && a <= 1)) problem('layer opacity outside 0..1');
    }
  }
}

const textureChecks = new Map<string, string | undefined>();
async function checkTexture(path: string): Promise<string | undefined> {
  if (textureChecks.has(path)) return textureChecks.get(path);
  let result: string | undefined;
  if (path === '') result = 'no path';
  else if (!vfs.has(path)) result = 'missing';
  else {
    try {
      parseDds(await vfs.read(path));
    } catch (error) {
      result = error instanceof Error ? error.message : String(error);
    }
  }
  textureChecks.set(path, result);
  return result;
}

for (const [ltex, uses] of ltexUse) {
  const texture = await landTexture((id) => db.get(id), ltex);
  if (!texture) {
    // LTEX 0 or a form that does not exist: the engine paints these with dirt02.
    console.log(`LTEX ${ltex.toString(16)} does not exist: ${String(uses)} layers use dirt02`);
    continue;
  }
  for (const [kind, path] of [
    ['diffuse', texture.diffuse],
    ['normal', texture.normal],
  ] as const) {
    const failure = await checkTexture(path);
    if (failure) problems.set(`${kind} ${path || `of ${ltex.toString(16)}`}: ${failure}`, uses);
  }
}

console.log(
  `${String(lands)} LAND records in ${(performance.now() - started).toFixed(0)} ms, ` +
    `${String(ltexUse.size)} land textures, heights ${minHeight.toFixed(0)}..${maxHeight.toFixed(0)}`,
);
console.log(
  `without normals: ${String(noNormals)}, without colours: ${String(noColors)}, ` +
    `quadrants on the default texture: ${String(defaultBase)}`,
);
console.log(
  'layers per quadrant:',
  [...layerCounts]
    .sort((a, b) => a[0] - b[0])
    .map(([layers, count]) => `${String(layers)}: ${String(count)}`)
    .join(', '),
);
if (problems.size === 0) console.log('no problems');
for (const [text, count] of [...problems].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(7)}  ${text}`);
}
await db.close();
await vfs.close();
