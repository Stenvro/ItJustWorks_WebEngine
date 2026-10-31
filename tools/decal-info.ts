// Placed decals (TXST references): which texture sets the load order places and how often,
// with their decal data; with --cell, where a cell's decals land (the ray along their +Y
// axis to the first surface); with --impacts, the impacts (IPCT) that leave a decal on what they
// strike: their angle threshold (which faces of the struck shapes take it) and their decal's
// size and depth (the box its triangles are clipped to).
//
//   node tools/decal-info.ts
//   node tools/decal-info.ts --cell WhiterunDragonsreachBasement
//   node tools/decal-info.ts --impacts

import { parseArgs } from 'node:util';
import { parseNif } from '../src/formats/nif/nif.ts';
import { projectDecals } from '../src/render/decal-projection.ts';
import { maxScale, transformPoint } from '../src/render/math.ts';
import { buildModel } from '../src/render/model-data.ts';
import type { PlacedPart } from '../src/render/raycast.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { loadCellData } from '../src/world/cell-loader.ts';
import { parseTextureSet } from '../src/world/decal.ts';
import { parseImpact } from '../src/world/impact-records.ts';
import { worldDecalFaceLimit } from '../src/render/world-decal.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values } = parseArgs({
  options: { cell: { type: 'string' }, impacts: { type: 'boolean' } },
});
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);

if (values.impacts) {
  // Impacts leave a decal unless DATA flag 0x1 (no decal data) is set or they name no set.
  const angles = new Map<number, number>();
  let made = 0;
  for (const id of db.formIdsOfType('IPCT')) {
    const record = await db.get(id);
    if (!record) continue;
    const impact = parseImpact(record);
    if (((record.fields.first('DATA')?.[20] ?? 0) & 0x1) !== 0) continue;
    const setId = record.formIdField('DNAM');
    const setRecord = setId === undefined ? undefined : await db.get(setId);
    if (!setRecord) continue;
    const decal =
      parseTextureSet({ fields: record.fields }).decal ?? parseTextureSet(setRecord).decal;
    if (!decal) continue;
    made++;
    angles.set(impact.angleThreshold, (angles.get(impact.angleThreshold) ?? 0) + 1);
    const faces = worldDecalFaceLimit(impact.angleThreshold);
    console.log(
      `${record.editorId ?? id.toString(16)}: angle ${String(impact.angleThreshold)}° ` +
        `(faces within cos ${faces.toFixed(2)}), ${String(decal.minWidth)}–${String(decal.maxWidth)} × ` +
        `${String(decal.minHeight)}–${String(decal.maxHeight)}, depth ±${String(decal.depth)}, ` +
        `placement radius ${String(impact.placementRadius)}`,
    );
  }
  const spread = [...angles].sort((a, b) => a[0] - b[0]);
  console.log(
    `${String(made)} impacts leave a decal; angle thresholds: ` +
      spread.map(([angle, count]) => `${String(angle)}° ×${String(count)}`).join(', '),
  );
} else if (values.cell) {
  const wanted = values.cell.toLowerCase();
  const cell = (await db.interiorCells()).find((c) => c.editorId.toLowerCase() === wanted);
  if (!cell) throw new Error(`No interior cell ${values.cell}`);
  const data = await loadCellData(db, cell.formId);
  const parts: PlacedPart[] = [];
  for (const object of data.objects) {
    try {
      for (const part of buildModel(parseNif(await vfs.read(object.model))).parts) {
        parts.push({
          part,
          instanceWorld: object.world,
          center: transformPoint(object.world, part.center),
          radius: part.radius * maxScale(object.world),
        });
      }
    } catch {
      // Broken or missing models are reported by the cell tools.
    }
  }
  const projected = projectDecals(data.decals, parts);
  data.decals.forEach((decal, i) => {
    const before = [12, 13, 14].map((k) => decal.box[k] ?? 0);
    const after = [12, 13, 14].map((k) => projected[i]?.box[k] ?? 0);
    const shift = Math.hypot(...before.map((v, k) => (after[k] ?? 0) - v));
    console.log(
      `${decal.textureSet.editorId} at ${before.map(Math.round).join(', ')}: ` +
        (shift > 0 ? `lands ${shift.toFixed(0)} units along +Y` : 'no surface within reach'),
    );
  });
} else {
  const textureSets = new Set(db.formIdsOfType('TXST'));
  const placed = new Map<number, number>();
  for (const id of db.formIdsOfType('REFR')) {
    const record = await db.get(id);
    const name = record?.fields.first('NAME');
    if (!record || !name) continue;
    const base = record.formIdAt(name);
    if (textureSets.has(base)) placed.set(base, (placed.get(base) ?? 0) + 1);
  }
  let total = 0;
  for (const [base, count] of [...placed].sort((a, b) => b[1] - a[1])) {
    total += count;
    const record = await db.get(base);
    if (!record) continue;
    const set = parseTextureSet(record);
    const decal = set.decal;
    console.log(
      `${String(count).padStart(5)}  ${set.editorId}: ` +
        (decal
          ? `${String(decal.minWidth)}–${String(decal.maxWidth)} × ${String(decal.minHeight)}–${String(decal.maxHeight)}, ` +
            `depth ${String(decal.depth)}, flags 0x${decal.flags.toString(16)}, ${set.textures[0] ?? ''}`
          : 'no decal data'),
    );
  }
  console.log(`${String(total)} decal references, ${String(placed.size)} texture sets`);
}
await db.close();
await vfs.close();
