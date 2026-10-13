// Reads FaceGen TRI files (head part morphs): one in detail, or every one of the load order.
//
//   node tools/tri-info.ts meshes\actors\character\character assets\malehead.tri
//   node tools/tri-info.ts --all

import { parseTri } from '../src/formats/nif/tri.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const vfs = await Vfs.mount(openGameFolder());

if (args.includes('--all')) {
  let files = 0;
  const failures: string[] = [];
  const names = new Map<string, number>();
  for (const path of vfs.list('meshes')) {
    if (!path.endsWith('.tri')) continue;
    files++;
    try {
      const tri = parseTri(await vfs.read(path));
      for (const morph of tri.morphs) names.set(morph.name, (names.get(morph.name) ?? 0) + 1);
    } catch (error) {
      failures.push(`${path}: ${String(error)}`);
    }
  }
  console.log(`${String(files)} TRI files, ${String(failures.length)} failed`);
  for (const failure of failures.slice(0, 20)) console.log(`  ${failure}`);
  console.log(
    [...names]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([name, count]) => `${name}:${String(count)}`)
      .join('  '),
  );
} else {
  const path = args[0] ?? '';
  const tri = parseTri(await vfs.read(path));
  console.log(
    `${path}: ${String(tri.vertexCount)} vertices, ${String(tri.triangles.length / 3)} triangles, ` +
      `${String(tri.morphs.length)} morphs, ${String(tri.modifiers.length)} modifiers`,
  );
  for (const morph of tri.morphs) {
    let largest = 0;
    for (const value of morph.offsets) largest = Math.max(largest, Math.abs(value));
    console.log(`  morph ${morph.name}: up to ${largest.toFixed(3)} units`);
  }
  for (const modifier of tri.modifiers) {
    console.log(`  modifier ${modifier.name}: ${String(modifier.vertices.length)} vertices`);
  }
}
await vfs.close();
