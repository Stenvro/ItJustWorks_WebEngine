// Water's physics: what floats, what sinks, what the current carries off, and the splash of
// what comes into the water (docs/physics.md, "Water"). Platform-independent.
//
// - Buoyancy. A body in water is lifted by the water it displaces, as its material makes it
//   float or sink: (1 + b) × ρ × V × s × g, b the material's buoyancy (MATT BNAM, −1 .. 1: stone
//   and metal −1 never float, wood 0.25, a book 1), V the body's volume, s the share of it under
//   the surface, ρ water's density. A body floats where that lift meets its weight, s = m /
//   ((1 + b) ρ V); one whose lift never does sinks, slowed by the water. Ragdoll bones take the
//   settings' buoyancy instead of their material: fBuoyancyMultBody for the trunk and the head,
//   fBuoyancyMultExtremity for the limbs (a corpse floats, its arms and legs hang).
//   TODO(M13): the engine's own rule (Havok's buoyancy) is not documented; this is ours, from
//   the data's buoyancies and settings.
// - Current. The water drags what is in it towards its own velocity (WATR NAM0, NAM1): a body
//   in a river drifts downstream at the river's speed, the drag also damping its bobbing at
//   the surface. Rivers of a type with Enable Flowmap (RiverWaterFlow, Riverwood's) flow along
//   their cell's flow map instead (src/world/flow-map.ts), at FLOW_SPEED at full strength.
// - Splashes. What comes into the water (a body, an actor) or leaves it fast enough splashes:
//   its speed × fSplashSoundVelocityMult (× fSplashSoundOutMult leaving) against
//   fSplashSoundLight, Medium and Heavy, at most once in fSplashSoundTimer per thing; the
//   splash's model is sSplashParticles at fSplashScale1 (heavy), 2 (medium) or 3 (light); its
//   sound the thing's impact against the water's material (src/audio/impacts.ts).

import type RAPIER from '@dimforge/rapier3d-compat';
import type { WaterHarm } from '../gameplay/water-hazard.ts';
import type { Vec3 } from '../render/math.ts';
import { HAVOK_SCALE } from './collision-data.ts';
import { Layer } from './collision-layers.ts';
import { FLOW_SPEED } from '../world/flow-map.ts';
import type { PhysicsImpact, PhysicsWorld } from './physics-world.ts';

/** Water's density (kg per cubic Havok unit: a Havok unit is a metre). */
export const WATER_DENSITY = 1000;
/**
 * How fast the water takes a body to its own velocity (per second, at full submersion), and its
 * spin to its angular velocity. TODO(M13): Havok's water drag is not documented.
 */
export const WATER_DRAG = 1.5;
export const WATER_ANGULAR_DRAG = 2;
/** A body without a volume (a triangle mesh) is taken as a cube this wide (Havok units). */
const DEFAULT_SIZE = 0.3;

/** What one body in water is and does (Havok units, kg, radians). */
export interface WaterForceInput {
  readonly mass: number;
  /** Cubic Havok units. */
  readonly volume: number;
  /** Its buoyancy (MATT BNAM or the ragdoll settings), −1 .. 1. */
  readonly buoyancy: number;
  /** The share of it under the surface, 0 .. 1. */
  readonly submerged: number;
  readonly velocity: Vec3;
  readonly angularVelocity: Vec3;
  /** The water's velocity and angular velocity (WATR NAM0, NAM1). */
  readonly current: Vec3;
  readonly angularCurrent: Vec3;
  /** Havok units a second² (downwards). */
  readonly gravity: number;
}

/** The water's acceleration of a body: linear (Havok units a second²) and angular. */
export interface WaterAcceleration {
  readonly linear: Vec3;
  readonly angular: Vec3;
}

/** The upward force of the water on a body (newtons, Havok units). */
export function buoyancyForce(
  input: Pick<WaterForceInput, 'volume' | 'buoyancy' | 'submerged' | 'gravity'>,
): number {
  const share = Math.max(0, Math.min(1, input.submerged));
  const lift = Math.max(0, 1 + Math.max(-1, input.buoyancy));
  return lift * WATER_DENSITY * input.volume * share * input.gravity;
}

/**
 * The share of a body under the surface where it floats (lift equals weight), or undefined if
 * it sinks (even wholly under, the water lifts less than it weighs).
 */
export function floatingShare(
  input: Pick<WaterForceInput, 'mass' | 'volume' | 'buoyancy'>,
): number | undefined {
  const full = buoyancyForce({ ...input, submerged: 1, gravity: 1 });
  if (full <= 0 || input.mass >= full) return undefined;
  return input.mass / full;
}

/** How the water accelerates a body: its lift, and the drag towards the water's motion. */
export function waterAcceleration(input: WaterForceInput): WaterAcceleration {
  const share = Math.max(0, Math.min(1, input.submerged));
  if (share <= 0 || input.mass <= 0) return { linear: [0, 0, 0], angular: [0, 0, 0] };
  const lift = buoyancyForce(input) / input.mass;
  const drag = WATER_DRAG * share;
  const spin = WATER_ANGULAR_DRAG * share;
  const [vx, vy, vz] = input.velocity;
  const [cx, cy, cz] = input.current;
  const [wx, wy, wz] = input.angularVelocity;
  const [ax, ay, az] = input.angularCurrent;
  return {
    linear: [drag * (cx - vx), drag * (cy - vy), lift + drag * (cz - vz)],
    angular: [spin * (ax - wx), spin * (ay - wy), spin * (az - wz)],
  };
}

/**
 * The share of a body of `size` (its height, Havok units) centred at height `z` that lies
 * under a surface at `surface`.
 */
export function submergedShare(z: number, size: number, surface: number): number {
  if (size <= 0) return z < surface ? 1 : 0;
  return Math.max(0, Math.min(1, (surface - (z - size / 2)) / size));
}

/** The splash settings (GMST), with the engine's built-in values. */
export interface SplashSettings {
  readonly light: number;
  readonly medium: number;
  readonly heavy: number;
  /** Seconds between one thing's splashes. */
  readonly timer: number;
  readonly velocityMult: number;
  /** Leaving the water splashes this much of entering's. */
  readonly outMult: number;
  /** The splash's model (sSplashParticles) and its scale by size (fSplashScale1..3). */
  readonly model: string;
  readonly scales: readonly [heavy: number, medium: number, light: number];
}

export const SPLASH_DEFAULTS: SplashSettings = {
  light: 5,
  medium: 25,
  heavy: 50,
  timer: 0.25,
  velocityMult: 0.05,
  outMult: 0.5,
  model: 'Effects\\waterSplash.NIF',
  scales: [1, 0.75, 0.4],
};

export type SplashSize = 'light' | 'medium' | 'heavy';

/** How big a splash is of a thing going `speed` game units a second into (or out of) water. */
export function splashSize(
  speed: number,
  leaving: boolean,
  settings: SplashSettings = SPLASH_DEFAULTS,
): SplashSize | undefined {
  const strength = Math.abs(speed) * settings.velocityMult * (leaving ? settings.outMult : 1);
  if (strength >= settings.heavy) return 'heavy';
  if (strength >= settings.medium) return 'medium';
  if (strength >= settings.light) return 'light';
  return undefined;
}

/** A splash: where on the surface (game units), how big, of what and in what water. */
export interface WaterSplash {
  /** The body's handle or the actor's reference (with `actor`). */
  readonly key: number;
  readonly actor: boolean;
  readonly position: Vec3;
  readonly size: SplashSize;
  readonly leaving: boolean;
  /** Game units a second. */
  readonly speed: number;
  /** The thing's material (MATT id; 0 unknown) and the water's type (WATR). */
  readonly material: number;
  readonly waterType: number;
  /** The model and its scale (sSplashParticles, fSplashScale*). */
  readonly model: string;
  readonly scale: number;
}

/** An actor's water at a step: its submersion (0 .. 1), the surface and type (if any). */
export interface ActorWater {
  readonly submersion: number;
  readonly surface: number | undefined;
  readonly type: number | undefined;
}

/** Water at a point (game units): its surface and type. */
export type WaterAt = (
  x: number,
  y: number,
  z: number,
) => { height: number; type: number } | undefined;

/** The rules the water's physics reads (the load order's). */
export interface WaterRules {
  /** A water type's current (WATR NAM0, NAM1), by form id. */
  readonly currents: ReadonlyMap<number, { readonly linear: Vec3; readonly angular: Vec3 }>;
  /** Each material's buoyancy (MATT BNAM) by material id. */
  readonly buoyancy: ReadonlyMap<number, number>;
  /** fBuoyancyMultBody, fBuoyancyMultExtremity. */
  readonly ragdollBody: number;
  readonly ragdollExtremity: number;
  readonly splash: SplashSettings;
  /** The material of the water types with one of their own (WATR TNAM), by form id. */
  readonly waterMaterials: ReadonlyMap<number, number>;
  /** That of the others: the WATER phantoms' (Water). */
  readonly waterMaterial: number;
  /** The water types that harm actors (src/gameplay/water-hazard.ts), by form id. */
  readonly harms: ReadonlyMap<number, WaterHarm>;
  /** The water types whose rivers flow along their cells' flow maps (WATR Enable Flowmap). */
  readonly flowmapTypes: ReadonlySet<number>;
}

export const WATER_RULE_DEFAULTS: WaterRules = {
  harms: new Map(),
  flowmapTypes: new Set(),
  currents: new Map(),
  buoyancy: new Map(),
  waterMaterials: new Map(),
  waterMaterial: 0,
  ragdollBody: 1,
  ragdollExtremity: -0.3,
  splash: SPLASH_DEFAULTS,
};

/** Ragdoll bones of the trunk and the head (the rest are limbs). */
const TRUNK = /spine|pelvis|neck|head|torso|body|chest|root/i;

interface Tracked {
  /** Share under water at the last step. */
  share: number;
  /** When it last splashed (seconds of the water's time). */
  splashed: number;
}

/** A body's water properties, worked out once. */
interface BodyWater {
  readonly volume: number;
  readonly size: number;
  readonly buoyancy: number;
  readonly material: number;
}

/**
 * Water's physics in a world: each physics step (`step`, a step hook before the solver) lifts,
 * drags and carries the simulated bodies in water; splashes of bodies and actors (`actor`)
 * are kept for `drainSplashes`.
 */
export class WaterPhysics {
  readonly #physics: PhysicsWorld;
  readonly #waterAt: WaterAt;
  rules: WaterRules;
  /**
   * The flow of a river cell at a point (game units; a unit direction east, north: its flow
   * map), if known: rivers of a type with Enable Flowmap carry along it at FLOW_SPEED.
   */
  flowAt: ((x: number, y: number) => readonly [number, number] | undefined) | undefined;
  readonly #bodies = new Map<number, Tracked>();
  readonly #actors = new Map<number, Tracked>();
  readonly #props = new Map<number, BodyWater>();
  #splashes: WaterSplash[] = [];
  /** Actors standing in or swimming through the water this step (their wakes: water-ripples.ts). */
  #wakes: { readonly key: number; readonly position: Vec3 }[] = [];
  #time = 0;

  constructor(physics: PhysicsWorld, waterAt: WaterAt, rules: WaterRules = WATER_RULE_DEFAULTS) {
    this.#physics = physics;
    this.#waterAt = waterAt;
    this.rules = rules;
  }

  /** One physics step of `seconds`: the bodies in water. */
  step(seconds: number): void {
    this.#time += seconds;
    const gravity = -this.#physics.world.gravity.z;
    const seen = new Set<number>();
    this.#physics.world.bodies.forEach((body) => {
      if (!body.isDynamic() || body.isSleeping() || !body.isEnabled()) return;
      const handle = body.handle;
      seen.add(handle);
      const com = body.worldCom();
      const x = com.x * HAVOK_SCALE;
      const y = com.y * HAVOK_SCALE;
      const z = com.z * HAVOK_SCALE;
      const water = this.#waterAt(x, y, z);
      const props = this.#bodyWater(body);
      const share =
        water === undefined ? 0 : submergedShare(com.z, props.size, water.height / HAVOK_SCALE);
      let tracked = this.#bodies.get(handle);
      if (!tracked) {
        tracked = { share, splashed: -Infinity };
        this.#bodies.set(handle, tracked);
      }
      const v = body.linvel();
      if (water) {
        this.#splashed(tracked, share, handle, false, [x, y, water.height], v.z * HAVOK_SCALE, {
          material: props.material,
          type: water.type,
        });
      }
      tracked.share = share;
      if (share <= 0 || !water) return;
      const current = this.rules.currents.get(water.type);
      const w = body.angvel();
      const a = waterAcceleration({
        mass: body.mass(),
        volume: props.volume,
        buoyancy: props.buoyancy,
        submerged: share,
        velocity: [v.x, v.y, v.z],
        angularVelocity: [w.x, w.y, w.z],
        current: this.current(water.type, x, y),
        angularCurrent: current?.angular ?? [0, 0, 0],
        gravity,
      });
      body.setLinvel(
        {
          x: v.x + a.linear[0] * seconds,
          y: v.y + a.linear[1] * seconds,
          z: v.z + a.linear[2] * seconds,
        },
        true,
      );
      body.setAngvel(
        {
          x: w.x + a.angular[0] * seconds,
          y: w.y + a.angular[1] * seconds,
          z: w.z + a.angular[2] * seconds,
        },
        true,
      );
    });
    for (const handle of this.#bodies.keys()) {
      if (!seen.has(handle)) {
        this.#bodies.delete(handle);
        this.#props.delete(handle);
      }
    }
  }

  /**
   * An actor's step at the water (the player's, an NPC's): its feet, height and vertical speed
   * (game units); it splashes coming in or going out. Returns its water.
   */
  actor(
    reference: number,
    feet: Vec3,
    height: number,
    verticalSpeed: number,
    material = 0,
  ): ActorWater {
    const water = this.#waterAt(feet[0], feet[1], feet[2]);
    const share =
      water === undefined ? 0 : Math.max(0, Math.min(1, (water.height - feet[2]) / height));
    let tracked = this.#actors.get(reference);
    if (!tracked) {
      tracked = { share, splashed: -Infinity };
      this.#actors.set(reference, tracked);
    }
    if (water) {
      this.#splashed(
        tracked,
        share,
        reference,
        true,
        [feet[0], feet[1], water.height],
        verticalSpeed,
        {
          material,
          type: water.type,
        },
      );
    }
    tracked.share = share;
    // Wading or swimming at the surface: it leaves a wake.
    // (Kept to a frame's worth where nothing drains them: the headless simulation.)
    if (water && share > 0.05 && share < 1 && this.#wakes.length < 256) {
      this.#wakes.push({ key: reference, position: [feet[0], feet[1], water.height] });
    }
    return { submersion: share, surface: water?.height, type: water?.type };
  }

  /** The actors in the water since the last call, at the surface above their feet. */
  drainWakes(): { readonly key: number; readonly position: Vec3 }[] {
    const wakes = this.#wakes;
    this.#wakes = [];
    return wakes;
  }

  /** An actor left the world (its splash state is forgotten). */
  forgetActor(reference: number): void {
    this.#actors.delete(reference);
  }

  /** The water a point is in or over (game units): its surface and type. */
  surface(x: number, y: number, z: number): { height: number; type: number } | undefined {
    return this.#waterAt(x, y, z);
  }

  /** The current at a point of water of a type (Havok units a second). */
  current(type: number, x: number, y: number): Vec3 {
    return this.#flow(type, x, y) ?? this.rules.currents.get(type)?.linear ?? [0, 0, 0];
  }

  /** A flow-mapped river's current at a point (Havok units a second), if it has a flow map. */
  #flow(type: number, x: number, y: number): Vec3 | undefined {
    if (!this.rules.flowmapTypes.has(type)) return undefined;
    const flow = this.flowAt?.(x, y);
    if (!flow) return undefined;
    const speed = FLOW_SPEED / HAVOK_SCALE;
    return [flow[0] * speed, flow[1] * speed, 0];
  }

  /** The material (MATT id) of a water type. */
  waterMaterial(type: number): number {
    return this.rules.waterMaterials.get(type) ?? this.rules.waterMaterial;
  }

  /** The splashes since the last call. */
  drainSplashes(): WaterSplash[] {
    const splashes = this.#splashes;
    this.#splashes = [];
    return splashes;
  }

  #splashed(
    tracked: Tracked,
    share: number,
    key: number,
    actor: boolean,
    position: Vec3,
    verticalSpeed: number,
    what: { material: number; type: number },
  ): void {
    const entering = tracked.share <= 0 && share > 0 && verticalSpeed < 0;
    const leaving = tracked.share > 0 && share <= 0 && verticalSpeed > 0;
    if (!entering && !leaving) return;
    const settings = this.rules.splash;
    if (this.#time - tracked.splashed < settings.timer) return;
    const size = splashSize(verticalSpeed, leaving, settings);
    if (!size) return;
    tracked.splashed = this.#time;
    const scale = settings.scales[size === 'heavy' ? 0 : size === 'medium' ? 1 : 2];
    this.#splashes.push({
      key,
      actor,
      position,
      size,
      leaving,
      speed: Math.abs(verticalSpeed),
      material: what.material,
      waterType: what.type,
      model: settings.model,
      scale,
    });
  }

  /** A body's volume, size, buoyancy and material, read once. */
  #bodyWater(body: RAPIER.RigidBody): BodyWater {
    const known = this.#props.get(body.handle);
    if (known) return known;
    let volume = 0;
    let weighted = 0;
    let material = 0;
    let largest = -1;
    let ragdoll = false;
    let trunk = false;
    for (let i = 0; i < body.numColliders(); i++) {
      const collider = body.collider(i);
      if (collider.isSensor()) continue;
      const v = shapeVolume(collider);
      const id = this.#physics.materialOf(collider);
      const layer = this.#physics.layerOf(collider);
      if (layer === Layer.biped || layer === Layer.bipedNoCc) {
        ragdoll = true;
        trunk ||= TRUNK.test(this.#physics.nodeOf(collider) ?? '');
      }
      volume += v;
      weighted += v * (this.rules.buoyancy.get(id) ?? 0);
      if (v > largest) {
        largest = v;
        material = id;
      }
    }
    const buoyancy = ragdoll
      ? trunk
        ? this.rules.ragdollBody
        : this.rules.ragdollExtremity
      : volume > 0
        ? weighted / volume
        : (this.rules.buoyancy.get(material) ?? 0);
    if (!(volume > 0)) volume = DEFAULT_SIZE ** 3;
    const props = { volume, size: Math.cbrt(volume), buoyancy, material };
    this.#props.set(body.handle, props);
    return props;
  }
}

/**
 * A collider's volume with its convex radius: Havok's shapes are their core grown by it (a
 * log's hull of 0.011 m³ holds 0.025 with its 2.5-unit shell), which Rapier's volume leaves out.
 * The core's volume grows as its bounds do.
 */
function shapeVolume(collider: RAPIER.Collider): number {
  const core = collider.volume();
  const radius = collider.roundRadius();
  if (!(radius > 0)) return core;
  // Shapes without a vertex buffer give none (despite the typing).
  const vertices = collider.vertices() as Float32Array | undefined;
  if (!vertices || vertices.length < 3) return core;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = vertices[i + axis] ?? 0;
      min[axis] = Math.min(min[axis] ?? 0, value);
      max[axis] = Math.max(max[axis] ?? 0, value);
    }
  }
  let box = 1;
  let factor = 1;
  for (let axis = 0; axis < 3; axis++) {
    const extent = (max[axis] ?? 0) - (min[axis] ?? 0);
    box *= extent + 2 * radius;
    factor *= extent > 1e-6 ? (extent + 2 * radius) / extent : Infinity;
  }
  return Math.min(box, core * factor);
}

/** A splash as an impact against the water's material: its sound (src/audio/impacts.ts). */
export function splashImpact(splash: WaterSplash, waterMaterial: number): PhysicsImpact {
  return {
    position: splash.position,
    speed: splash.speed,
    material: splash.material,
    against: waterMaterial,
    againstKind: 'object',
    body: splash.actor ? -1 - splash.key : splash.key,
  };
}
