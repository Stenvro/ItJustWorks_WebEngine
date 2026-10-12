// A NIF particle system as plain data for the simulation (particle-sim.ts) and the renderer:
// its emitters, the modifiers that move, colour, scale and animate the particles, the
// controllers that drive emitters and modifiers over time, and its material.
// Platform-independent and structured-clone friendly (built with the model in the workers).
// Notes: docs/formats/nif.md ("Particles").

import { VertexAttribute } from '../formats/nif/blocks.ts';
import { getBlock, type NifFile } from '../formats/nif/nif.ts';
import type {
  ControllerBlock,
  ControllerSequenceBlock,
  ParticleModifierBlock,
  Ref,
  Vec3,
} from '../formats/nif/types.ts';
import {
  boolSource,
  floatSource,
  idleSequence,
  sequenceTiming,
  timingOf,
  type BoolSource,
  type FloatSource,
  type Timing,
} from './animation.ts';
import { invert } from './frustum.ts';
import { identity, multiply, transformPoint, type Mat4 } from './math.ts';
import type { AlphaState, PartMaterial } from './model-data.ts';
import { fromHalf, skinShape } from './skinning.ts';

/** Emitter controller and modifier parameters that controllers animate. */
export type ParticleParam =
  | 'birthRate'
  | 'emitterActive'
  | 'modifierActive'
  | 'speed'
  | 'radius'
  | 'lifeSpan'
  | 'declination'
  | 'declinationVariation'
  | 'planarAngle'
  | 'planarAngleVariation'
  | 'gravityStrength'
  | 'rotationSpeed'
  | 'rotationSpeedVariation'
  | 'rotationAngle'
  | 'rotationAngleVariation';

/** A controller's value over its time, applied to the modifier named `target`. */
export type ParticleTrack = {
  readonly target: string;
  readonly param: ParticleParam;
  readonly timing: Timing;
} & (
  | { readonly kind: 'float'; readonly source: FloatSource }
  | { readonly kind: 'bool'; readonly source: BoolSource }
);

/** Triangles of a NiPSysMeshEmitter's shape in model space. */
export interface EmitterMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly indices: Uint16Array;
}

export interface ParticleEmitter {
  readonly name: string;
  readonly shape: 'box' | 'cylinder' | 'sphere' | 'mesh';
  /** Object whose frame the emitter volume lies in (box, cylinder, sphere). */
  readonly object: Ref;
  /** Box: width, height, depth; cylinder: radius, height; sphere: radius. */
  readonly size: Vec3;
  readonly speed: number;
  readonly speedVariation: number;
  /** Radians from the emitter's Z axis, and around it from its X axis. */
  readonly declination: number;
  readonly declinationVariation: number;
  readonly planarAngle: number;
  readonly planarAngleVariation: number;
  readonly color: readonly [number, number, number, number];
  readonly radius: number;
  readonly radiusVariation: number;
  readonly lifeSpan: number;
  readonly lifeSpanVariation: number;
  /** NiPSysMeshEmitter: the shapes, where on them particles start and which way they go. */
  readonly meshes: readonly EmitterMesh[];
  /** 0 vertices, 1 face centres, 2 edge centres, 3 face surfaces, 4 edge surfaces. */
  readonly emissionType: number;
  /** 0 along the surface normal, 1 random, 2 along `emissionAxis`. */
  readonly velocityType: number;
  readonly emissionAxis: Vec3;
}

export interface ParticleGravity {
  readonly name: string;
  readonly object: Ref;
  readonly axis: Vec3;
  readonly strength: number;
  readonly decay: number;
  /** 0 planar (along the axis), 1 spherical (towards the gravity object). */
  readonly forceType: number;
  readonly turbulence: number;
  readonly turbulenceScale: number;
  /** The axis is in world space instead of the gravity object's frame. */
  readonly worldAligned: boolean;
}

export interface ParticleDrag {
  readonly name: string;
  readonly object: Ref;
  /** Velocity along this axis (in the drag object's frame) is damped. */
  readonly axis: Vec3;
  /** Fraction of that velocity lost per frame at 30 frames per second. */
  readonly percentage: number;
  readonly range: number;
  readonly rangeFalloff: number;
}

export interface ParticleBomb {
  readonly name: string;
  readonly object: Ref;
  readonly axis: Vec3;
  readonly decay: number;
  /** Velocity change per second at the bomb. */
  readonly deltaV: number;
  /** 0 none, 1 linear, 2 exponential. */
  readonly decayType: number;
  /** 0 spherical, 1 cylindrical, 2 planar. */
  readonly symmetryType: number;
}

export interface ParticleCollider {
  readonly name: string;
  readonly shape: 'plane' | 'sphere';
  readonly object: Ref;
  readonly bounce: number;
  readonly dieOnCollide: boolean;
  readonly spawnOnCollide: boolean;
  /** Plane: size along its X and Y axes (in the collider object's frame). */
  readonly width: number;
  readonly height: number;
  readonly xAxis: Vec3;
  readonly yAxis: Vec3;
  /** Sphere. */
  readonly radius: number;
}

export interface ParticleColor {
  readonly name: string;
  /** Fractions of the particle's life: alpha fades in until `fadeIn`, out from `fadeOut`. */
  readonly fadeIn: number;
  readonly fadeOut: number;
  /** Colour 1 until `color1End`, blends to colour 2 by `color1Start` ... (see the sim). */
  readonly color1End: number;
  readonly color1Start: number;
  readonly color2End: number;
  readonly color2Start: number;
  /** Three RGBA colours. */
  readonly colors: readonly number[];
}

export interface ParticleSubTexture {
  readonly name: string;
  readonly startFrame: number;
  readonly startFrameFudge: number;
  readonly endFrame: number;
  readonly loopStartFrame: number;
  readonly loopStartFrameFudge: number;
  /** Frames shown over the particle's life. */
  readonly frameCount: number;
  readonly frameCountFudge: number;
}

export interface ParticleSpawn {
  readonly name: string;
  readonly generations: number;
  readonly percentage: number;
  readonly minCount: number;
  readonly maxCount: number;
  readonly speedVariation: number;
  readonly directionVariation: number;
  readonly lifeSpan: number;
  readonly lifeSpanVariation: number;
}

export interface ParticleModifiers {
  readonly spawnOnDeath: boolean;
  readonly spawn: ParticleSpawn | undefined;
  readonly gravity: readonly ParticleGravity[];
  readonly drag: readonly ParticleDrag[];
  readonly bombs: readonly ParticleBomb[];
  readonly colliders: readonly ParticleCollider[];
  readonly rotation:
    | {
        readonly name: string;
        readonly speed: number;
        readonly speedVariation: number;
        readonly angle: number;
        readonly angleVariation: number;
        readonly randomSign: boolean;
      }
    | undefined;
  readonly color: ParticleColor | undefined;
  /** BSPSysScaleModifier: size over the particle's life (evenly spaced keys). */
  readonly scales: readonly number[] | undefined;
  readonly subTexture: ParticleSubTexture | undefined;
  /** BSPSysRecycleBoundModifier: particles leaving the box re-enter on the other side. */
  readonly recycleBound:
    { readonly object: Ref; readonly offset: Vec3; readonly extent: Vec3 } | undefined;
  readonly inheritVelocity:
    | {
        readonly object: Ref;
        readonly chance: number;
        readonly multiplier: number;
        readonly variation: number;
      }
    | undefined;
  /** BSWindModifier strength (0: the wind does not move the particles). */
  readonly wind: number;
  /** BSPSysLODModifier: fewer and larger particles with distance (world units). */
  readonly lod:
    | {
        readonly begin: number;
        readonly end: number;
        readonly endEmitScale: number;
        readonly endSize: number;
      }
    | undefined;
  /** Names of the modifiers that start inactive (NiPSysModifier.active false). */
  readonly inactive: readonly string[];
}

export interface ParticleSystemData {
  readonly name: string;
  /** The NiParticleSystem block (animation target for visibility and transforms). */
  readonly block: Ref;
  /** Particles stay where they were emitted when the system moves. */
  readonly worldSpace: boolean;
  readonly maxParticles: number;
  /** Atlas frames: u, v, width, height. */
  readonly subtextures: readonly (readonly [number, number, number, number])[];
  /** Height/width of the quads, and whether quads stretch along their velocity. */
  readonly aspectRatio: number;
  readonly velocityOriented: boolean;
  readonly material: PartMaterial | undefined;
  readonly alpha: AlphaState | undefined;
  readonly shader: Ref;
  readonly alphaProperty: Ref;
  /** BSStripParticleSystem: each particle draws the ribbon of its recent positions. */
  readonly strip:
    | {
        readonly maxPoints: number;
        readonly startCapSize: number;
        readonly endCapSize: number;
        /** Seconds between recorded points. */
        readonly updateDelta: number;
      }
    | undefined;
  readonly emitters: readonly ParticleEmitter[];
  readonly modifiers: ParticleModifiers;
  readonly tracks: readonly ParticleTrack[];
  /** Model-space matrices (rest pose) of the system and the objects its modifiers use. */
  readonly objects: ReadonlyMap<Ref, Mat4>;
  /**
   * Those objects below a NiBillboardNode: the node's mode and rest matrix, and the object
   * relative to it (they turn with the node every frame, e.g. torch flames stay upright).
   */
  readonly billboards: ReadonlyMap<Ref, ParticleBillboard>;
}

export interface ParticleBillboard {
  readonly mode: number;
  readonly node: Mat4;
  readonly local: Mat4;
}

/** NIF stores unset floats as ±FLT_MAX. */
const UNSET = 3.0e38;
const MANAGER_CONTROLLED = 0x20;
/** AspectFlags: quads turn along their velocity; the aspect ratio applies. */
const ASPECT_VELOCITY_ORIENTATION = 0x1;
const ASPECT_RATIO = 0x100;
/**
 * BSPSysLODModifier distances are stored scaled down: vanilla values are multiples of 1/60
 * (0.0333, 0.1, 0.1667, 0.2333, ...), i.e. steps of 500 units at this scale.
 */
export const PARTICLE_LOD_DISTANCE_SCALE = 30000;

const num = (block: ParticleModifierBlock, name: string, fallback = 0): number => {
  const value = block.values[name];
  return typeof value === 'number' && Math.abs(value) < UNSET ? value : fallback;
};
const ref = (block: ParticleModifierBlock, name: string): Ref => {
  const value = block.values[name];
  return typeof value === 'number' ? value : -1;
};
const vec = (block: ParticleModifierBlock, name: string, fallback: Vec3): Vec3 => {
  const value = block.values[name];
  return Array.isArray(value) && value.length === 3
    ? [Number(value[0]), Number(value[1]), Number(value[2])]
    : fallback;
};
const flag = (block: ParticleModifierBlock, name: string): boolean => block.values[name] === true;
const list = (block: ParticleModifierBlock, name: string): number[] => {
  const value = block.values[name];
  return Array.isArray(value) ? value.map(Number) : [];
};

/** Controller type → the parameter its interpolator drives (emitters: see below). */
const FLOAT_CONTROLLERS: Readonly<Record<string, ParticleParam>> = {
  NiPSysEmitterSpeedCtlr: 'speed',
  NiPSysEmitterInitialRadiusCtlr: 'radius',
  NiPSysEmitterLifeSpanCtlr: 'lifeSpan',
  NiPSysEmitterDeclinationCtlr: 'declination',
  NiPSysEmitterDeclinationVarCtlr: 'declinationVariation',
  NiPSysEmitterPlanarAngleCtlr: 'planarAngle',
  NiPSysEmitterPlanarAngleVarCtlr: 'planarAngleVariation',
  NiPSysGravityStrengthCtlr: 'gravityStrength',
  NiPSysInitialRotSpeedCtlr: 'rotationSpeed',
  NiPSysInitialRotSpeedVarCtlr: 'rotationSpeedVariation',
  NiPSysInitialRotAngleCtlr: 'rotationAngle',
  NiPSysInitialRotAngleVarCtlr: 'rotationAngleVariation',
};
const EMITTER_CONTROLLERS = new Set(['NiPSysEmitterCtlr', 'BSPSysMultiTargetEmitterCtlr']);

function floatTrack(
  file: NifFile,
  target: string,
  param: ParticleParam,
  interpolator: Ref,
  timing: Timing,
): ParticleTrack | undefined {
  const source = floatSource(file, interpolator);
  return source && { kind: 'float', target, param, timing, source };
}

function boolTrack(
  file: NifFile,
  target: string,
  param: ParticleParam,
  interpolator: Ref,
  timing: Timing,
): ParticleTrack | undefined {
  const source = boolSource(file, interpolator);
  return source && { kind: 'bool', target, param, timing, source };
}

/**
 * Tracks of a particle system's controllers. Controllers a manager drives take their
 * interpolators from the model's idle sequence (none: they stay at rest, e.g. impact
 * effects waiting for their trigger); the others play on their own from when the object is
 * loaded, as the engine starts every controller of a newly attached effect.
 */
function particleTracks(
  file: NifFile,
  first: Ref,
  idle: ControllerSequenceBlock | undefined,
): ParticleTrack[] {
  const tracks: ParticleTrack[] = [];
  const push = (track: ParticleTrack | undefined): void => {
    if (track) tracks.push(track);
  };
  for (let at = first, guard = 0; at >= 0 && guard < 64; guard++) {
    const controller = file.blocks[at];
    if (controller?.kind !== 'controller') break;
    const ctlr: ControllerBlock = controller;
    const emitter = EMITTER_CONTROLLERS.has(ctlr.type);
    const param = FLOAT_CONTROLLERS[ctlr.type];
    if ((ctlr.flags & MANAGER_CONTROLLED) !== 0) {
      const timing = idle && sequenceTiming(idle);
      for (const block of idle?.blocks ?? []) {
        if (block.controller !== at || !timing) continue;
        if (emitter && block.interpolatorId === 'EmitterActive') {
          push(boolTrack(file, ctlr.name, 'emitterActive', block.interpolator, timing));
        } else if (emitter) {
          push(floatTrack(file, ctlr.name, 'birthRate', block.interpolator, timing));
        } else if (ctlr.type === 'NiPSysModifierActiveCtlr') {
          push(boolTrack(file, ctlr.name, 'modifierActive', block.interpolator, timing));
        } else if (param) {
          push(floatTrack(file, ctlr.name, param, block.interpolator, timing));
        }
      }
    } else {
      const timing = timingOf(ctlr);
      if (emitter) {
        push(floatTrack(file, ctlr.name, 'birthRate', ctlr.interpolator, timing));
        push(boolTrack(file, ctlr.name, 'emitterActive', ctlr.visibilityInterpolator, timing));
      } else if (ctlr.type === 'NiPSysModifierActiveCtlr') {
        push(boolTrack(file, ctlr.name, 'modifierActive', ctlr.interpolator, timing));
      } else if (param) {
        push(floatTrack(file, ctlr.name, param, ctlr.interpolator, timing));
      }
    }
    at = ctlr.next;
  }
  return tracks;
}

/** Triangles of an emitter shape in model space (static, or skinned in its rest pose). */
function emitterMesh(
  file: NifFile,
  shapeRef: Ref,
  worlds: ReadonlyMap<Ref, Mat4>,
): EmitterMesh | undefined {
  const shape = getBlock(file, shapeRef, 'tri-shape');
  if (!shape) return undefined;
  let desc = shape.vertexDesc;
  let data = shape.vertexData;
  let count = shape.vertexCount;
  let indices = shape.triangles;
  let world = worlds.get(shapeRef) ?? identity();
  if (data.length === 0) {
    const skinned = shape.skin >= 0 ? skinShape(file, shape, worlds) : undefined;
    if (!skinned) return undefined;
    ({ desc, vertices: data, vertexCount: count, indices } = skinned);
    world = identity();
  }
  if (count === 0 || indices.length === 0 || desc.stride === 0) return undefined;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const full = (desc.attributes & VertexAttribute.fullPrecision) !== 0;
  const hasNormal = (desc.attributes & VertexAttribute.normal) !== 0;
  const positions = new Float32Array(count * 3);
  const normals = new Float32Array(count * 3);
  for (let v = 0; v < count; v++) {
    const base = v * desc.stride;
    const local: Vec3 = full
      ? [
          view.getFloat32(base, true),
          view.getFloat32(base + 4, true),
          view.getFloat32(base + 8, true),
        ]
      : [
          fromHalf(view.getUint16(base, true)),
          fromHalf(view.getUint16(base + 2, true)),
          fromHalf(view.getUint16(base + 4, true)),
        ];
    positions.set(transformPoint(world, local), v * 3);
    const unorm = (k: number): number =>
      (view.getUint8(base + desc.normalOffset + k) / 255) * 2 - 1;
    const n: Vec3 = hasNormal ? [unorm(0), unorm(1), unorm(2)] : [0, 0, 1];
    const rx = (world[0] ?? 0) * n[0] + (world[4] ?? 0) * n[1] + (world[8] ?? 0) * n[2];
    const ry = (world[1] ?? 0) * n[0] + (world[5] ?? 0) * n[1] + (world[9] ?? 0) * n[2];
    const rz = (world[2] ?? 0) * n[0] + (world[6] ?? 0) * n[1] + (world[10] ?? 0) * n[2];
    const length = Math.hypot(rx, ry, rz) || 1;
    normals.set([rx / length, ry / length, rz / length], v * 3);
  }
  return { positions, normals, indices };
}

/**
 * The particle system of a NIF block, or undefined if it has no emitter. `worlds` holds the
 * model-space matrix of every object (see buildModel); `material` and `alpha` are the
 * system's shader and alpha properties as model-data reads them.
 */
export function buildParticleSystem(
  file: NifFile,
  systemRef: Ref,
  worlds: ReadonlyMap<Ref, Mat4>,
  material: PartMaterial | undefined,
  alpha: AlphaState | undefined,
): ParticleSystemData | undefined {
  const system = file.blocks[systemRef];
  if (system?.kind !== 'particle-system') return undefined;
  const data = file.blocks[system.data];
  if (data?.kind !== 'particle-data') return undefined;

  const objects = new Map<Ref, Mat4>();
  const object = (target: Ref): Ref => {
    const world = worlds.get(target);
    if (world) objects.set(target, world);
    return world ? target : -1;
  };
  object(systemRef);

  const emitters: ParticleEmitter[] = [];
  const gravity: ParticleGravity[] = [];
  const drag: ParticleDrag[] = [];
  const bombs: ParticleBomb[] = [];
  const colliders: ParticleCollider[] = [];
  const inactive: string[] = [];
  let spawnOnDeath = false;
  let spawnRef: Ref = -1;
  let rotation: ParticleModifiers['rotation'];
  let color: ParticleColor | undefined;
  let scales: number[] | undefined;
  let subTexture: ParticleSubTexture | undefined;
  let recycleBound: ParticleModifiers['recycleBound'];
  let inheritVelocity: ParticleModifiers['inheritVelocity'];
  let wind = 0;
  let lod: ParticleModifiers['lod'];
  let stripDelta = 1 / 30;

  const modifiers = system.modifiers
    .map((m) => file.blocks[m])
    .filter((m): m is ParticleModifierBlock => m?.kind === 'particle-modifier');
  for (const modifier of modifiers) {
    if (!modifier.active) inactive.push(modifier.name);
    const name = modifier.name;
    switch (modifier.type) {
      case 'NiPSysBoxEmitter':
      case 'NiPSysCylinderEmitter':
      case 'NiPSysSphereEmitter':
      case 'NiPSysMeshEmitter': {
        const shape =
          modifier.type === 'NiPSysBoxEmitter'
            ? 'box'
            : modifier.type === 'NiPSysCylinderEmitter'
              ? 'cylinder'
              : modifier.type === 'NiPSysSphereEmitter'
                ? 'sphere'
                : 'mesh';
        const meshes =
          shape === 'mesh'
            ? list(modifier, 'meshes')
                .map((mesh) => emitterMesh(file, mesh, worlds))
                .filter((mesh): mesh is EmitterMesh => mesh !== undefined)
            : [];
        if (shape === 'mesh' && meshes.length === 0) break;
        const c = list(modifier, 'initialColor');
        emitters.push({
          name,
          shape,
          object: shape === 'mesh' ? -1 : object(ref(modifier, 'emitterObject')),
          size:
            shape === 'box'
              ? [num(modifier, 'width'), num(modifier, 'height'), num(modifier, 'depth')]
              : shape === 'cylinder'
                ? [num(modifier, 'radius'), num(modifier, 'height'), 0]
                : [num(modifier, 'radius'), 0, 0],
          speed: num(modifier, 'speed'),
          speedVariation: num(modifier, 'speedVariation'),
          declination: num(modifier, 'declination'),
          declinationVariation: num(modifier, 'declinationVariation'),
          planarAngle: num(modifier, 'planarAngle'),
          planarAngleVariation: num(modifier, 'planarAngleVariation'),
          color: [c[0] ?? 1, c[1] ?? 1, c[2] ?? 1, c[3] ?? 1],
          radius: num(modifier, 'initialRadius', 1),
          radiusVariation: num(modifier, 'radiusVariation'),
          lifeSpan: num(modifier, 'lifeSpan', 1),
          lifeSpanVariation: num(modifier, 'lifeSpanVariation'),
          meshes,
          emissionType: num(modifier, 'emissionType'),
          velocityType: num(modifier, 'initialVelocityType'),
          emissionAxis: vec(modifier, 'emissionAxis', [0, 0, 1]),
        });
        break;
      }
      case 'NiPSysAgeDeathModifier':
        spawnOnDeath = flag(modifier, 'spawnOnDeath');
        if (spawnOnDeath) spawnRef = ref(modifier, 'spawnModifier');
        break;
      case 'NiPSysGravityModifier':
        gravity.push({
          name,
          object: object(ref(modifier, 'gravityObject')),
          axis: vec(modifier, 'axis', [0, 0, 1]),
          strength: num(modifier, 'strength'),
          decay: num(modifier, 'decay'),
          forceType: num(modifier, 'forceType'),
          turbulence: num(modifier, 'turbulence'),
          turbulenceScale: num(modifier, 'turbulenceScale', 1),
          worldAligned: flag(modifier, 'worldAligned'),
        });
        break;
      case 'NiPSysDragModifier':
        drag.push({
          name,
          object: object(ref(modifier, 'dragObject')),
          axis: vec(modifier, 'axis', [0, 0, 1]),
          percentage: num(modifier, 'percentage'),
          range: num(modifier, 'range', Infinity),
          rangeFalloff: num(modifier, 'rangeFalloff', Infinity),
        });
        break;
      case 'NiPSysBombModifier':
        bombs.push({
          name,
          object: object(ref(modifier, 'bombObject')),
          axis: vec(modifier, 'axis', [0, 0, 1]),
          decay: num(modifier, 'decay'),
          deltaV: num(modifier, 'deltaV'),
          decayType: num(modifier, 'decayType'),
          symmetryType: num(modifier, 'symmetryType'),
        });
        break;
      case 'NiPSysRotationModifier':
        rotation = {
          name,
          speed: num(modifier, 'speed'),
          speedVariation: num(modifier, 'speedVariation'),
          angle: num(modifier, 'angle'),
          angleVariation: num(modifier, 'angleVariation'),
          randomSign: flag(modifier, 'randomSign'),
        };
        break;
      case 'NiPSysColliderManager':
        for (let at = ref(modifier, 'collider'), guard = 0; at >= 0 && guard < 16; guard++) {
          const collider = file.blocks[at];
          if (collider?.kind !== 'particle-modifier') break;
          const spawns = flag(collider, 'spawnOnCollide');
          colliders.push({
            name,
            shape: collider.type === 'NiPSysPlanarCollider' ? 'plane' : 'sphere',
            object: object(ref(collider, 'colliderObject')),
            bounce: num(collider, 'bounce'),
            dieOnCollide: flag(collider, 'dieOnCollide'),
            spawnOnCollide: spawns,
            width: num(collider, 'width'),
            height: num(collider, 'height'),
            xAxis: vec(collider, 'xAxis', [1, 0, 0]),
            yAxis: vec(collider, 'yAxis', [0, 1, 0]),
            radius: num(collider, 'radius'),
          });
          if (spawns) spawnRef = ref(collider, 'spawnModifier');
          at = ref(collider, 'nextCollider');
        }
        break;
      case 'BSPSysSimpleColorModifier':
        color = {
          name,
          fadeIn: num(modifier, 'fadeIn'),
          fadeOut: num(modifier, 'fadeOut', 1),
          color1End: num(modifier, 'color1End'),
          color1Start: num(modifier, 'color1Start'),
          color2End: num(modifier, 'color2End'),
          color2Start: num(modifier, 'color2Start'),
          colors: list(modifier, 'colors'),
        };
        break;
      case 'BSPSysScaleModifier': {
        const values = list(modifier, 'scales');
        if (values.length > 0) scales = values;
        break;
      }
      case 'BSPSysSubTexModifier':
        subTexture = {
          name,
          startFrame: num(modifier, 'startFrame'),
          startFrameFudge: num(modifier, 'startFrameFudge'),
          endFrame: num(modifier, 'endFrame'),
          loopStartFrame: num(modifier, 'loopStartFrame'),
          loopStartFrameFudge: num(modifier, 'loopStartFrameFudge'),
          frameCount: num(modifier, 'frameCount'),
          frameCountFudge: num(modifier, 'frameCountFudge'),
        };
        break;
      case 'BSPSysRecycleBoundModifier':
        recycleBound = {
          object: object(ref(modifier, 'boundObject')),
          offset: vec(modifier, 'boundOffset', [0, 0, 0]),
          extent: vec(modifier, 'boundExtent', [0, 0, 0]),
        };
        break;
      case 'BSPSysInheritVelocityModifier':
        inheritVelocity = {
          object: object(ref(modifier, 'inheritObject')),
          chance: num(modifier, 'chance'),
          multiplier: num(modifier, 'multiplier', 1),
          variation: num(modifier, 'variation'),
        };
        break;
      case 'BSWindModifier':
        wind = num(modifier, 'strength');
        break;
      case 'BSPSysLODModifier':
        lod = {
          begin: num(modifier, 'beginDistance') * PARTICLE_LOD_DISTANCE_SCALE,
          end: num(modifier, 'endDistance') * PARTICLE_LOD_DISTANCE_SCALE,
          endEmitScale: num(modifier, 'endEmitScale', 1),
          endSize: num(modifier, 'endSize', 1),
        };
        break;
      case 'BSPSysStripUpdateModifier':
        stripDelta = Math.max(1 / 120, num(modifier, 'updateDeltaTime', 1 / 30));
        break;
      default:
        // Spawn (read through the references above), position and bound updates: part of
        // every update step.
        break;
    }
  }
  if (emitters.length === 0) return undefined;

  let spawn: ParticleSpawn | undefined;
  const spawnBlock = file.blocks[spawnRef];
  if (spawnBlock?.kind === 'particle-modifier' && spawnBlock.type === 'NiPSysSpawnModifier') {
    spawn = {
      name: spawnBlock.name,
      generations: num(spawnBlock, 'generations'),
      percentage: num(spawnBlock, 'percentageSpawned', 1),
      minCount: num(spawnBlock, 'minToSpawn', 1),
      maxCount: num(spawnBlock, 'maxToSpawn', 1),
      speedVariation: num(spawnBlock, 'speedVariation'),
      directionVariation: num(spawnBlock, 'directionVariation'),
      lifeSpan: num(spawnBlock, 'lifeSpan', 1),
      lifeSpanVariation: num(spawnBlock, 'lifeSpanVariation'),
    };
  }

  // The idle sequence of the model's controller manager, if any.
  const manager = file.blocks.find((block) => block.kind === 'controller-manager');
  const idle =
    manager?.kind === 'controller-manager' ? idleSequence(file, manager.sequences) : undefined;

  // Objects below billboard nodes turn with them.
  const parents = new Map<Ref, Ref>();
  file.blocks.forEach((block, ref) => {
    if (block.kind === 'node') for (const child of block.children) parents.set(child, ref);
  });
  const billboards = new Map<Ref, ParticleBillboard>();
  for (const [ref, world] of objects) {
    for (let at = parents.get(ref), guard = 0; at !== undefined && guard < 64; guard++) {
      const node = file.blocks[at];
      const nodeWorld = worlds.get(at);
      if (node?.kind === 'node' && node.billboardMode !== undefined && nodeWorld) {
        const inverse = invert(nodeWorld);
        if (inverse) {
          billboards.set(ref, {
            mode: node.billboardMode,
            node: nodeWorld,
            local: multiply(inverse, world),
          });
        }
        break;
      }
      at = parents.get(at);
    }
  }

  return {
    name: system.name,
    block: systemRef,
    worldSpace: system.worldSpace,
    maxParticles: Math.max(1, data.maxParticles),
    // Stored as u, width, v, height.
    subtextures: data.subtextureOffsets.map(([u, width, v, height]) => [u, v, width, height]),
    aspectRatio:
      (data.aspectFlags & ASPECT_RATIO) !== 0 && data.aspectRatio > 0 ? data.aspectRatio : 1,
    velocityOriented: (data.aspectFlags & ASPECT_VELOCITY_ORIENTATION) !== 0,
    material,
    alpha,
    shader: system.shaderProperty,
    alphaProperty: system.alphaProperty,
    strip: data.strip && {
      maxPoints: Math.max(2, data.strip.maxPointCount),
      startCapSize: data.strip.startCapSize,
      endCapSize: data.strip.endCapSize,
      updateDelta: stripDelta,
    },
    emitters,
    modifiers: {
      spawnOnDeath,
      spawn,
      gravity,
      drag,
      bombs,
      colliders,
      rotation,
      color,
      scales,
      subTexture,
      recycleBound,
      inheritVelocity,
      wind,
      lod,
      inactive,
    },
    tracks: particleTracks(file, system.controller, idle),
    objects,
    billboards,
  };
}
