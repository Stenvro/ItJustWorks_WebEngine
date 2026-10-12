// Havok Behavior graphs as Skyrim's objects use them. A mesh names its graph in a
// BSBehaviorGraphExtraData ("GenericBehaviors\BlendBetweenStatesVariable\...hkx", relative to
// meshes\): that file is the project (hkbProjectData), which names a character file
// (hkbCharacterData), which names the behavior file (hkbBehaviorGraph) relative to the
// project's folder. The behavior is a tree of generators: state machines, blenders, and
// leaves that play skeletal clips (hkbClipGenerator) or the mesh's own NIF sequences
// (BGSGamebryoSequenceGenerator, Bethesda's). Members can be bound to graph variables.
// Member offsets (64-bit, Havok 2010.2.0-r1): docs/formats/hkx.md.

import { FormatError } from '../binary-reader.ts';
import { folderOf, normalizePath } from '../paths.ts';
import { Packfile, type HkxObject } from './packfile.ts';

/** A member that a variable binding may override. */
export interface Bindable {
  readonly value: number;
  /** Index of the graph variable bound to it, if any. */
  readonly variable?: number;
}

export interface BehaviorVariable {
  readonly name: string;
  /** hkbVariableInfo type: 0 bool, 1 int8, 2 int16, 3 int32, 4 real, 5 pointer, 6+ vectors. */
  readonly type: number;
  /** Initial value (reals as floats, the others as integers). */
  readonly initial: number;
}

/** A state machine transition (hkbStateMachineTransitionInfo). */
export interface StateTransition {
  /** Event that triggers it (index into the graph's events), −1 for none. */
  readonly eventId: number;
  readonly toStateId: number;
  /** TRANSITION_FLAGS. */
  readonly flags: number;
  readonly priority: number;
  /** Whether it has a condition (hkbExpressionCondition, hkbStringCondition). */
  readonly conditional: boolean;
  /** Blend duration of its transition effect, seconds (0 without one). */
  readonly duration: number;
}

export interface StateMachineState {
  readonly id: number;
  readonly name: string;
  readonly probability: number;
  readonly enable: boolean;
  readonly generator: BehaviorGenerator | undefined;
  readonly transitions: readonly StateTransition[];
}

export interface BlenderChild {
  readonly weight: Bindable;
  readonly generator: BehaviorGenerator | undefined;
}

export type BehaviorGenerator =
  | {
      readonly kind: 'state-machine';
      readonly name: string;
      readonly startStateId: Bindable;
      /** StartStateMode: 0 default (startStateId), 1 sync, 2 random, 3 chooser. */
      readonly startStateMode: number;
      readonly states: readonly StateMachineState[];
      /** Transitions from any state. */
      readonly wildcardTransitions: readonly StateTransition[];
    }
  | {
      readonly kind: 'blender';
      readonly name: string;
      /** BlenderFlags (BLENDER_FLAGS below). */
      readonly flags: number;
      readonly blendParameter: Bindable;
      readonly children: readonly BlenderChild[];
    }
  | {
      readonly kind: 'modifier-generator';
      readonly name: string;
      readonly generator: BehaviorGenerator | undefined;
    }
  | {
      readonly kind: 'gamebryo-sequence';
      readonly name: string;
      /** The NIF sequence (NiControllerSequence) it plays on the mesh's controller manager. */
      readonly sequence: string;
      /** BlendModeFunction: 0 none, 1 percent, 2 one minus percent. */
      readonly blendMode: number;
      readonly percent: Bindable;
    }
  | {
      readonly kind: 'clip';
      readonly name: string;
      /** Skeletal animation (hkaAnimation) by name, from the character's animation list. */
      readonly animation: string;
      /** PlaybackMode: 0 single play, 1 looping, 2 user controlled, 3 ping-pong, 4 count. */
      readonly mode: number;
      readonly playbackSpeed: number;
    }
  | { readonly kind: 'reference-pose'; readonly name: string }
  | { readonly kind: 'other'; readonly name: string; readonly className: string };

export interface BehaviorGraph {
  readonly name: string;
  /** Event names by id (hkbBehaviorGraphStringData). */
  readonly events: readonly string[];
  readonly variables: readonly BehaviorVariable[];
  readonly root: BehaviorGenerator | undefined;
}

/** hkbBlenderGenerator::BlenderFlags. */
export const BLENDER_FLAGS = {
  sync: 0x1,
  smoothGeneratorWeights: 0x4,
  dontDeactivateChildrenWithZeroWeights: 0x8,
  parametricBlend: 0x10,
  isParametricBlendCyclic: 0x20,
  forceDensePose: 0x40,
} as const;

/** hkbStateMachineTransitionInfo::TransitionFlags. */
export const TRANSITION_FLAGS = {
  useTriggerInterval: 0x1,
  useInitiateInterval: 0x2,
  uninterruptibleWhilePlaying: 0x4,
  uninterruptibleWhileDelayed: 0x8,
  delayStateChange: 0x10,
  disabled: 0x20,
  disallowReturnToPreviousState: 0x40,
  disallowRandomTransition: 0x80,
  disableCondition: 0x100,
  allowSelfTransitionByTransitionFromAnyState: 0x200,
  isGlobalWildcard: 0x400,
  isLocalWildcard: 0x800,
  fromNestedStateIdIsValid: 0x1000,
  toNestedStateIdIsValid: 0x2000,
  abutAtEndOfFromGenerator: 0x4000,
} as const;

/** A NIF sequence a graph plays, and its weight on the controller manager. */
export interface GraphSequence {
  readonly sequence: string;
  readonly weight: number;
}

/** What a graph plays when it starts: NIF sequences and skeletal clips. */
export interface GraphStart {
  readonly sequences: readonly GraphSequence[];
  /** TODO(M7): skeletal clips play on the mesh's bones once HKX animations are read. */
  readonly clips: readonly string[];
}

// hkbBindable: variableBindingSet pointer at 16. hkbNode: name at 56.
const BINDABLE_BINDINGS = 16;
const NODE_NAME = 56;
const BINDING_SIZE = 40;
const BINDING_TYPE_VARIABLE = 0;
/** hkbVariableInfo: role (4 bytes) + type (int8), 6 bytes each. */
const VARIABLE_INFO_SIZE = 6;
const VARIABLE_TYPE_REAL = 4;
const TRANSITION_SIZE = 72;

/** The project's character file, relative to the project's folder (hkbProjectStringData). */
export function projectCharacterFile(project: Packfile): string {
  const data = requireObject(project, 'hkbProjectData');
  const strings = project.object(data.offset + 32);
  if (strings?.className !== 'hkbProjectStringData') {
    throw new FormatError('hkbProjectData without string data', data.offset);
  }
  const characters = project.stringArray(strings.offset + 48);
  const first = characters[0];
  if (first === undefined) throw new FormatError('Behavior project without a character', 0);
  return first;
}

/** The character's behavior file, relative to the project's folder (hkbCharacterStringData). */
export function characterBehaviorFile(character: Packfile): string {
  const data = requireObject(character, 'hkbCharacterData');
  const strings = character.object(data.offset + 152);
  if (strings?.className !== 'hkbCharacterStringData') {
    throw new FormatError('hkbCharacterData without string data', data.offset);
  }
  const behavior = character.string(strings.offset + 184);
  if (!behavior) throw new FormatError('Behavior character without a behavior file', 0);
  return behavior;
}

/** Reads the generator tree and variables of a behavior file (hkbBehaviorGraph). */
export function parseBehaviorGraph(file: Packfile): BehaviorGraph {
  const graph = requireObject(file, 'hkbBehaviorGraph');
  const data = file.object(graph.offset + 136);
  const variables: BehaviorVariable[] = [];
  let events: string[] = [];
  if (data?.className === 'hkbBehaviorGraphData') {
    const infos = file.array(data.offset + 32);
    const values = file.object(data.offset + 112);
    const strings = file.object(data.offset + 120);
    const names = strings ? file.stringArray(strings.offset + 48) : [];
    if (strings) events = file.stringArray(strings.offset + 16);
    const words = values ? file.array(values.offset + 16) : { data: 0, size: 0 };
    for (let i = 0; i < infos.size; i++) {
      const type = file.i8(infos.data + i * VARIABLE_INFO_SIZE + 4);
      const at = words.data + i * 4;
      const initial =
        i >= words.size ? 0 : type === VARIABLE_TYPE_REAL ? file.f32(at) : file.i32(at);
      variables.push({ name: names[i] ?? '', type, initial });
    }
  }
  const visiting = new Set<number>();
  const generator = (object: HkxObject | undefined): BehaviorGenerator | undefined => {
    if (!object || visiting.has(object.offset)) return undefined;
    visiting.add(object.offset);
    try {
      return readGenerator(file, object, generator);
    } finally {
      visiting.delete(object.offset);
    }
  };
  return {
    name: file.string(graph.offset + NODE_NAME) ?? '',
    events,
    variables,
    root: generator(file.object(graph.offset + 128)),
  };
}

function readGenerator(
  file: Packfile,
  object: HkxObject,
  generator: (object: HkxObject | undefined) => BehaviorGenerator | undefined,
): BehaviorGenerator {
  const at = object.offset;
  const name = file.string(at + NODE_NAME) ?? '';
  const bindings = readBindings(file, at);
  const bindable = (member: string, value: number): Bindable => {
    const variable = bindings.get(member);
    return variable === undefined ? { value } : { value, variable };
  };
  switch (object.className) {
    case 'hkbStateMachine':
      return {
        kind: 'state-machine',
        name,
        startStateId: bindable('startStateId', file.i32(at + 104)),
        startStateMode: file.i8(at + 134),
        states: file.objectArray(at + 144).flatMap((state) => {
          if (state?.className !== 'hkbStateMachineStateInfo') return [];
          return [
            {
              id: file.i32(state.offset + 104),
              name: file.string(state.offset + 96) ?? '',
              probability: file.f32(state.offset + 108),
              enable: file.bool(state.offset + 112),
              generator: generator(file.object(state.offset + 88)),
              transitions: readTransitions(file, file.object(state.offset + 80)),
            },
          ];
        }),
        wildcardTransitions: readTransitions(file, file.object(at + 160)),
      };
    case 'hkbBlenderGenerator':
    case 'hkbPoseMatchingGenerator':
      return {
        kind: 'blender',
        name,
        flags: file.i16(at + 90),
        blendParameter: bindable('blendParameter', file.f32(at + 76)),
        children: file.objectArray(at + 96).flatMap((child) => {
          if (child?.className !== 'hkbBlenderGeneratorChild') return [];
          const childBindings = readBindings(file, child.offset);
          const weight = file.f32(child.offset + 64);
          const variable = childBindings.get('weight');
          return [
            {
              weight: variable === undefined ? { value: weight } : { value: weight, variable },
              generator: generator(file.object(child.offset + 48)),
            },
          ];
        }),
      };
    case 'hkbModifierGenerator':
      return { kind: 'modifier-generator', name, generator: generator(file.object(at + 80)) };
    case 'BGSGamebryoSequenceGenerator':
      return {
        kind: 'gamebryo-sequence',
        name,
        sequence: file.string(at + 72) ?? '',
        blendMode: file.i8(at + 80),
        percent: bindable('fPercent', file.f32(at + 84)),
      };
    case 'hkbClipGenerator':
      return {
        kind: 'clip',
        name,
        animation: file.string(at + 72) ?? '',
        mode: file.i8(at + 114),
        playbackSpeed: file.f32(at + 100),
      };
    case 'hkbReferencePoseGenerator':
      return { kind: 'reference-pose', name };
    default:
      return { kind: 'other', name, className: object.className };
  }
}

/** The transitions of an hkbStateMachineTransitionInfoArray. */
function readTransitions(file: Packfile, array: HkxObject | undefined): StateTransition[] {
  if (array?.className !== 'hkbStateMachineTransitionInfoArray') return [];
  const { data, size } = file.array(array.offset + 16);
  return Array.from({ length: size }, (_, i): StateTransition => {
    const at = data + i * TRANSITION_SIZE;
    const effect = file.object(at + 32);
    return {
      eventId: file.i32(at + 48),
      toStateId: file.i32(at + 52),
      priority: file.i16(at + 64),
      flags: file.u16(at + 66),
      conditional: file.object(at + 40) !== undefined,
      duration:
        effect?.className === 'hkbBlendingTransitionEffect' ? file.f32(effect.offset + 80) : 0,
    };
  });
}

/** Member path → variable index of an hkbBindable's variable bindings. */
function readBindings(file: Packfile, bindable: number): Map<string, number> {
  const result = new Map<string, number>();
  const set = file.object(bindable + BINDABLE_BINDINGS);
  if (set?.className !== 'hkbVariableBindingSet') return result;
  const { data, size } = file.array(set.offset + 16);
  for (let i = 0; i < size; i++) {
    const at = data + i * BINDING_SIZE;
    // Character property bindings read the character's properties, which objects do not set.
    if (file.i8(at + 33) !== BINDING_TYPE_VARIABLE) continue;
    const path = file.string(at);
    if (path !== undefined) result.set(path, file.i32(at + 28));
  }
  return result;
}

function requireObject(file: Packfile, className: string): HkxObject {
  const found = file.objectsOf(className)[0];
  if (!found) throw new FormatError(`No ${className} in the packfile`, 0);
  return found;
}

/**
 * What a graph plays as soon as it is activated (an object's 3D loads): the start state of
 * each state machine (startStateId, or by its bound variable), every child of a blender
 * with weight (two neighbours by blend parameter for parametric blends), and the leaves:
 * NIF sequences with their blend weight, skeletal clips. Random start states take the
 * first enabled state, deterministically.
 */
export function graphStart(graph: BehaviorGraph): GraphStart {
  const resolve = (bindable: Bindable): number =>
    bindable.variable === undefined
      ? bindable.value
      : (graph.variables[bindable.variable]?.initial ?? bindable.value);
  const sequences = new Map<string, number>();
  const clips: string[] = [];
  const visit = (node: BehaviorGenerator | undefined): void => {
    if (!node) return;
    switch (node.kind) {
      case 'state-machine': {
        const id = resolve(node.startStateId);
        const state =
          node.states.find((candidate) => candidate.id === id) ??
          node.states.find((candidate) => candidate.enable);
        visit(state?.generator);
        return;
      }
      case 'blender':
        for (const [child] of activeChildren(node, resolve)) visit(child.generator);
        return;
      case 'modifier-generator':
        visit(node.generator);
        return;
      case 'gamebryo-sequence': {
        const percent = resolve(node.percent);
        const weight = node.blendMode === 1 ? percent : node.blendMode === 2 ? 1 - percent : 1;
        const name = node.sequence.toLowerCase();
        sequences.set(name, Math.max(sequences.get(name) ?? 0, Math.min(1, Math.max(0, weight))));
        return;
      }
      case 'clip':
        clips.push(node.animation);
        return;
      case 'reference-pose':
      case 'other':
        return;
    }
  };
  visit(graph.root);
  return {
    sequences: [...sequences].map(([sequence, weight]) => ({ sequence, weight })),
    clips,
  };
}

/** The children a blender activates and their blend weights. */
function activeChildren(
  blender: Extract<BehaviorGenerator, { kind: 'blender' }>,
  resolve: (bindable: Bindable) => number,
): [BlenderChild, number][] {
  const weighted = blender.children.map((child): [BlenderChild, number] => [
    child,
    resolve(child.weight),
  ]);
  const keepZero = (blender.flags & BLENDER_FLAGS.dontDeactivateChildrenWithZeroWeights) !== 0;
  const active = (children: [BlenderChild, number][]): [BlenderChild, number][] =>
    children.filter(([, weight]) => keepZero || weight > 0);
  if ((blender.flags & BLENDER_FLAGS.parametricBlend) === 0) return active(weighted);
  // Parametric: children sit at their weights on the parameter's axis; the two around the
  // parameter blend linearly (clamped at the ends).
  const parameter = resolve(blender.blendParameter);
  const sorted = [...weighted].sort((a, b) => a[1] - b[1]);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return [];
  if (parameter <= first[1]) return [[first[0], 1]];
  if (parameter >= last[1]) return [[last[0], 1]];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (!a || !b || parameter > b[1]) continue;
    const t = (parameter - a[1]) / (b[1] - a[1] || 1);
    return active([
      [a[0], 1 - t],
      [b[0], t],
    ]);
  }
  return [];
}

/**
 * Reads a behavior project and the files it names: `project` is the mesh's graph path under
 * meshes\ (or any data path); the character and behavior files are relative to its folder.
 */
export async function loadBehaviorGraph(
  project: string,
  read: (path: string) => Promise<Uint8Array>,
): Promise<BehaviorGraph> {
  const path = normalizePath(project);
  const folder = folderOf(path);
  // Relative to the project's folder; ".." steps up (the bows share weapons\bow\).
  const relative = (name: string): string => {
    const parts: string[] = [];
    for (const part of normalizePath(folder ? `${folder}\\${name}` : name).split('\\')) {
      if (part === '..') parts.pop();
      else if (part !== '.') parts.push(part);
    }
    return parts.join('\\');
  };
  const character = Packfile.parse(
    await read(relative(projectCharacterFile(Packfile.parse(await read(path))))),
  );
  return parseBehaviorGraph(Packfile.parse(await read(relative(characterBehaviorFile(character)))));
}
