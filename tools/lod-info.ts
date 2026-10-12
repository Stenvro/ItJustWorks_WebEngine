// Distant LOD of the worldspaces: settings, terrain/object/tree blocks per level, and a parse
// of every tree list and tree block (and, with --meshes, every .btr/.bto mesh).
//
//   node tools/lod-info.ts              all worldspaces with LOD
//   node tools/lod-info.ts --meshes     also parse every terrain and object LOD mesh

import { parseLodSettings, parseTreeBlock, parseTreeList } from '../src/formats/lod/lod.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { buildModel } from '../src/render/model-data.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const meshes = process.argv.includes('--meshes');
const vfs = await Vfs.mount(openGameFolder());
const problems: string[] = [];
const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

for (const settingsPath of vfs.list('lodsettings')) {
  const world = (settingsPath.split('\\').pop() ?? '').replace(/\.lod$/, '');
  const settings = parseLodSettings(await vfs.read(settingsPath));
  const files = vfs.list(`meshes\\terrain\\${world}`);
  const count = (pattern: RegExp): string => {
    const levels = new Map<string, number>();
    for (const file of files) {
      const match = pattern.exec(file);
      if (match?.[1]) levels.set(match[1], (levels.get(match[1]) ?? 0) + 1);
    }
    return [...levels].map(([level, n]) => `${level}:${String(n)}`).join(' ') || '-';
  };
  console.log(
    `${world}: SW ${String(settings.southWestX)},${String(settings.southWestY)} stride ${String(settings.stride)} ` +
      `levels ${String(settings.lowestLevel)}..${String(settings.highestLevel)} · terrain ${count(/\.(\d+)\.-?\d+\.-?\d+\.btr$/)} · ` +
      `objects ${count(/\.(\d+)\.-?\d+\.-?\d+\.bto$/)} · trees ${count(/\.(\d+)\.-?\d+\.-?\d+\.btt$/)}`,
  );

  const listPath = `meshes\\terrain\\${world}\\trees\\${world}.lst`;
  const types = vfs.has(listPath) ? parseTreeList(await vfs.read(listPath)) : [];
  for (const file of files.filter((f) => f.endsWith('.btt'))) {
    try {
      for (const tree of parseTreeBlock(await vfs.read(file))) {
        if (!types.some((t) => t.index === tree.type))
          problems.push(`${file}: tree type ${String(tree.type)} not in the list`);
      }
    } catch (error) {
      problems.push(`${file}: ${describe(error)}`);
    }
  }
  if (meshes) {
    for (const file of files.filter((f) => /\.bt[ro]$/.test(f))) {
      try {
        const nif = parseNif(await vfs.read(file));
        for (const problem of nif.problems) problems.push(`${file}: ${problem}`);
        const model = buildModel(nif);
        if (model.parts.length === 0) problems.push(`${file}: nothing to draw`);
        for (const skipped of model.skipped) problems.push(`${file}: ${skipped}`);
      } catch (error) {
        problems.push(`${file}: ${describe(error)}`);
      }
    }
  }
}
console.log(problems.length === 0 ? 'no problems' : problems.slice(0, 40).join('\n'));
if (problems.length > 40) console.log(`… ${String(problems.length - 40)} more`);
await vfs.close();
