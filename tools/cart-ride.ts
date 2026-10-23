// Drives a cart behind its horse over the real collision of its road (src/ai/cart-tether.ts as
// the shell runs it) and measures the ride: how much the cart bounces against the road's own
// rise and fall, how fast it pitches and rolls, how many wheels touch. The horse walks its
// linked references (the opening's carts patrol them to Helgen) at a walking speed, standing on
// the ground found under it, its spine at rest (no animation) leaning as the ground does.
//
//   node tools/cart-ride.ts                       MQ101's first cart (b9df3, its horse b9df2)
//   node tools/cart-ride.ts bb970 bb971           another cart and its horse (hex)
//   node tools/cart-ride.ts b9df3 b9df2 --seconds 60 --speed 125 --segments

import { CartTether } from '../src/ai/cart-tether.ts';
import {
  easeTowards,
  hitchPlace,
  leaningRoot,
  TETHER_LEAN_EASE,
  type CartSettings,
} from '../src/ai/vehicles.ts';
import { buildRig } from '../src/animation/skeleton.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { HAVOK_SCALE, rigidPart } from '../src/physics/collision-data.ts';
import { Layer } from '../src/physics/collision-layers.ts';
import { PHYSICS_STEP, type PhysicsWorld, type PlacedBody } from '../src/physics/physics-world.ts';
import { multiply, type Mat4, type Vec3 } from '../src/render/math.ts';
import { loadCellData, type CellObject } from '../src/world/cell-loader.ts';
import { linkedReferences, parseReference } from '../src/world/cell-records.ts';
import { INI_DEFAULTS } from '../src/world/ini-settings.ts';
import { CELL_SIZE } from '../src/world/land.ts';
import { Worldspace } from '../src/world/worldspace.ts';
import { PlayWorld } from './play-world.ts';

/** One step of a ride: the cart's root body. */
export interface RideSample {
  readonly position: Vec3;
  /** Vertical speed (units a second). */
  readonly vz: number;
  /** Turn rates about the body's right (pitch) and forward (roll) axes (radians a second). */
  readonly pitch: number;
  readonly roll: number;
  /** The body's up's world z. */
  readonly upZ: number;
  readonly wheels: number;
}

/** What a ride measured (over the steps it moved). */
export interface RideSummary {
  readonly seconds: number;
  readonly speed: number;
  /** Vertical speed against its average over a second (the road's rise and fall taken out). */
  readonly bounceRms: number;
  readonly bounceMax: number;
  readonly pitchRms: number;
  readonly pitchMax: number;
  readonly rollRms: number;
  readonly rollMax: number;
  readonly minUpZ: number;
  /** Wheels off the ground, on average (a rigid cart on uneven ground stands on three). */
  readonly wheelsOff: number;
}

/** The [Cart] settings' built-in values (the INI's). */
export function cartDefaults(): CartSettings {
  const c = INI_DEFAULTS.Cart;
  const n = (key: keyof typeof c): number => c[key];
  return {
    horseOffset: [n('fHorseOffsetX'), n('fHorseOffsetY'), n('fHorseOffsetZ')],
    cartPivot: [n('fCartPivotX'), n('fCartPivotY'), n('fCartPivotZ')],
    horsePivot: [n('fHorsePivotX'), n('fHorsePivotY'), n('fHorsePivotZ')],
    cartRot1: n('fCartRot1'),
    cartRot2: n('fCartRot2'),
    limitMin: n('fCartLimitMin'),
    limitMax: n('fCartLimitMax'),
    mass: n('fMass'),
    wheelFriction: n('fFriction'),
    wheelAngularDamping: n('fWheelAngDamp'),
    wheelGravity: n('fGravMult'),
    tipImpulse: n('fTipImpulse'),
    tetherOffset: [n('fTetherOffsetX'), n('fTetherOffsetY'), n('fTetherOffsetZ')],
    poleZOffset: n('fPoleZOffset'),
  };
}

/** The horse's way: its linked references (without a keyword), one after another. */
async function wayOf(game: PlayWorld, horse: number): Promise<Vec3[]> {
  const points: Vec3[] = [];
  const seen = new Set<number>();
  for (let at = horse; points.length < 512;) {
    const record = await game.db.get(at);
    if (!record) break;
    const next = linkedReferences(record).get(0);
    if (next === undefined || seen.has(next)) break;
    seen.add(next);
    const marker = await game.db.get(next);
    if (!marker) break;
    points.push(parseReference(marker).position);
    at = next;
  }
  return points;
}

/** The ground under a point (the first surface a character stands on), and its normal. */
function groundAt(physics: PhysicsWorld, x: number, y: number, z: number) {
  return physics.raycast([x, y, z + 200], [0, 0, -1], 600, Layer.charController);
}

/** Whether a body touches something (a contact within 0.02 Havok units, 1.4 game units). */
function touches(physics: PhysicsWorld, placed: PlacedBody): boolean {
  const found = { touching: false };
  for (let i = 0; i < placed.body.numColliders(); i++) {
    const collider = placed.body.collider(i);
    physics.world.contactPairsWith(collider, (other) => {
      physics.world.contactPair(collider, other, (manifold) => {
        for (let k = 0; k < manifold.numContacts(); k++) {
          if (manifold.contactDist(k) < 0.02) found.touching = true;
        }
      });
    });
  }
  return found.touching;
}

/** Rides a cart behind its horse along the horse's way; the steps of the ride. */
export async function rideCart(
  game: PlayWorld,
  options: { cart: number; horse: number; speed: number; seconds: number },
): Promise<{ samples: RideSample[]; markers: number }> {
  const settings = cartDefaults();
  const cartRecord = await game.db.require(options.cart);
  const cell = game.db.cellOfReference(options.cart);
  const worldId = cell === undefined ? undefined : game.db.worldOfCell(cell);
  if (worldId === undefined) throw new Error('the cart is not in a worldspace');
  const world = await Worldspace.open(game.db, worldId);
  const way = await wayOf(game, options.horse);
  const placement = parseReference(cartRecord);
  // The cells under the way (and one around each point of it).
  const cells = new Set<string>();
  const cover = (x: number, y: number): void => {
    const cx = Math.floor(x / CELL_SIZE);
    const cy = Math.floor(y / CELL_SIZE);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++) cells.add(`${cx + dx},${cy + dy}`);
  };
  cover(placement.position[0], placement.position[1]);
  for (let i = 0; i < way.length; i++) {
    const a = i === 0 ? placement.position : way[i - 1];
    const b = way[i];
    if (!a || !b) continue;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = 0; d <= length; d += CELL_SIZE / 2) {
      const t = length > 0 ? d / length : 0;
      cover(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
    }
  }
  const physics = game.newPhysics();
  let cartObject: CellObject | undefined;
  // The cart's own cell first: the other carts (of its model) are left out of the others.
  const own = `${String(Math.floor(placement.position[0] / CELL_SIZE))},${String(
    Math.floor(placement.position[1] / CELL_SIZE),
  )}`;
  for (const key of [own, ...[...cells].filter((key) => key !== own)]) {
    const [x = 0, y = 0] = key.split(',').map(Number);
    const id = await world.cell(x, y);
    if (id === undefined) continue;
    const data = await loadCellData(game.db, id, world.persistentReferences(x, y));
    cartObject ??= data.objects.find((object) => object.reference === options.cart);
    const land = await world.land(x, y);
    // Doors (Helgen's gate the opening opens), actors and the carts are left out.
    const objects = data.objects.filter(
      (object) => object.baseType !== 'DOOR' && object.model !== cartObject?.model,
    );
    await game.placeCell(
      physics,
      { ...data, objects },
      await game.enabledIn(data, false),
      land && {
        data: land,
        x,
        y,
      },
    );
  }
  if (!cartObject) throw new Error('the cart is not placed in its cells');
  const collision = await game.collisionOf(cartObject.model);
  if (!collision) throw new Error('the cart has no collision');
  const cart = physics.addObject(
    collision,
    cartObject.world,
    { reference: options.cart, kind: 'object' },
    false,
  );
  physics.keyframe(cart);
  const root = cart.bodies[0];
  if (!root) throw new Error('the cart has no bodies');
  // The horse's spine at rest in its model.
  const rig = buildRig(
    parseNif(await game.vfs.read('meshes\\actors\\horse\\character assets\\skeleton.nif')),
  );
  const node = rig.names.findIndex((name) => name.toLowerCase() === 'horsespine2');
  let spineRest: Mat4 = rig.local.slice(node * 16, node * 16 + 16);
  for (let parent = rig.parents[node] ?? -1; parent >= 0; parent = rig.parents[parent] ?? -1) {
    spineRest = multiply(rig.local.slice(parent * 16, parent * 16 + 16), spineRest);
  }
  physics.step(PHYSICS_STEP);
  // TetherToHorse puts the horse ahead of the cart, turned as it is.
  const hitch = hitchPlace(
    { position: placement.position, rotation: placement.rotation },
    placement.position[2],
    settings,
  );
  let feet: Vec3 = [...hitch.position];
  let heading = placement.rotation[2];
  let lean: Vec3 | undefined;
  const spineAt = (): Mat4 => {
    const ground = groundAt(physics, feet[0], feet[1], feet[2]);
    if (ground) feet = [feet[0], feet[1], ground.point[2]];
    lean = easeTowards(lean, ground ? ground.normal : [0, 0, 1], PHYSICS_STEP, TETHER_LEAN_EASE);
    return rigidPart(multiply(leaningRoot(feet, heading, lean, 1), spineRest));
  };
  const tether = CartTether.tether(physics, cart, root, spineAt(), spineRest, settings);
  if (!tether) throw new Error('the cart has no FrontBar');
  const wheels = cart.bodies.filter((body) => body.data.node.toLowerCase().startsWith('wheel'));
  const samples: RideSample[] = [];
  let target = 0;
  const turnRate = Math.PI / 2;
  for (let step = 0; step < options.seconds / PHYSICS_STEP && target < way.length; step++) {
    // The horse stands for a second, then walks to each point in turn, turning towards it.
    if (step > 60) {
      const point = way[target];
      if (!point) break;
      const dx = point[0] - feet[0];
      const dy = point[1] - feet[1];
      const away = Math.hypot(dx, dy);
      if (away < 32) {
        target++;
        continue;
      }
      const want = Math.atan2(dx, dy);
      let turn = want - heading;
      turn = Math.atan2(Math.sin(turn), Math.cos(turn));
      const most = turnRate * PHYSICS_STEP;
      heading += Math.max(-most, Math.min(most, turn));
      const go = Math.min(away, options.speed * PHYSICS_STEP);
      feet = [feet[0] + Math.sin(heading) * go, feet[1] + Math.cos(heading) * go, feet[2]];
    }
    physics.step(PHYSICS_STEP, () => {
      tether.step(spineAt());
    });
    const body = root.body;
    const { x, y, z, w } = body.rotation();
    const right: Vec3 = [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)];
    const forward: Vec3 = [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)];
    const spin = body.angvel();
    const t = body.translation();
    const touching = wheels.filter((wheel) => touches(physics, wheel)).length;
    samples.push({
      position: [t.x * HAVOK_SCALE, t.y * HAVOK_SCALE, t.z * HAVOK_SCALE],
      vz: body.linvel().z * HAVOK_SCALE,
      pitch: spin.x * right[0] + spin.y * right[1] + spin.z * right[2],
      roll: spin.x * forward[0] + spin.y * forward[1] + spin.z * forward[2],
      upZ: 1 - 2 * (x * x + y * y),
      wheels: touching,
    });
  }
  physics.free();
  return { samples, markers: way.length };
}

/** A ride summed up over the steps the cart moved. */
export function summarize(all: readonly RideSample[]): RideSummary {
  const moving = all.filter((sample, i) => {
    const before = all[i - 1];
    return (
      before !== undefined &&
      Math.hypot(sample.position[0] - before.position[0], sample.position[1] - before.position[1]) /
        PHYSICS_STEP >
        20
    );
  });
  const n = Math.max(1, moving.length);
  const bounce = moving.map((sample, i) => {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - 30); k <= Math.min(moving.length - 1, i + 30); k++) {
      sum += moving[k]?.vz ?? 0;
      count++;
    }
    return sample.vz - sum / count;
  });
  const rms = (values: readonly number[]): number =>
    Math.sqrt(values.reduce((sum, v) => sum + v * v, 0) / n);
  const max = (values: readonly number[]): number => Math.max(0, ...values.map(Math.abs));
  let travelled = 0;
  for (let i = 1; i < moving.length; i++) {
    const a = moving[i - 1]?.position ?? [0, 0, 0];
    const b = moving[i]?.position ?? [0, 0, 0];
    travelled += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  const seconds = moving.length * PHYSICS_STEP;
  return {
    seconds,
    speed: seconds > 0 ? travelled / seconds : 0,
    bounceRms: rms(bounce),
    bounceMax: max(bounce),
    pitchRms: rms(moving.map((s) => s.pitch)),
    pitchMax: max(moving.map((s) => s.pitch)),
    rollRms: rms(moving.map((s) => s.roll)),
    rollMax: max(moving.map((s) => s.roll)),
    minUpZ: Math.min(1, ...moving.map((s) => s.upZ)),
    wheelsOff: moving.reduce((sum, s) => sum + 4 - s.wheels, 0) / n,
  };
}

const show = (summary: RideSummary): string =>
  `${summary.seconds.toFixed(0)} s at ${summary.speed.toFixed(0)} u/s: bounce ${summary.bounceRms.toFixed(1)} u/s ` +
  `(at most ${summary.bounceMax.toFixed(0)}), pitch ${summary.pitchRms.toFixed(3)} rad/s ` +
  `(${summary.pitchMax.toFixed(2)}), roll ${summary.rollRms.toFixed(3)} (${summary.rollMax.toFixed(2)}), ` +
  `up ≥ ${summary.minUpZ.toFixed(3)}, wheels off ${summary.wheelsOff.toFixed(2)}`;

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const refs = args.filter((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'));
  const cart = parseInt(refs[0] ?? 'b9df3', 16);
  const horse = parseInt(refs[1] ?? 'b9df2', 16);
  const game = await PlayWorld.open();
  const { samples, markers } = await rideCart(game, {
    cart,
    horse,
    speed: Number(flag('--speed') ?? 125),
    seconds: Number(flag('--seconds') ?? 600),
  });
  console.log(`cart ${cart.toString(16)} behind ${horse.toString(16)}, ${String(markers)} points`);
  console.log(show(summarize(samples)));
  if (args.includes('--segments')) {
    for (let i = 0; i < samples.length; i += 1200) {
      const part = samples.slice(i, i + 1200);
      const at = part[0]?.position ?? [0, 0, 0];
      console.log(`  ${at.map((v) => Math.round(v)).join(', ')}: ${show(summarize(part))}`);
    }
  }
  await game.db.close();
  await game.vfs.close();
}
