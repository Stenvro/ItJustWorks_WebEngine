// The collision layers' matrix of the load order (COLL records): which layers a layer collides
// with, by index and name.
//
//   node tools/layer-matrix.ts               every layer and what it collides with
//   node tools/layer-matrix.ts 30            one layer (by index: 30 is L_CHARCONTROLLER)

import { Layer, readCollisionMatrix } from '../src/physics/collision-layers.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const only = process.argv[2] === undefined ? undefined : Number(process.argv[2]);
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const matrix = await readCollisionMatrix(db);
const names = new Map<number, string>(Object.entries(Layer).map(([name, index]) => [index, name]));
for (let a = 0; a < matrix.size; a++) {
  if (only !== undefined && a !== only) continue;
  const with_: string[] = [];
  for (let b = 0; b < matrix.size; b++)
    if (matrix.collides(a, b)) with_.push(`${String(b)} ${names.get(b) ?? '?'}`);
  console.log(`${String(a)} ${names.get(a) ?? '?'}: ${with_.join(', ')}`);
}
