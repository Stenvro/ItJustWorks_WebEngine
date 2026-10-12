// Shows the collision of meshes (Havok bodies and shapes in game units) and checks it against
// the rendered geometry: the collision's bounding box should lie within (or close to) the
// model's.
//
//   node tools/collision-info.ts meshes\clutter\bucket01.nif     one mesh in detail
//   node tools/collision-info.ts --all [filter]                   every mesh: totals, problems

import { parseNif } from '../src/formats/nif/nif.ts';
import {
  buildCollision,
  type CollisionData,
  type CollisionShape,
} from '../src/physics/collision-data.ts';
import { buildModel } from '../src/render/model-data.ts';
import { transformPoint } from '../src/render/math.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const LAYERS = [
  'UNIDENTIFIED',
  'STATIC',
  'ANIMSTATIC',
  'TRANSPARENT',
  'CLUTTER',
  'WEAPON',
  'PROJECTILE',
  'SPELL',
  'BIPED',
  'TREES',
  'PROPS',
  'WATER',
  'TRIGGER',
  'TERRAIN',
  'TRAP',
  'NONCOLLIDABLE',
  'CLOUD_TRAP',
  'GROUND',
  'PORTAL',
  'DEBRIS_SMALL',
  'DEBRIS_LARGE',
  'ACOUSTIC_SPACE',
  'ACTORZONE',
  'PROJECTILEZONE',
  'GASTRAP',
  'SHELLCASING',
  'TRANSPARENT_SMALL',
  'INVISIBLE_WALL',
  'TRANSPARENT_SMALL_ANIM',
  'WARD',
  'CHARCONTROLLER',
  'STAIRHELPER',
  'DEADBIP',
  'BIPED_NO_CC',
  'AVOIDBOX',
  'COLLISIONBOX',
  'CAMERASPHERE',
  'DOORDETECTION',
  'CONEPROJECTILE',
  'CAMERAPICK',
  'ITEMPICK',
  'LINEOFSIGHT',
  'PATHPICK',
  'CUSTOMPICK1',
  'CUSTOMPICK2',
  'SPELLEXPLOSION',
  'DROPPINGPICK',
];
const layerName = (layer: number): string => LAYERS[layer] ?? String(layer);

type Box = [number, number, number, number, number, number];
const emptyBox = (): Box => [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
const grow = (box: Box, p: readonly number[]): void => {
  for (let k = 0; k < 3; k++) {
    box[k] = Math.min(box[k] ?? 0, p[k] ?? 0);
    box[k + 3] = Math.max(box[k + 3] ?? 0, p[k] ?? 0);
  }
};

function shapePoints(shape: CollisionShape): number[][] {
  switch (shape.type) {
    case 'mesh':
    case 'convex': {
      const values = shape.type === 'mesh' ? shape.vertices : shape.points;
      const points: number[][] = [];
      for (let i = 0; i + 2 < values.length; i += 3) {
        points.push([values[i] ?? 0, values[i + 1] ?? 0, values[i + 2] ?? 0]);
      }
      return points;
    }
    case 'box': {
      const [hx, hy, hz] = shape.halfExtents;
      const points: number[][] = [];
      for (const sx of [-1, 1])
        for (const sy of [-1, 1])
          for (const sz of [-1, 1])
            points.push(transformPoint(shape.transform, [sx * hx, sy * hy, sz * hz]));
      return points;
    }
    case 'sphere':
      return [shape.center.map((v) => v - shape.radius), shape.center.map((v) => v + shape.radius)];
    case 'capsule':
    case 'cylinder': {
      const r = shape.radius + (shape.type === 'cylinder' ? shape.shell : 0);
      return [shape.a, shape.b].flatMap((p) => [p.map((v) => v - r), p.map((v) => v + r)]);
    }
  }
}

function collisionBox(collision: CollisionData): Box {
  const box = emptyBox();
  for (const body of collision.bodies) {
    for (const shape of body.shapes) {
      for (const p of shapePoints(shape))
        grow(box, transformPoint(body.transform, [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0]));
    }
  }
  return box;
}

function describeShape(shape: CollisionShape): string {
  const where = `${layerName(shape.layer)} mat ${String(shape.material)}`;
  switch (shape.type) {
    case 'mesh':
      return `mesh ${String(shape.indices.length / 3)} triangles, ${String(shape.vertices.length / 3)} vertices · ${where}`;
    case 'convex':
      return `convex ${String(shape.points.length / 3)} points, shell ${shape.radius.toFixed(2)} · ${where}`;
    case 'box':
      return `box ${shape.halfExtents.map((v) => v.toFixed(1)).join('×')} · ${where}`;
    case 'sphere':
      return `sphere r ${shape.radius.toFixed(1)} · ${where}`;
    case 'capsule':
      return `capsule r ${shape.radius.toFixed(1)} · ${where}`;
    case 'cylinder':
      return `cylinder r ${shape.radius.toFixed(1)} · ${where}`;
  }
}

const fmt = (box: Box): string =>
  `[${box
    .slice(0, 3)
    .map((v) => v.toFixed(0))
    .join(', ')}] .. [${box
    .slice(3)
    .map((v) => v.toFixed(0))
    .join(', ')}]`;

const vfs = await Vfs.mount(openGameFolder());
const all = process.argv.includes('--all');
const arg =
  process.argv
    .slice(2)
    .find((value) => !value.startsWith('--'))
    ?.toLowerCase() ?? '';

if (!all) {
  const nif = parseNif(await vfs.read(arg));
  const collision = buildCollision(nif);
  const model = buildModel(nif);
  for (const body of collision.bodies) {
    console.log(
      `${body.node || '(root)'} · ${body.motion}${body.phantom ? ' phantom' : ''} · ${layerName(body.layer)} · mass ${body.mass.toFixed(1)} · friction ${body.friction.toFixed(2)} · restitution ${body.restitution.toFixed(2)}`,
    );
    for (const shape of body.shapes) console.log(`   ${describeShape(shape)}`);
  }
  for (const skipped of collision.skipped) console.log(`  skipped: ${skipped}`);
  const render = emptyBox();
  for (const part of model.parts)
    grow(
      render,
      part.center.map((v, k) => v - part.radius + (k === 3 ? 0 : 0)),
    );
  const [cx, cy, cz] = model.center;
  console.log(`collision ${fmt(collisionBox(collision))}`);
  console.log(
    `render sphere centre [${[cx, cy, cz].map((v) => v.toFixed(0)).join(', ')}] radius ${model.radius.toFixed(0)}`,
  );
} else {
  const paths = vfs.list('meshes').filter((path) => path.endsWith('.nif') && path.includes(arg));
  const counts = new Map<string, number>();
  const outside: string[] = [];
  const skipped = new Map<string, number>();
  let withCollision = 0;
  for (const path of paths) {
    const nif = parseNif(await vfs.read(path));
    const collision = buildCollision(nif);
    for (const reason of collision.skipped) skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
    if (collision.bodies.length === 0) continue;
    withCollision++;
    for (const body of collision.bodies) {
      counts.set(`motion ${body.motion}`, (counts.get(`motion ${body.motion}`) ?? 0) + 1);
      for (const shape of body.shapes)
        counts.set(`shape ${shape.type}`, (counts.get(`shape ${shape.type}`) ?? 0) + 1);
    }
    // The collision should fit inside the model's bounding sphere (plus slack).
    const model = buildModel(nif);
    if (model.parts.length === 0) continue;
    const box = collisionBox(collision);
    const corners = [
      [box[0], box[1], box[2]],
      [box[3], box[4], box[5]],
    ];
    const far = Math.max(
      ...corners.map((c) =>
        Math.hypot(
          (c[0] ?? 0) - model.center[0],
          (c[1] ?? 0) - model.center[1],
          (c[2] ?? 0) - model.center[2],
        ),
      ),
    );
    if (far > model.radius * 1.5 + 64)
      outside.push(
        `${path}: collision reaches ${far.toFixed(0)}, model radius ${model.radius.toFixed(0)}`,
      );
  }
  console.log(`${String(withCollision)} of ${String(paths.length)} meshes have collision`);
  for (const [key, value] of [...counts].sort()) console.log(`  ${key}: ${String(value)}`);
  for (const [reason, n] of skipped) console.log(`  skipped ${String(n)}× ${reason}`);
  console.log(`${String(outside.length)} meshes whose collision reaches beyond the model:`);
  for (const line of outside.slice(0, 30)) console.log(`  ${line}`);
}
await vfs.close();
