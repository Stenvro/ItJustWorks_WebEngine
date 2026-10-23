// Drops every race skeleton's ragdoll (skeleton.nif: bodies on the bones, joined by ragdoll and
// hinge constraints) on a flat floor and measures how it comes to rest: when every body sleeps,
// how fast any body went, how often bodies flip their vertical velocity at the end (jitter), and
// whether its joints held. With --pose, every placed ragdoll pose (XRGD) is checked against
// the bodies of its model; with --limits, their joints' angles against the joints' limits; with
// --ref <form id>, one placed dead's ragdoll is let go from its placed pose.
//
//   node tools/ragdoll-info.ts                  every race skeleton, dropped from its rest pose
//   node tools/ragdoll-info.ts wolf             the skeletons whose path contains "wolf"
//   node tools/ragdoll-info.ts --seconds 30     simulate longer (default 20)
//   node tools/ragdoll-info.ts --still          no push as they are let go (a script's kill)
//   node tools/ragdoll-info.ts --pose | --limits | --ref 97D60

import { ActorPose, ActorSkeleton, buildRig, type RigData } from '../src/animation/skeleton.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { invert } from '../src/render/frustum.ts';
import { multiply, transformPoint, type Vec3 } from '../src/render/math.ts';
import { buildCollision, HAVOK_SCALE, type CollisionData } from '../src/physics/collision-data.ts';
import { CollisionMatrix, Layer, parseCollisionLayer } from '../src/physics/collision-layers.ts';
import {
  GRAVITY,
  initPhysics,
  PHYSICS_STEP,
  matrixQuaternion,
  PhysicsWorld,
  type PlacedCollision,
} from '../src/physics/physics-world.ts';
import { parseRace } from '../src/world/actor-records.ts';
import { ActorResolver, meshPath } from '../src/world/actors.ts';
import { bodyOnPose, poseRagdoll } from '../src/shell/actors.ts';
import { parseRagdollData, ragdollPoseLocals } from '../src/world/ragdoll-data.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const seconds = Number(option('--seconds') ?? 20);
const filter = args.find(
  (arg, i) => !arg.startsWith('--') && args[i - 1] !== '--seconds' && args[i - 1] !== '--ref',
);

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const layers = [];
for (const formId of db.formIdsOfType('COLL')) {
  const record = await db.get(formId);
  if (record) layers.push(parseCollisionLayer(record));
}
const matrix = new CollisionMatrix(layers);
await initPhysics();

// The race skeletons (male and female), each once.
const skeletons = new Map<string, string>();
for (const formId of db.formIdsOfType('RACE')) {
  const record = await db.get(formId);
  if (!record) continue;
  const race = parseRace(record);
  for (const path of race.skeleton) {
    if (path === undefined) continue;
    const mesh = meshPath(path).toLowerCase();
    if (!skeletons.has(mesh)) skeletons.set(mesh, record.editorId ?? formId.toString(16));
  }
}

/** One drop's measures. */
interface Drop {
  readonly bodies: number;
  readonly joints: number;
  /** Seconds until every body slept for good (undefined: never). */
  readonly rest: number | undefined;
  /** The fastest any body went (game units a second). */
  readonly top: number;
  /** Vertical velocity flips above 30 u/s a second, per body, over the last 5 s. */
  readonly flips: number;
  /** Bodies awake at the end. */
  readonly awake: number;
  /** The widest gap between a joint's two pivots at the end (game units). */
  readonly stretch: number;
  /** Its highest body at the end over its highest at the start (it lay down: well below 1). */
  readonly height: number;
}

function drop(
  collision: CollisionData,
  posing?: (physics: PhysicsWorld, placed: PlacedCollision, world: Float32Array) => void,
): Drop {
  const physics = new PhysicsWorld(matrix, GRAVITY);
  physics.addMesh(
    Float32Array.of(-5000, -5000, 0, 5000, -5000, 0, 5000, 5000, 0, -5000, 5000, 0),
    Uint32Array.of(0, 1, 2, 0, 2, 3),
    Layer.ground,
    { reference: 0, kind: 'landscape' },
    true,
  );
  const world = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  // Raised so that its lowest body clears the floor.
  const placedOnce = physics.addObject(collision, world, { reference: 1, kind: 'actor' }, false);
  let lowest = Infinity;
  for (const { body } of placedOnce.bodies) lowest = Math.min(lowest, body.translation().z);
  physics.remove(placedOnce);
  world[14] = posing ? 5 : Math.max(0, -lowest * HAVOK_SCALE) + 2;
  const placed: PlacedCollision = physics.addObject(
    collision,
    world,
    { reference: 1, kind: 'actor' },
    false,
  );
  posing?.(physics, placed, world);
  physics.setMotion(placed, false);
  physics.setLayer(placed, Layer.deadBip);
  // A death's push: a little forward, as a blow gives it (none with --still: a script's kill).
  if (!args.includes('--still')) physics.kick(placed, [1, 0, 0], 1);
  const bodies = placed.bodies.filter((b) => b.body.isDynamic());
  const top = (): number => Math.max(...bodies.map(({ body }) => body.translation().z));
  const startTop = top();
  const steps = Math.round(seconds / PHYSICS_STEP);
  let rest: number | undefined;
  let fastest = 0;
  let flips = 0;
  const lastVz = new Map<number, number>();
  for (let i = 0; i < steps; i++) {
    physics.step(PHYSICS_STEP);
    const t = (i + 1) * PHYSICS_STEP;
    let asleep = true;
    for (const { body } of bodies) {
      if (!body.isSleeping()) asleep = false;
      const v = body.linvel();
      fastest = Math.max(fastest, Math.hypot(v.x, v.y, v.z) * HAVOK_SCALE);
      const vz = v.z * HAVOK_SCALE;
      if (t > seconds - 5 && Math.abs(vz) > 30) {
        const before = lastVz.get(body.handle);
        if (before !== undefined && Math.sign(before) !== Math.sign(vz)) flips++;
        lastVz.set(body.handle, vz);
      }
    }
    if (asleep) rest ??= t;
    else rest = undefined;
  }
  let stretch = 0;
  for (const joint of placed.joints) {
    const j = joint.joint;
    if (!j) continue;
    const a = j.body1();
    const b = j.body2();
    const pa = a.translation();
    const pb = b.translation();
    const ra = a.rotation();
    const rb = b.rotation();
    const rotate = (
      q: { x: number; y: number; z: number; w: number },
      v: { x: number; y: number; z: number },
    ): [number, number, number] => {
      const tx = 2 * (q.y * v.z - q.z * v.y);
      const ty = 2 * (q.z * v.x - q.x * v.z);
      const tz = 2 * (q.x * v.y - q.y * v.x);
      return [
        v.x + q.w * tx + (q.y * tz - q.z * ty),
        v.y + q.w * ty + (q.z * tx - q.x * tz),
        v.z + q.w * tz + (q.x * ty - q.y * tx),
      ];
    };
    const wa = rotate(ra, j.anchor1());
    const wb = rotate(rb, j.anchor2());
    stretch = Math.max(
      stretch,
      Math.hypot(
        pa.x + wa[0] - pb.x - wb[0],
        pa.y + wa[1] - pb.y - wb[1],
        pa.z + wa[2] - pb.z - wb[2],
      ) * HAVOK_SCALE,
    );
  }
  const awake = bodies.filter(({ body }) => !body.isSleeping()).length;
  const result: Drop = {
    bodies: bodies.length,
    joints: placed.joints.length,
    rest,
    top: fastest,
    flips: flips / Math.max(1, bodies.length) / 5,
    awake,
    stretch,
    height: top() / startTop,
  };
  physics.free();
  return result;
}

/**
 * Every placed ragdoll pose (XRGD) against its model's pose order: how many apply completely,
 * where those that do not stop (by model and entry), and for the dead how far their joints'
 * two pivots lie apart in the posed skeleton (a pose read the right way holds its joints
 * together).
 */
async function auditPoses(): Promise<void> {
  const resolver = new ActorResolver(db);
  interface Model {
    readonly collision: CollisionData;
    readonly rig: RigData;
  }
  const models = new Map<string, Model | undefined>();
  const modelOf = async (path: string): Promise<Model | undefined> => {
    const key = path.toLowerCase();
    if (!models.has(key)) {
      if (!vfs.has(key)) {
        models.set(key, undefined);
      } else {
        const file = parseNif(await vfs.read(key));
        models.set(key, { collision: buildCollision(file), rig: buildRig(file) });
      }
    }
    return models.get(key);
  };
  for (const type of ['ACHR', 'REFR']) {
    let all = 0;
    let complete = 0;
    let unmodelled = 0;
    const gaps: number[] = [];
    const stops = new Map<string, number>();
    for (const formId of db.formIdsOfType(type)) {
      const record = await db.get(formId);
      const data = record && parseRagdollData(record.fields);
      if (!record || !data) continue;
      all++;
      const base = record.formIdField('NAME') ?? 0;
      let path: string | undefined;
      if (type === 'ACHR') {
        path = (await resolver.resolve(base, formId))?.skeleton;
      } else {
        const model = (await db.get(base))?.fields.zstring('MODL');
        path = model ? meshPath(model) : undefined;
      }
      const model = path === undefined ? undefined : await modelOf(path);
      const order = model?.collision.poseOrder;
      if (!model || !order) {
        unmodelled++;
        continue;
      }
      const skeleton = new ActorSkeleton(model.rig, undefined);
      const rest = (node: number): Float32Array =>
        model.rig.local.subarray(node * 16, node * 16 + 16);
      const result = ragdollPoseLocals(
        data,
        order,
        (name) => skeleton.nodeByName.get(name.toLowerCase()),
        rest,
      );
      if (result.complete) {
        complete++;
        if (type === 'ACHR') gaps.push(jointGap(model.collision, skeleton, result.locals));
        continue;
      }
      const at = result.locals.size;
      const key = `${path} at entry ${String(at)} (${order[at]?.node ?? '-'} part ${String(order[at]?.part ?? '-')}, entry part ${String(data.bones[at]?.part ?? '-')}; ${String(data.bones.length)} entries, ${String(order.length)} nodes)`;
      stops.set(key, (stops.get(key) ?? 0) + 1);
    }
    console.log(
      `${type}: ${String(all)} placed ragdoll poses, ${String(complete)} apply completely, ${String(unmodelled)} without a model`,
    );
    if (gaps.length > 0) {
      gaps.sort((a, b) => a - b);
      const at = (f: number): string => (gaps[Math.floor(f * (gaps.length - 1))] ?? 0).toFixed(2);
      console.log(
        `  joints' pivot gaps in the posed skeletons (game units): median ${at(0.5)}, 95 % ${at(0.95)}, most ${at(1)}`,
      );
    }
    for (const [key, count] of [...stops].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
      console.log(`  ${String(count).padStart(5)}  stop: ${key}`);
    }
  }
}

/** The widest gap between a joint's two pivots with the skeleton posed by `locals`. */
function jointGap(
  collision: CollisionData,
  skeleton: ActorSkeleton,
  locals: ReadonlyMap<number, Float32Array>,
): number {
  const rest = new ActorPose(skeleton);
  const posed = new ActorPose(skeleton);
  posed.placeLocals(locals);
  const bodyPose = (index: number): Float32Array | undefined => {
    const body = collision.bodies[index];
    const node = body && skeleton.nodeByName.get(body.node.toLowerCase());
    if (!body || node === undefined) return undefined;
    const restInverse = invert(rest.worlds.subarray(node * 16, node * 16 + 16));
    if (!restInverse) return undefined;
    return multiply(
      posed.worlds.subarray(node * 16, node * 16 + 16),
      multiply(restInverse, body.transform),
    );
  };
  let widest = 0;
  for (const constraint of collision.constraints ?? []) {
    const data = constraint.data;
    const pivots: [Vec3, Vec3] | undefined =
      data.type === 'ragdoll' || data.type === 'limited-hinge' || data.type === 'hinge'
        ? [data.a.pivot, data.b.pivot]
        : data.type === 'ball-and-socket'
          ? [data.pivotA, data.pivotB]
          : undefined;
    const a = bodyPose(constraint.bodyA);
    const b = bodyPose(constraint.bodyB);
    if (!pivots || !a || !b) continue;
    const pa = transformPoint(a, pivots[0]);
    const pb = transformPoint(b, pivots[1]);
    widest = Math.max(widest, Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]));
  }
  return widest;
}

/**
 * The placed ragdoll poses (XRGD: the Creation Kit's settled Havok state) against their joints'
 * limits: the share of joint angles within the limits as Rapier measures a joint's angles (its
 * second body's frame turned from its first's) and mirrored (the convention the files' limits
 * are in: src/physics/physics-world.ts, ANGLES_MIRRORED).
 */
async function auditLimits(): Promise<void> {
  interface Q { x: number; y: number; z: number; w: number }
  const mul = (a: Q, b: Q): Q => ({
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
  });
  const inv = (a: Q): Q => ({ x: -a.x, y: -a.y, z: -a.z, w: a.w });
  const frameOf = (axes: readonly Vec3[]): Q => {
    const [x, y] = [axes[0] ?? [1, 0, 0], axes[1] ?? [0, 1, 0]];
    const z: Vec3 = [
      x[1] * y[2] - x[2] * y[1],
      x[2] * y[0] - x[0] * y[2],
      x[0] * y[1] - x[1] * y[0],
    ];
    return matrixQuaternion(new Float32Array([...x, 0, ...y, 0, ...z, 0, 0, 0, 0, 1]));
  };
  const resolver = new ActorResolver(db);
  const models = new Map<string, { collision: CollisionData; skeleton: ActorSkeleton }>();
  const stats = new Map<string, { within: number; mirrored: number; all: number }>();
  const tally = (key: string, angle: number, min: number, max: number): void => {
    const entry = stats.get(key) ?? { within: 0, mirrored: 0, all: 0 };
    stats.set(key, entry);
    // The settled state may lie a little past a limit (Havok's limits are soft).
    const slack = 0.1;
    entry.all++;
    if (angle >= min - slack && angle <= max + slack) entry.within++;
    if (-angle >= min - slack && -angle <= max + slack) entry.mirrored++;
  };
  let poses = 0;
  for (const formId of db.formIdsOfType('ACHR')) {
    const record = await db.get(formId);
    const data = record && parseRagdollData(record.fields);
    if (!record || !data) continue;
    const path = (await resolver.resolve(record.formIdField('NAME') ?? 0, formId))?.skeleton;
    if (!path || !vfs.has(path)) continue;
    let model = models.get(path);
    if (!model) {
      const file = parseNif(await vfs.read(path));
      model = {
        collision: buildCollision(file),
        skeleton: new ActorSkeleton(buildRig(file), undefined),
      };
      models.set(path, model);
    }
    const pose = new ActorPose(model.skeleton);
    const rest = pose.worlds.slice();
    if (!poseRagdoll(pose, model.collision, data)?.complete) continue;
    poses++;
    for (const constraint of model.collision.constraints ?? []) {
      const d = constraint.data.type === 'malleable' ? constraint.data.inner : constraint.data;
      if (d.type !== 'ragdoll' && d.type !== 'limited-hinge') continue;
      const a = model.collision.bodies[constraint.bodyA];
      const b = model.collision.bodies[constraint.bodyB];
      const ma = a && bodyOnPose(pose, rest, a);
      const mb = b && bodyOnPose(pose, rest, b);
      if (!ma || !mb) continue;
      let r = mul(
        inv(mul(matrixQuaternion(ma), frameOf(d.a.axes))),
        mul(matrixQuaternion(mb), frameOf(d.b.axes)),
      );
      if (r.w < 0) r = { x: -r.x, y: -r.y, z: -r.z, w: -r.w };
      const angle = (v: number): number => 2 * Math.asin(Math.max(-1, Math.min(1, v)));
      if (d.type === 'limited-hinge') {
        tally('limited hinge', angle(r.x), d.minAngle, d.maxAngle);
      } else {
        tally('ragdoll twist', angle(r.x), d.twistMinAngle, d.twistMaxAngle);
        tally('ragdoll plane', angle(r.z), d.planeMinAngle, d.planeMaxAngle);
      }
    }
  }
  console.log(`${String(poses)} complete placed ragdoll poses`);
  for (const [key, { within, mirrored, all }] of stats) {
    console.log(
      `  ${key}: ${String(all)} angles, within the limits as Rapier measures ${(within / all).toFixed(3)}, mirrored ${(mirrored / all).toFixed(3)}`,
    );
  }
}

if (args.includes('--limits')) {
  await auditLimits();
  process.exit(0);
}

const refArg = option('--ref');
if (refArg !== undefined) {
  // One placed dead's ragdoll, in its placed pose (as far as it walks), let go on a floor.
  const formId = Number.parseInt(refArg, 16);
  const record = await db.get(formId);
  const look =
    record && (await new ActorResolver(db).resolve(record.formIdField('NAME') ?? 0, formId));
  const data = record && parseRagdollData(record.fields);
  if (!look?.skeleton || !data) throw new Error('no placed ragdoll pose for ' + refArg);
  const file = parseNif(await vfs.read(look.skeleton));
  const collision = buildCollision(file);
  const skeleton = new ActorSkeleton(buildRig(file), undefined);
  const pose = new ActorPose(skeleton);
  const rest = pose.worlds.slice();
  const posed = poseRagdoll(pose, collision, data);
  console.log(
    look.skeleton,
    'pose',
    posed?.complete ? 'complete' : 'stopped at ' + String(posed?.locals.size),
  );
  const result = drop(collision, (physics, placed, world) => {
    physics.poseBodies(placed, world, ({ data: body }) => bodyOnPose(pose, rest, body));
  });
  console.log(result);
  process.exit(0);
}

if (args.includes('--pose')) {
  await auditPoses();
  process.exit(0);
}

let tested = 0;
let resting = 0;
for (const [path, race] of [...skeletons].sort()) {
  if (filter && !path.includes(filter.toLowerCase())) continue;
  if (!vfs.has(path)) continue;
  const collision = buildCollision(parseNif(await vfs.read(path)));
  if (!collision.bodies.some((body) => body.motion === 'dynamic' && !body.phantom)) continue;
  const result = drop(collision);
  tested++;
  if (result.rest !== undefined) resting++;
  console.log(
    [
      (result.rest === undefined ? 'STIRS' : 'rests').padEnd(6),
      race.padEnd(30),
      `bodies ${String(result.bodies).padStart(2)} joints ${String(result.joints).padStart(2)}`,
      `rest ${result.rest === undefined ? '  -  ' : result.rest.toFixed(1).padStart(5)} s`,
      `top ${result.top.toFixed(0).padStart(5)} u/s`,
      `flips ${result.flips.toFixed(1).padStart(4)}/s`,
      `awake ${String(result.awake).padStart(2)}`,
      `stretch ${result.stretch.toFixed(1).padStart(5)}`,
      `height ${result.height.toFixed(2)}`,
      path,
    ].join('  '),
  );
}
console.log(`${resting} of ${tested} ragdolls come to rest within ${seconds} s`);
