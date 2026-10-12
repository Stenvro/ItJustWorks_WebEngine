// Parsers for the NIF blocks that animate models: time controllers, controller managers and
// their sequences, interpolators and keyframe data. Field order follows nif.xml for
// 20.2.0.7 / BS version 100. Layout notes: docs/formats/nif.md ("Animation").

import { FormatError, type BinaryReader } from '../binary-reader.ts';
import {
  readBool,
  readCount,
  readRefs,
  readStringRef,
  readVec3,
  type BlockContext,
  type BlockParser,
} from './blocks.ts';
import { readSizedString } from './header.ts';
import type {
  BlendInterpolatorBlock,
  BoolDataBlock,
  BoolInterpolatorBlock,
  ControlledBlock,
  ControllerBlock,
  ControllerManagerBlock,
  ControllerSequenceBlock,
  FloatDataBlock,
  FloatInterpolatorBlock,
  Key,
  KeyGroup,
  ObjectPaletteBlock,
  Point3InterpolatorBlock,
  PosDataBlock,
  QuatKey,
  Quaternion,
  Ref,
  TextKeysBlock,
  TimeControllerFields,
  TransformDataBlock,
  TransformInterpolatorBlock,
  Vec3,
} from './types.ts';

/** KeyType. */
export const KeyType = {
  linear: 1,
  quadratic: 2,
  tbc: 3,
  xyzRotation: 4,
  constant: 5,
} as const;

/** TimeControllerFlags: cycle type in bits 1-2, active in bit 3. */
export const CycleType = { loop: 0, reverse: 1, clamp: 2 } as const;

function readTimeController(reader: BinaryReader): TimeControllerFields {
  return {
    next: reader.i32(),
    flags: reader.u16(),
    frequency: reader.f32(),
    phase: reader.f32(),
    startTime: reader.f32(),
    stopTime: reader.f32(),
    target: reader.i32(),
  };
}

function readQuaternion(reader: BinaryReader): Quaternion {
  // NIF stores w first.
  return [reader.f32(), reader.f32(), reader.f32(), reader.f32()];
}

function readKeyGroup<T>(reader: BinaryReader, readValue: () => T): KeyGroup<T> {
  const count = reader.u32();
  if (count === 0) return { interpolation: KeyType.linear, keys: [] };
  const interpolation = reader.u32();
  if (count > reader.remaining) {
    throw new FormatError(`Key group of ${String(count)} keys runs past the block`, reader.offset);
  }
  const keys: Key<T>[] = [];
  for (let i = 0; i < count; i++) {
    const time = reader.f32();
    const value = readValue();
    if (interpolation === KeyType.quadratic) {
      keys.push({ time, value, forward: readValue(), backward: readValue() });
    } else if (interpolation === KeyType.tbc) {
      keys.push({ time, value, tbc: [reader.f32(), reader.f32(), reader.f32()] });
    } else {
      keys.push({ time, value });
    }
  }
  return { interpolation, keys };
}

// --- Controllers --------------------------------------------------------------------------

/** Controllers with one interpolator and nothing else of their own. */
const SINGLE_INTERP = new Set([
  'NiTransformController',
  'NiVisController',
  'NiAlphaController',
  'BSNiAlphaPropertyTestRefController',
  'BSFrustumFOVController',
]);

const parseController: BlockParser = (reader, context, type): ControllerBlock => {
  const base = readTimeController(reader);
  let interpolator: Ref = -1;
  let variable = -1;
  let extraTargets: Ref[] = [];
  let name = '';
  let visibilityInterpolator: Ref = -1;
  if (SINGLE_INTERP.has(type)) {
    interpolator = reader.i32();
  } else if (
    type === 'BSEffectShaderPropertyFloatController' ||
    type === 'BSLightingShaderPropertyFloatController' ||
    type === 'BSEffectShaderPropertyColorController' ||
    type === 'BSLightingShaderPropertyColorController'
  ) {
    interpolator = reader.i32();
    variable = reader.u32();
  } else if (type === 'NiMultiTargetTransformController') {
    const count = reader.u16();
    extraTargets = Array.from({ length: count }, () => reader.i32());
  } else if (type === 'NiFloatExtraDataController') {
    interpolator = reader.i32();
    name = readStringRef(reader, context);
  } else if (type === 'NiPSysUpdateCtlr') {
    // No fields of its own.
  } else if (type === 'NiPSysEmitterCtlr' || type === 'BSPSysMultiTargetEmitterCtlr') {
    interpolator = reader.i32();
    name = readStringRef(reader, context);
    visibilityInterpolator = reader.i32();
    if (type === 'BSPSysMultiTargetEmitterCtlr') {
      reader.u16(); // max emitters
      extraTargets = [reader.i32()]; // master particle system
    }
  } else if (type.startsWith('NiPSys') && type.endsWith('Ctlr')) {
    // NiPSysModifierCtlr subclasses: interpolator + modifier name.
    interpolator = reader.i32();
    name = readStringRef(reader, context);
  } else {
    throw new FormatError(`${type}: unsupported controller`, reader.offset);
  }
  return {
    ...base,
    kind: 'controller',
    type,
    interpolator,
    variable,
    extraTargets,
    name,
    visibilityInterpolator,
  };
};

const parseControllerManager: BlockParser = (reader): ControllerManagerBlock => ({
  ...readTimeController(reader),
  kind: 'controller-manager',
  cumulative: readBool(reader),
  sequences: readRefs(reader),
  palette: reader.i32(),
});

function readControlledBlock(reader: BinaryReader, context: BlockContext): ControlledBlock {
  return {
    interpolator: reader.i32(),
    controller: reader.i32(),
    priority: reader.u8(),
    nodeName: readStringRef(reader, context),
    propertyType: readStringRef(reader, context),
    controllerType: readStringRef(reader, context),
    controllerId: readStringRef(reader, context),
    interpolatorId: readStringRef(reader, context),
  };
}

const parseControllerSequence: BlockParser = (reader, context): ControllerSequenceBlock => {
  const name = readStringRef(reader, context);
  const count = readCount(reader, 29);
  reader.u32(); // array grow by
  const blocks = Array.from({ length: count }, () => readControlledBlock(reader, context));
  const weight = reader.f32();
  const textKeys = reader.i32();
  const cycleType = reader.u32();
  const frequency = reader.f32();
  const startTime = reader.f32();
  const stopTime = reader.f32();
  const manager = reader.i32();
  const accumRootName = readStringRef(reader, context);
  const notes = reader.u16();
  reader.skip(notes * 4); // BSAnimNotes refs
  return {
    kind: 'controller-sequence',
    name,
    blocks,
    weight,
    textKeys,
    cycleType,
    frequency,
    startTime,
    stopTime,
    manager,
    accumRootName,
  };
};

const parseObjectPalette: BlockParser = (reader): ObjectPaletteBlock => {
  const scene = reader.i32();
  const count = readCount(reader, 8);
  const objects = Array.from({ length: count }, () => {
    const name = readSizedString(reader);
    return { name, ref: reader.i32() };
  });
  return { kind: 'object-palette', scene, objects };
};

const parseTextKeys: BlockParser = (reader, context): TextKeysBlock => {
  const name = readStringRef(reader, context);
  const count = readCount(reader, 8);
  const keys = Array.from({ length: count }, () => ({
    time: reader.f32(),
    text: readStringRef(reader, context),
  }));
  return { kind: 'text-keys', name, keys };
};

// --- Interpolators ------------------------------------------------------------------------

const parseFloatInterpolator: BlockParser = (reader): FloatInterpolatorBlock => ({
  kind: 'float-interpolator',
  value: reader.f32(),
  data: reader.i32(),
});

const parseTransformInterpolator: BlockParser = (reader): TransformInterpolatorBlock => ({
  kind: 'transform-interpolator',
  translation: readVec3(reader),
  rotation: readQuaternion(reader),
  scale: reader.f32(),
  data: reader.i32(),
});

const parsePoint3Interpolator: BlockParser = (reader): Point3InterpolatorBlock => ({
  kind: 'point3-interpolator',
  value: readVec3(reader),
  data: reader.i32(),
});

const parseBoolInterpolator: BlockParser = (reader): BoolInterpolatorBlock => ({
  kind: 'bool-interpolator',
  value: reader.u8() !== 0,
  data: reader.i32(),
});

const parseBlendInterpolator: BlockParser = (reader, _context, type): BlendInterpolatorBlock => {
  const flags = reader.u8();
  const arraySize = reader.u8();
  reader.f32(); // weight threshold
  const items: { interpolator: Ref; weight: number; priority: number }[] = [];
  if ((flags & 1) === 0) {
    reader.u8(); // interp count
    reader.u8(); // single index
    reader.u8(); // high priority
    reader.u8(); // next high priority
    reader.f32(); // single time
    reader.f32(); // high weights sum
    reader.f32(); // next high weights sum
    reader.f32(); // high ease spinner
    for (let i = 0; i < arraySize; i++) {
      const interpolator = reader.i32();
      const weight = reader.f32();
      reader.f32(); // normalized weight
      const priority = reader.u8();
      reader.f32(); // ease spinner
      items.push({ interpolator, weight, priority });
    }
  }
  let value: number | Vec3 | undefined;
  if (type === 'NiBlendFloatInterpolator') value = reader.f32();
  else if (type === 'NiBlendBoolInterpolator') value = reader.u8();
  else if (type === 'NiBlendPoint3Interpolator') value = readVec3(reader);
  return { kind: 'blend-interpolator', type, managerControlled: (flags & 1) !== 0, items, value };
};

// --- Keyframe data ------------------------------------------------------------------------

const parseFloatData: BlockParser = (reader): FloatDataBlock => ({
  kind: 'float-data',
  keys: readKeyGroup(reader, () => reader.f32()),
});

const parsePosData: BlockParser = (reader): PosDataBlock => ({
  kind: 'pos-data',
  keys: readKeyGroup(reader, () => readVec3(reader)),
});

const parseBoolData: BlockParser = (reader): BoolDataBlock => ({
  kind: 'bool-data',
  keys: readKeyGroup(reader, () => reader.u8()),
});

const parseTransformData: BlockParser = (reader): TransformDataBlock => {
  const rotationCount = reader.u32();
  let rotationType: number = KeyType.linear;
  const quaternionKeys: QuatKey[] = [];
  let xyzRotations: KeyGroup<number>[] = [];
  if (rotationCount > 0) {
    rotationType = reader.u32();
    if (rotationType === KeyType.xyzRotation) {
      xyzRotations = [0, 1, 2].map(() => readKeyGroup(reader, () => reader.f32()));
    } else {
      for (let i = 0; i < rotationCount; i++) {
        const time = reader.f32();
        const value = readQuaternion(reader);
        if (rotationType === KeyType.tbc) {
          quaternionKeys.push({ time, value, tbc: [reader.f32(), reader.f32(), reader.f32()] });
        } else {
          quaternionKeys.push({ time, value });
        }
      }
    }
  }
  return {
    kind: 'transform-data',
    rotationType,
    quaternionKeys,
    xyzRotations,
    translations: readKeyGroup(reader, () => readVec3(reader)),
    scales: readKeyGroup(reader, () => reader.f32()),
  };
};

/** Parsers of the animation blocks, by block type. */
export const ANIMATION_PARSERS: ReadonlyMap<string, BlockParser> = new Map<string, BlockParser>([
  ...[
    'NiTransformController',
    'NiVisController',
    'NiAlphaController',
    'BSNiAlphaPropertyTestRefController',
    'BSFrustumFOVController',
    'BSEffectShaderPropertyFloatController',
    'BSLightingShaderPropertyFloatController',
    'BSEffectShaderPropertyColorController',
    'BSLightingShaderPropertyColorController',
    'NiMultiTargetTransformController',
    'NiFloatExtraDataController',
    'NiPSysUpdateCtlr',
    'NiPSysEmitterCtlr',
    'BSPSysMultiTargetEmitterCtlr',
    'NiPSysModifierActiveCtlr',
    'NiPSysEmitterSpeedCtlr',
    'NiPSysGravityStrengthCtlr',
    'NiPSysEmitterInitialRadiusCtlr',
    'NiPSysEmitterLifeSpanCtlr',
    'NiPSysInitialRotSpeedCtlr',
    'NiPSysEmitterDeclinationCtlr',
    'NiPSysEmitterPlanarAngleCtlr',
  ].map((type): [string, BlockParser] => [type, parseController]),
  ['NiControllerManager', parseControllerManager],
  ['NiControllerSequence', parseControllerSequence],
  ['NiDefaultAVObjectPalette', parseObjectPalette],
  ['NiTextKeyExtraData', parseTextKeys],
  ['NiFloatInterpolator', parseFloatInterpolator],
  ['NiTransformInterpolator', parseTransformInterpolator],
  ['NiPoint3Interpolator', parsePoint3Interpolator],
  ['NiBoolInterpolator', parseBoolInterpolator],
  ['NiBoolTimelineInterpolator', parseBoolInterpolator],
  ['NiBlendFloatInterpolator', parseBlendInterpolator],
  ['NiBlendTransformInterpolator', parseBlendInterpolator],
  ['NiBlendBoolInterpolator', parseBlendInterpolator],
  ['NiBlendPoint3Interpolator', parseBlendInterpolator],
  ['NiFloatData', parseFloatData],
  ['NiPosData', parsePosData],
  ['NiBoolData', parseBoolData],
  ['NiTransformData', parseTransformData],
  ['NiKeyframeData', parseTransformData],
]);
