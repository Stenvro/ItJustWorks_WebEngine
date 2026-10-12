// Checks that everything placed in interior cells can be drawn: every model loads, every
// shape is understood and every texture exists and parses. Lists what is not drawn and why.
//
//   node tools/cell-audit.ts                       all interior cells, summary
//   node tools/cell-audit.ts DLC2RRSeverinHouse    one cell (or editor id substring), details

import { parseDds } from '../src/formats/dds/dds.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { buildModel, type ModelData } from '../src/render/model-data.ts';
import { loadCellData } from '../src/world/cell-loader.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const query = (process.argv[2] ?? '').toLowerCase();
/** `--models <problem>`: list the models with a problem (substring), over all cells. */
const modelsFor =
  process.argv.indexOf('--models') > 0
    ? (process.argv[process.argv.indexOf('--models') + 1] ?? '')
    : undefined;
const byProblem = new Map<string, number>();
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);

interface ModelReport {
  readonly error: string | undefined;
  readonly model: ModelData | undefined;
  /** NIF blocks of these types are not understood (not drawn if they are geometry). */
  readonly unknownTypes: readonly string[];
  readonly problems: readonly string[];
}

const GEOMETRY =
  /^(NiTriStrips|NiTriShape|BSLODTriShape|BSSubIndexTriShape|BSMeshLODTriShape|BSTriShape|BSDynamicTriShape|NiParticleSystem|BSStripParticleSystem|BSMultiBoundNode|NiNode|BSFadeNode|BSLightingShaderProperty|BSEffectShaderProperty|BSShaderTextureSet|NiAlphaProperty)$/;
const models = new Map<string, Promise<ModelReport>>();
const textures = new Map<string, Promise<string | undefined>>();

function loadModel(path: string): Promise<ModelReport> {
  let pending = models.get(path);
  if (!pending) {
    pending = (async (): Promise<ModelReport> => {
      if (!vfs.has(path))
        return { error: 'file missing', model: undefined, unknownTypes: [], problems: [] };
      try {
        const nif = parseNif(await vfs.read(path));
        const unknownTypes = [
          ...new Set(
            nif.blocks.flatMap((b, i) => (b.kind === 'unknown' ? [nif.blockTypes[i] ?? '?'] : [])),
          ),
        ];
        return { error: undefined, model: buildModel(nif), unknownTypes, problems: nif.problems };
      } catch (error) {
        return { error: String(error), model: undefined, unknownTypes: [], problems: [] };
      }
    })();
    models.set(path, pending);
  }
  return pending;
}

function checkTexture(path: string): Promise<string | undefined> {
  let pending = textures.get(path);
  if (!pending) {
    pending = (async (): Promise<string | undefined> => {
      if (!vfs.has(path)) return 'missing';
      try {
        parseDds(await vfs.read(path));
        return undefined;
      } catch (error) {
        return String(error);
      }
    })();
    textures.set(path, pending);
  }
  return pending;
}

const cells = (await db.interiorCells()).filter(
  (c) => query === '' || query.startsWith('--') || c.editorId.toLowerCase().includes(query),
);
const detail = cells.length <= 3;
const totals = new Map<string, number>();
const count = (key: string, n = 1): void => {
  totals.set(key, (totals.get(key) ?? 0) + n);
};
const worst: { cell: string; issues: number }[] = [];

for (const cell of cells) {
  let data;
  try {
    data = await loadCellData(db, cell.formId);
  } catch (error) {
    count(`cell load error: ${String(error)}`);
    continue;
  }
  let issues = 0;
  const lines: string[] = [];
  const objectsByModel = new Map<string, number>();
  for (const o of data.objects) objectsByModel.set(o.model, (objectsByModel.get(o.model) ?? 0) + 1);
  for (const [path, uses] of objectsByModel) {
    const report = await loadModel(path);
    const note = (what: string): void => {
      issues += uses;
      count(what, uses);
      if (modelsFor !== undefined && what.includes(modelsFor)) {
        byProblem.set(path, (byProblem.get(path) ?? 0) + uses);
      }
      if (detail) lines.push(`  ${String(uses).padStart(3)}× ${path}: ${what}`);
    };
    if (report.error) {
      note(report.error);
      continue;
    }
    const model = report.model;
    if (!model) continue;
    if (model.parts.length === 0 && !model.editorMarker) note('no drawable shapes');
    for (const type of report.unknownTypes) {
      if (GEOMETRY.test(type)) note(`geometry block not understood: ${type}`);
      else count(`(info) block not understood: ${type}`, uses);
    }
    for (const skipped of new Set(model.skipped)) note(`skipped: ${skipped.replace(/^.*?: /, '')}`);
    for (const part of model.parts) {
      const material = part.material;
      if (!material) {
        note('shape without material');
        continue;
      }
      const paths =
        material.kind === 'lighting'
          ? material.textures
          : material.kind === 'effect'
            ? [material.sourceTexture, material.greyscaleTexture]
            : []; // water takes its textures from its WATR type
      for (const texture of paths) {
        if (texture === '') continue;
        const problem = await checkTexture(texture);
        if (problem) note(`texture ${problem}: ${texture}`);
      }
    }
  }
  for (const skipped of data.skipped) count(`cell: ${skipped.replace(/^\d+× /, '')}`);
  worst.push({ cell: `${cell.editorId} "${cell.name}"`, issues });
  if (detail) {
    console.log(
      `${cell.editorId} "${cell.name}": ${data.objects.length} objects, ${issues} problems`,
    );
    for (const line of [...new Set(lines)].sort()) console.log(line);
    for (const skipped of data.skipped) console.log(`  cell: ${skipped}`);
  }
}

if (modelsFor !== undefined) {
  console.log(`Models with "${modelsFor}":`);
  for (const [path, n] of [...byProblem].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
    console.log(`  ${String(n).padStart(5)}  ${path}`);
  }
}
console.log(`\n${cells.length} cells, ${models.size} models, ${textures.size} textures`);
for (const [what, n] of [...totals]
  .sort((a, b) => b[1] - a[1])
  .filter(([what]) => !what.startsWith('(info)'))
  .slice(0, 60)) {
  console.log(`  ${String(n).padStart(6)}  ${what}`);
}
if (!detail) {
  console.log('\nCells with the most problems:');
  for (const w of worst.sort((a, b) => b.issues - a.issues).slice(0, 15)) {
    console.log(`  ${String(w.issues).padStart(5)}  ${w.cell}`);
  }
}
await db.close();
await vfs.close();
