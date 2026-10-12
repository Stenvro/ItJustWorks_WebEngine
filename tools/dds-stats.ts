// Parses every DDS in the VFS and reports formats, cubemaps and edge cases.
//
//   node tools/dds-stats.ts            all textures
//   node tools/dds-stats.ts sky        only paths containing "sky"

import { parseDds } from '../src/formats/dds/dds.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const filter = process.argv[2]?.toLowerCase();
const vfs = await Vfs.mount(openGameFolder());
const paths = vfs
  .list('')
  .filter((path) => path.endsWith('.dds') && (filter === undefined || path.includes(filter)));

const formats = new Map<string, number>();
const notes = new Map<string, string[]>();
const failures: string[] = [];
const note = (key: string, path: string): void => {
  const list = notes.get(key) ?? [];
  list.push(path);
  notes.set(key, list);
};
const start = performance.now();

for (const path of paths) {
  try {
    const bytes = await vfs.read(path);
    const texture = parseDds(bytes);
    const key = `${texture.format}${texture.srgb ? ' (srgb)' : ''}`;
    formats.set(key, (formats.get(key) ?? 0) + 1);
    if (texture.cubemap) note('cubemap', path);
    if (texture.layerCount > 1 && !texture.cubemap) note('array texture', path);
    if (texture.format.startsWith('bc') && (texture.width % 4 !== 0 || texture.height % 4 !== 0)) {
      note('block-compressed size not a multiple of 4', path);
    }
    // Partial chains (stopping at 4x4) are normal for block-compressed textures.
    if (texture.mipCount === 1 && Math.max(texture.width, texture.height) > 4) {
      note('no mipmaps', path);
    }
    const used = texture.levels.reduce((sum, level) => sum + level.size, 0);
    if (texture.format !== 'rgba8unorm' && bytes.length - 128 > used + 20) {
      note('trailing bytes after the last level', path);
    }
  } catch (error) {
    failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(`${paths.length} textures in ${((performance.now() - start) / 1000).toFixed(1)} s`);
console.log('\nFormats:');
for (const [format, count] of [...formats].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(7)}  ${format}`);
}
console.log('\nNotes:');
for (const [key, list] of notes) {
  console.log(`  ${key}: ${list.length}`);
  for (const path of list.slice(0, 3)) console.log(`    ${path}`);
}
console.log(`\n${failures.length} failures`);
for (const failure of failures.slice(0, 20)) console.log(`  ${failure}`);
await vfs.close();
