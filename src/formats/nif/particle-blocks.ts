// Parsers for particle systems (NiParticleSystem and Bethesda's variants), their data,
// emitters, modifiers and colliders. Field order follows nif.xml for 20.2.0.7 / BS version
// 100 ("BS202": per-particle arrays are not stored). Notes: docs/formats/nif.md ("Particles").

import { FormatError, type BinaryReader } from '../binary-reader.ts';
import {
  decodeVertexDesc,
  readAvObject,
  readBool,
  readCount,
  readRefs,
  readStringRef,
  readVec3,
  type BlockParser,
} from './blocks.ts';
import type {
  ParticleDataBlock,
  ParticleModifierBlock,
  ParticleSystemBlock,
  Ref,
  Vec3,
} from './types.ts';

const readColor4 = (reader: BinaryReader): [number, number, number, number] => [
  reader.f32(),
  reader.f32(),
  reader.f32(),
  reader.f32(),
];

const parseParticleSystem: BlockParser = (reader, context, type): ParticleSystemBlock => {
  const base = readAvObject(reader, context);
  const boundCenter = readVec3(reader);
  const boundRadius = reader.f32();
  reader.i32(); // skin
  const shaderProperty = reader.i32();
  const alphaProperty = reader.i32();
  const vertexDesc = decodeVertexDesc(reader.u32(), reader.u32());
  reader.skip(8); // far begin/end, near begin/end
  const data = reader.i32();
  const worldSpace = readBool(reader);
  const modifiers = readRefs(reader);
  return {
    ...base,
    kind: 'particle-system',
    type,
    boundCenter,
    boundRadius,
    shaderProperty,
    alphaProperty,
    vertexDesc,
    data,
    worldSpace,
    modifiers,
  };
};

const parseParticleData: BlockParser = (reader, _context, type): ParticleDataBlock => {
  // NiGeometryData (BS202): the has-flags are written, the arrays are not.
  reader.i32(); // group id
  const maxParticles = reader.u16();
  reader.u8(); // keep flags
  reader.u8(); // compress flags
  reader.u8(); // has vertices
  reader.u16(); // BS data flags
  reader.u32(); // material CRC
  reader.u8(); // has normals
  reader.skip(16); // bounding sphere
  reader.u8(); // has vertex colours
  reader.u16(); // consistency flags
  reader.i32(); // additional data
  // NiParticlesData.
  reader.u8(); // has radii
  reader.u16(); // num active
  reader.u8(); // has sizes
  reader.u8(); // has rotations
  reader.u8(); // has rotation angles
  reader.u8(); // has rotation axes
  reader.u8(); // has texture indices
  const offsetCount = readCount(reader, 16);
  const subtextureOffsets = Array.from(
    { length: offsetCount },
    (): readonly [number, number, number, number] => readColor4(reader),
  );
  const aspectRatio = reader.f32();
  const aspectFlags = reader.u16();
  reader.f32(); // speed to aspect: aspect 2
  reader.f32(); // speed to aspect: speed 1
  reader.f32(); // speed to aspect: speed 2
  // NiPSysData.
  reader.u8(); // has rotation speeds
  let strip: ParticleDataBlock['strip'];
  if (type === 'BSStripPSysData') {
    strip = {
      maxPointCount: reader.u16(),
      startCapSize: reader.f32(),
      endCapSize: reader.f32(),
      zPrepass: readBool(reader),
    };
  }
  return {
    kind: 'particle-data',
    maxParticles,
    subtextureOffsets,
    aspectRatio,
    aspectFlags,
    ...(strip && { strip }),
  };
};

/** NiPSysModifier: name, order, target, active. */
function readModifierBase(
  reader: BinaryReader,
  context: Parameters<BlockParser>[1],
): { name: string; order: number; target: Ref; active: boolean } {
  return {
    name: readStringRef(reader, context),
    order: reader.u32(),
    target: reader.i32(),
    active: readBool(reader),
  };
}

const parseModifier: BlockParser = (reader, context, type): ParticleModifierBlock => {
  const base = readModifierBase(reader, context);
  const values: Record<string, number | boolean | Vec3 | readonly number[]> = {};
  const f = (name: string): void => {
    values[name] = reader.f32();
  };
  const ref = (name: string): void => {
    values[name] = reader.i32();
  };
  const vec = (name: string): void => {
    values[name] = readVec3(reader);
  };
  const bool = (name: string): void => {
    values[name] = readBool(reader);
  };
  const u16 = (name: string): void => {
    values[name] = reader.u16();
  };
  const u32 = (name: string): void => {
    values[name] = reader.u32();
  };
  const emitter = (): void => {
    for (const name of [
      'speed',
      'speedVariation',
      'declination',
      'declinationVariation',
      'planarAngle',
      'planarAngleVariation',
    ])
      f(name);
    values.initialColor = readColor4(reader);
    for (const name of ['initialRadius', 'radiusVariation', 'lifeSpan', 'lifeSpanVariation'])
      f(name);
  };
  switch (type) {
    case 'NiPSysBoxEmitter':
      emitter();
      ref('emitterObject');
      f('width');
      f('height');
      f('depth');
      break;
    case 'NiPSysCylinderEmitter':
      emitter();
      ref('emitterObject');
      f('radius');
      f('height');
      break;
    case 'NiPSysSphereEmitter':
      emitter();
      ref('emitterObject');
      f('radius');
      break;
    case 'NiPSysMeshEmitter': {
      emitter();
      values.meshes = readRefs(reader);
      u32('initialVelocityType');
      u32('emissionType');
      vec('emissionAxis');
      break;
    }
    case 'NiPSysAgeDeathModifier':
      bool('spawnOnDeath');
      ref('spawnModifier');
      break;
    case 'NiPSysSpawnModifier':
      u16('generations');
      f('percentageSpawned');
      u16('minToSpawn');
      u16('maxToSpawn');
      f('speedVariation');
      f('directionVariation');
      f('lifeSpan');
      f('lifeSpanVariation');
      break;
    case 'NiPSysPositionModifier':
      break;
    case 'NiPSysBoundUpdateModifier':
      u16('updateSkip');
      break;
    case 'NiPSysGravityModifier':
      ref('gravityObject');
      vec('axis');
      f('decay');
      f('strength');
      u32('forceType');
      f('turbulence');
      f('turbulenceScale');
      bool('worldAligned');
      break;
    case 'NiPSysRotationModifier':
      f('speed');
      f('speedVariation');
      f('angle');
      f('angleVariation');
      bool('randomSign');
      bool('randomAxis');
      vec('axis');
      break;
    case 'NiPSysDragModifier':
      ref('dragObject');
      vec('axis');
      f('percentage');
      f('range');
      f('rangeFalloff');
      break;
    case 'NiPSysBombModifier':
      ref('bombObject');
      vec('axis');
      f('decay');
      f('deltaV');
      u32('decayType');
      u32('symmetryType');
      break;
    case 'NiPSysColliderManager':
      ref('collider');
      break;
    case 'BSPSysSimpleColorModifier':
      for (const name of [
        'fadeIn',
        'fadeOut',
        'color1End',
        'color1Start',
        'color2End',
        'color2Start',
      ])
        f(name);
      values.colors = [...readColor4(reader), ...readColor4(reader), ...readColor4(reader)];
      break;
    case 'BSPSysScaleModifier':
      values.scales = Array.from({ length: readCount(reader, 4) }, () => reader.f32());
      break;
    case 'BSPSysLODModifier':
      f('beginDistance');
      f('endDistance');
      f('endEmitScale');
      f('endSize');
      break;
    case 'BSPSysSubTexModifier':
      for (const name of [
        'startFrame',
        'startFrameFudge',
        'endFrame',
        'loopStartFrame',
        'loopStartFrameFudge',
        'frameCount',
        'frameCountFudge',
      ])
        f(name);
      break;
    case 'BSPSysInheritVelocityModifier':
      ref('inheritObject');
      f('chance');
      f('multiplier');
      f('variation');
      break;
    case 'BSPSysRecycleBoundModifier':
      vec('boundOffset');
      vec('boundExtent');
      ref('boundObject');
      break;
    case 'BSWindModifier':
      f('strength');
      break;
    case 'BSPSysStripUpdateModifier':
      f('updateDeltaTime');
      break;
    default:
      throw new FormatError(`${type}: unsupported particle modifier`, reader.offset);
  }
  return { kind: 'particle-modifier', type, ...base, values };
};

/** NiPSysCollider: bounce, spawn/die on collide, spawn modifier, parent, next, object. */
const parseCollider: BlockParser = (reader, _context, type): ParticleModifierBlock => {
  const values: Record<string, number | boolean | Vec3 | readonly number[]> = {
    bounce: reader.f32(),
    spawnOnCollide: readBool(reader),
    dieOnCollide: readBool(reader),
    spawnModifier: reader.i32(),
    parent: reader.i32(),
    nextCollider: reader.i32(),
    colliderObject: reader.i32(),
  };
  if (type === 'NiPSysPlanarCollider') {
    values.width = reader.f32();
    values.height = reader.f32();
    values.xAxis = readVec3(reader);
    values.yAxis = readVec3(reader);
  } else {
    values.radius = reader.f32();
  }
  return {
    kind: 'particle-modifier',
    type,
    name: '',
    order: 0,
    target: -1,
    active: true,
    values,
  };
};

export const PARTICLE_PARSERS: ReadonlyMap<string, BlockParser> = new Map<string, BlockParser>([
  ['NiParticleSystem', parseParticleSystem],
  ['BSStripParticleSystem', parseParticleSystem],
  ['NiPSysData', parseParticleData],
  ['BSStripPSysData', parseParticleData],
  ...[
    'NiPSysBoxEmitter',
    'NiPSysCylinderEmitter',
    'NiPSysSphereEmitter',
    'NiPSysMeshEmitter',
    'NiPSysAgeDeathModifier',
    'NiPSysSpawnModifier',
    'NiPSysPositionModifier',
    'NiPSysBoundUpdateModifier',
    'NiPSysGravityModifier',
    'NiPSysRotationModifier',
    'NiPSysDragModifier',
    'NiPSysBombModifier',
    'NiPSysColliderManager',
    'BSPSysSimpleColorModifier',
    'BSPSysScaleModifier',
    'BSPSysLODModifier',
    'BSPSysSubTexModifier',
    'BSPSysInheritVelocityModifier',
    'BSPSysRecycleBoundModifier',
    'BSWindModifier',
    'BSPSysStripUpdateModifier',
  ].map((type): [string, BlockParser] => [type, parseModifier]),
  ['NiPSysPlanarCollider', parseCollider],
  ['NiPSysSphericalCollider', parseCollider],
]);
