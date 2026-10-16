// Havok Behavior graphs. A mesh or a race names a behavior project (hkbProjectData, a .hkx
// relative to meshes\); the project names a character file (hkbCharacterData: its skeleton,
// animations and behavior file, relative to the project's folder); the behavior file
// (hkbBehaviorGraph) is a tree of generators: state machines, blenders, selectors and leaves
// that play skeletal clips (hkbClipGenerator) or a mesh's own NIF sequences
// (BGSGamebryoSequenceGenerator, Bethesda's), with modifiers that set variables, raise events
// or move bones, and references to further behavior files. Members can be bound to the
// graph's variables. Member offsets (64-bit, Havok 2010.2.0-r1): docs/formats/hkx.md.
// The runtime: src/animation/object-graph.ts (objects), src/animation/behavior-runtime.ts
// (actors).

import { FormatError } from '../binary-reader.ts';
import { folderOf, normalizePath } from '../paths.ts';
import { Packfile, type HkxObject } from './packfile.ts';

/** A member that a variable binding may override. */
export interface Bindable {
  readonly value: number;
  /** Index of the graph variable bound to it, if any. */
  readonly variable?: number;
  /** Index of the character property bound to it (BINDING_TYPE_CHARACTER_PROPERTY), if any. */
  readonly property?: number;
}

export interface BehaviorVariable {
  readonly name: string;
  /** hkbVariableInfo type: 0 bool, 1 int8, 2 int16, 3 int32, 4 real, 5 pointer, 6+ vectors. */
  readonly type: number;
  /** Initial value (reals as floats, the others as integers). */
  readonly initial: number;
}

/** An event with its payload (hkbEventProperty): −1 for none. */
export interface BehaviorEvent {
  readonly id: number;
  /** hkbStringEventPayload text, if any. */
  readonly payload?: string;
}

/** hkbStateMachineTimeInterval: each end an event (id ≥ 0) or else a time in the state. */
export interface TimeInterval {
  readonly enterEventId: number;
  readonly exitEventId: number;
  readonly enterTime: number;
  readonly exitTime: number;
}

/** hkbBlendingTransitionEffect. */
export interface TransitionEffect {
  readonly duration: number;
  /** Where the state entered starts, as a fraction of its duration. */
  readonly toGeneratorStartTimeFraction: number;
  /** FlagBits: 1 ignore from world-from-model, 2 sync, 4 ignore to world-from-model. */
  readonly flags: number;
  /** 0 none, 1 until the end of the from generator, 2 capped at its end. */
  readonly endMode: number;
  /** 0 smooth, 1 linear, 2 linear to smooth, 3 smooth to linear. */
  readonly blendCurve: number;
  /** 0 continue if cyclic, blend if acyclic; 1 continue; 2 reset; 3 blend. */
  readonly selfTransitionMode: number;
  /** 0 default, 1 process all, 2 ignore the from generator's, 3 ignore the to generator's. */
  readonly eventMode: number;
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
  /** The condition's expression (src/animation/behavior-expression.ts). */
  readonly condition?: string;
  /** Blend duration of its transition effect, seconds (0 without one). */
  readonly duration: number;
  readonly effect?: TransitionEffect;
  readonly fromNestedStateId?: number;
  readonly toNestedStateId?: number;
  readonly triggerInterval?: TimeInterval;
  readonly initiateInterval?: TimeInterval;
}

export interface StateMachineState {
  readonly id: number;
  readonly name: string;
  readonly probability: number;
  readonly enable: boolean;
  readonly generator: BehaviorGenerator | undefined;
  readonly transitions: readonly StateTransition[];
  /** Events raised when the state is entered and left. */
  readonly enterNotifyEvents?: readonly BehaviorEvent[];
  readonly exitNotifyEvents?: readonly BehaviorEvent[];
}

export interface BlenderChild {
  readonly weight: Bindable;
  readonly generator: BehaviorGenerator | undefined;
  /** Per Havok bone: how much of the child each bone takes (hkbBoneWeightArray). */
  readonly boneWeights?: Float32Array;
}

/** A clip's event at a local time (hkbClipTrigger). */
export interface ClipTrigger {
  readonly localTime: number;
  readonly event: BehaviorEvent;
  readonly relativeToEndOfClip: boolean;
  readonly acyclic: boolean;
  readonly isAnnotation: boolean;
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
      /** Raised at the beginning and end of a transition (once for an instant one). */
      readonly eventToSendWhenStateOrTransitionChanges?: BehaviorEvent;
      readonly returnToPreviousStateEventId?: number;
      readonly randomTransitionEventId?: number;
      readonly transitionToNextHigherStateEventId?: number;
      readonly transitionToNextLowerStateEventId?: number;
      /** START_STATE_MODE_SYNC: the variable that holds the start state. */
      readonly syncVariableIndex?: number;
      readonly wrapAroundStateId?: boolean;
      readonly maxSimultaneousTransitions?: number;
      /** 0 no transition, 1 to the start state if a transition exists, 2 always. */
      readonly selfTransitionMode?: number;
    }
  | {
      readonly kind: 'blender';
      readonly name: string;
      /** BlenderFlags (BLENDER_FLAGS below). */
      readonly flags: number;
      readonly blendParameter: Bindable;
      readonly children: readonly BlenderChild[];
      readonly referencePoseWeightThreshold?: number;
      readonly minCyclicBlendParameter?: number;
      readonly maxCyclicBlendParameter?: number;
      readonly indexOfSyncMasterChild?: number;
      readonly subtractLastChild?: boolean;
    }
  | {
      readonly kind: 'modifier-generator';
      readonly name: string;
      readonly generator: BehaviorGenerator | undefined;
      readonly modifier?: BehaviorModifier;
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
      readonly speed?: Bindable;
      readonly startTime?: Bindable;
      readonly cropStart?: number;
      readonly cropEnd?: number;
      readonly enforcedDuration?: number;
      readonly userControlledTimeFraction?: Bindable;
      readonly flags?: number;
      readonly triggers?: readonly ClipTrigger[];
    }
  | {
      readonly kind: 'manual-selector';
      readonly name: string;
      readonly generators: readonly (BehaviorGenerator | undefined)[];
      readonly selectedGeneratorIndex: Bindable;
    }
  | {
      /**
       * BSiStateTaggingGenerator: plays its generator, tagging the actor's state (iStateToSetAs,
       * bound to an iState_<movement type> variable: the engine's movement type while active).
       */
      readonly kind: 'state-tagging';
      readonly name: string;
      readonly generator: BehaviorGenerator | undefined;
      readonly iState: Bindable;
      readonly priority: number;
    }
  | {
      /** BSCyclicBlendTransitionGenerator: a blender whose changes are cross-faded. */
      readonly kind: 'cyclic-blend';
      readonly name: string;
      readonly generator: BehaviorGenerator | undefined;
      readonly freezeEvent: BehaviorEvent;
      readonly crossBlendEvent: BehaviorEvent;
      readonly blendParameter: Bindable;
      readonly transitionDuration: number;
      readonly blendCurve: number;
    }
  | {
      /** BSBoneSwitchGenerator: its default generator, some bones from other generators. */
      readonly kind: 'bone-switch';
      readonly name: string;
      readonly generator: BehaviorGenerator | undefined;
      readonly children: readonly {
        readonly generator: BehaviorGenerator | undefined;
        readonly boneWeights?: Float32Array;
      }[];
    }
  | {
      /** BSSynchronizedClipGenerator: a clip played in step with another actor's. */
      readonly kind: 'synchronized-clip';
      readonly name: string;
      readonly generator: BehaviorGenerator | undefined;
    }
  | {
      /** BSOffsetAnimationGenerator: a clip whose frame a variable picks, laid on another. */
      readonly kind: 'offset-animation';
      readonly name: string;
      readonly generator: BehaviorGenerator | undefined;
      readonly offsetGenerator: BehaviorGenerator | undefined;
      readonly offsetVariable: Bindable;
      readonly rangeStart: number;
      readonly rangeEnd: number;
    }
  | {
      /** hkbBehaviorReferenceGenerator: the root of another behavior file. */
      readonly kind: 'behavior-reference';
      readonly name: string;
      /** The behavior file, relative to the project's folder. */
      readonly behavior: string;
    }
  | { readonly kind: 'reference-pose'; readonly name: string }
  | { readonly kind: 'other'; readonly name: string; readonly className: string };

/** An event raised by an expression (hkbExpressionData). */
export interface ExpressionData {
  readonly expression: string;
  /** Variable assigned (−1 none) and event raised (−1 none), as Havok compiled them. */
  readonly variable: number;
  readonly event: number;
  /** 0 send once, 1 send on true, 2 send on false to true, 3 every frame once true. */
  readonly eventMode: number;
}

/** Modifiers: what changes variables, raises events or moves bones while it is active. */
export type BehaviorModifier = { readonly name: string; readonly enable: Bindable } & (
  | { readonly kind: 'list'; readonly modifiers: readonly BehaviorModifier[] }
  | { readonly kind: 'expressions'; readonly expressions: readonly ExpressionData[] }
  | {
      /** BSIsActiveModifier: sets its bound flags while it is active (inverted where asked). */
      readonly kind: 'is-active';
      readonly slots: readonly { readonly output: Bindable; readonly invert: boolean }[];
    }
  | { readonly kind: 'timer'; readonly alarmTime: Bindable; readonly alarmEvent: BehaviorEvent }
  | {
      readonly kind: 'event-driven';
      readonly modifier: BehaviorModifier | undefined;
      readonly activateEventId: number;
      readonly deactivateEventId: number;
      readonly activeByDefault: boolean;
    }
  | { readonly kind: 'event-on-deactivate'; readonly event: BehaviorEvent }
  | {
      readonly kind: 'event-on-false-to-true';
      readonly slots: readonly {
        readonly enabled: Bindable;
        readonly test: Bindable;
        readonly event: BehaviorEvent;
      }[];
    }
  | {
      readonly kind: 'every-n-events';
      readonly eventToCheckFor: BehaviorEvent;
      readonly eventToSend: BehaviorEvent;
      readonly count: Bindable;
      readonly minimum: Bindable;
      readonly randomize: boolean;
    }
  | {
      readonly kind: 'damping';
      readonly kP: Bindable;
      readonly kI: Bindable;
      readonly kD: Bindable;
      readonly rawValue: Bindable;
      readonly dampedValue: Bindable;
    }
  | {
      readonly kind: 'interp-value';
      readonly source: Bindable;
      readonly target: Bindable;
      readonly result: Bindable;
      readonly gain: Bindable;
    }
  | {
      readonly kind: 'modify-once';
      readonly onActivate: BehaviorModifier | undefined;
      readonly onDeactivate: BehaviorModifier | undefined;
    }
  | {
      readonly kind: 'events-from-range';
      readonly input: Bindable;
      readonly lowerBound: Bindable;
      readonly ranges: readonly {
        readonly upperBound: number;
        readonly event: BehaviorEvent;
        /** 0 send on entering the range, 1 send while in it. */
        readonly mode: number;
      }[];
    }
  | {
      /** BSSpeedSamplerModifier: the actor's speed in a state and direction (the engine's). */
      readonly kind: 'speed-sampler';
      readonly state: Bindable;
      readonly direction: Bindable;
      readonly goalSpeed: Bindable;
      readonly speedOut: Bindable;
    }
  | {
      /**
       * Procedural modifiers that move bones (look-at, IK, twist, keyframed bones) or drive
       * the ragdoll: TODO(M10) with head tracking, foot IK and ragdolls.
       */
      readonly kind: 'other';
      readonly className: string;
    }
);

export interface BehaviorGraph {
  readonly name: string;
  /** Event names by id (hkbBehaviorGraphStringData). */
  readonly events: readonly string[];
  readonly variables: readonly BehaviorVariable[];
  /** Character property names by index (bound with BINDING_TYPE_CHARACTER_PROPERTY). */
  readonly characterProperties?: readonly string[];
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
  readonly clips: readonly string[];
}

// hkbBindable: variableBindingSet pointer at 16. hkbNode: name at 56. hkbModifier: enable 72.
const BINDABLE_BINDINGS = 16;
const NODE_NAME = 56;
const MODIFIER_ENABLE = 72;
const BINDING_SIZE = 40;
const BINDING_TYPE_VARIABLE = 0;
const BINDING_TYPE_CHARACTER_PROPERTY = 1;
/** hkbVariableInfo: role (4 bytes) + type (int8), 6 bytes each. */
const VARIABLE_INFO_SIZE = 6;
const VARIABLE_TYPE_REAL = 4;
const TRANSITION_SIZE = 72;
const CLIP_TRIGGER_SIZE = 32;
const EVENT_PROPERTY_SIZE = 16;
const EXPRESSION_DATA_SIZE = 24;
const EVENT_RANGE_SIZE = 32;

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
  let characterProperties: string[] = [];
  if (data?.className === 'hkbBehaviorGraphData') {
    const infos = file.array(data.offset + 32);
    const values = file.object(data.offset + 112);
    const strings = file.object(data.offset + 120);
    const names = strings ? file.stringArray(strings.offset + 48) : [];
    if (strings) {
      events = file.stringArray(strings.offset + 16);
      characterProperties = file.stringArray(strings.offset + 64);
    }
    const words = values ? file.array(values.offset + 16) : { data: 0, size: 0 };
    for (let i = 0; i < infos.size; i++) {
      const type = file.i8(infos.data + i * VARIABLE_INFO_SIZE + 4);
      const at = words.data + i * 4;
      const initial =
        i >= words.size ? 0 : type === VARIABLE_TYPE_REAL ? file.f32(at) : file.i32(at);
      variables.push({ name: names[i] ?? '', type, initial });
    }
  }
  const reader = new GraphReader(file);
  return {
    name: file.string(graph.offset + NODE_NAME) ?? '',
    events,
    variables,
    characterProperties,
    root: reader.generator(file.object(graph.offset + 128)),
  };
}

/** Reads a behavior file's objects into generators and modifiers (shared objects once). */
class GraphReader {
  readonly #file: Packfile;
  readonly #generators = new Map<number, BehaviorGenerator | undefined>();
  readonly #modifiers = new Map<number, BehaviorModifier | undefined>();
  readonly #visiting = new Set<number>();

  constructor(file: Packfile) {
    this.#file = file;
  }

  generator(object: HkxObject | undefined): BehaviorGenerator | undefined {
    if (!object || this.#visiting.has(object.offset)) return undefined;
    if (this.#generators.has(object.offset)) return this.#generators.get(object.offset);
    this.#visiting.add(object.offset);
    try {
      const generator = this.#readGenerator(object);
      this.#generators.set(object.offset, generator);
      return generator;
    } finally {
      this.#visiting.delete(object.offset);
    }
  }

  modifier(object: HkxObject | undefined): BehaviorModifier | undefined {
    if (!object || this.#visiting.has(object.offset)) return undefined;
    if (this.#modifiers.has(object.offset)) return this.#modifiers.get(object.offset);
    this.#visiting.add(object.offset);
    try {
      const modifier = this.#readModifier(object);
      this.#modifiers.set(object.offset, modifier);
      return modifier;
    } finally {
      this.#visiting.delete(object.offset);
    }
  }

  /** An hkbEventProperty / hkbEventBase: id, then the payload pointer 8 later. */
  event(at: number): BehaviorEvent {
    const file = this.#file;
    const id = file.i32(at);
    const payload = file.object(at + 8);
    const text =
      payload?.className === 'hkbStringEventPayload' ? file.string(payload.offset + 16) : undefined;
    return text === undefined ? { id } : { id, payload: text };
  }

  /** The events of an hkbStateMachineEventPropertyArray. */
  events(array: HkxObject | undefined): BehaviorEvent[] {
    if (array?.className !== 'hkbStateMachineEventPropertyArray') return [];
    const { data, size } = this.#file.array(array.offset + 16);
    return Array.from({ length: size }, (_, i) => this.event(data + i * EVENT_PROPERTY_SIZE));
  }

  /** The per-bone weights of an hkbBoneWeightArray. */
  boneWeights(object: HkxObject | undefined): Float32Array | undefined {
    if (object?.className !== 'hkbBoneWeightArray') return undefined;
    const { data, size } = this.#file.array(object.offset + 48);
    return Float32Array.from({ length: size }, (_, i) => this.#file.f32(data + i * 4));
  }

  #readGenerator(object: HkxObject): BehaviorGenerator {
    const file = this.#file;
    const at = object.offset;
    const name = file.string(at + NODE_NAME) ?? '';
    const bindable = bindableReader(file, at);
    const child = (offset: number): BehaviorGenerator | undefined =>
      this.generator(file.object(at + offset));
    switch (object.className) {
      case 'hkbStateMachine':
        return {
          kind: 'state-machine',
          name,
          eventToSendWhenStateOrTransitionChanges: this.event(at + 72),
          startStateId: bindable('startStateId', file.i32(at + 104)),
          returnToPreviousStateEventId: file.i32(at + 108),
          randomTransitionEventId: file.i32(at + 112),
          transitionToNextHigherStateEventId: file.i32(at + 116),
          transitionToNextLowerStateEventId: file.i32(at + 120),
          syncVariableIndex: file.i32(at + 124),
          wrapAroundStateId: file.bool(at + 132),
          maxSimultaneousTransitions: file.i8(at + 133),
          startStateMode: file.i8(at + 134),
          selfTransitionMode: file.i8(at + 135),
          states: file.objectArray(at + 144).flatMap((state) => {
            if (state?.className !== 'hkbStateMachineStateInfo') return [];
            const s = state.offset;
            return [
              {
                id: file.i32(s + 104),
                name: file.string(s + 96) ?? '',
                probability: file.f32(s + 108),
                enable: file.bool(s + 112),
                generator: this.generator(file.object(s + 88)),
                transitions: this.#transitions(file.object(s + 80)),
                enterNotifyEvents: this.events(file.object(s + 64)),
                exitNotifyEvents: this.events(file.object(s + 72)),
              },
            ];
          }),
          wildcardTransitions: this.#transitions(file.object(at + 160)),
        };
      case 'hkbBlenderGenerator':
      case 'hkbPoseMatchingGenerator':
        return {
          kind: 'blender',
          name,
          referencePoseWeightThreshold: file.f32(at + 72),
          blendParameter: bindable('blendParameter', file.f32(at + 76)),
          minCyclicBlendParameter: file.f32(at + 80),
          maxCyclicBlendParameter: file.f32(at + 84),
          indexOfSyncMasterChild: file.i16(at + 88),
          flags: file.i16(at + 90),
          subtractLastChild: file.bool(at + 92),
          children: file.objectArray(at + 96).flatMap((child) => {
            if (child?.className !== 'hkbBlenderGeneratorChild') return [];
            const childBindable = bindableReader(file, child.offset);
            const boneWeights = this.boneWeights(file.object(child.offset + 56));
            return [
              {
                weight: childBindable('weight', file.f32(child.offset + 64)),
                generator: this.generator(file.object(child.offset + 48)),
                ...(boneWeights && { boneWeights }),
              },
            ];
          }),
        };
      case 'hkbModifierGenerator': {
        const modifier = this.modifier(file.object(at + 72));
        return {
          kind: 'modifier-generator',
          name,
          generator: child(80),
          ...(modifier && { modifier }),
        };
      }
      case 'BGSGamebryoSequenceGenerator':
        return {
          kind: 'gamebryo-sequence',
          name,
          sequence: file.string(at + 72) ?? '',
          blendMode: file.i8(at + 80),
          percent: bindable('fPercent', file.f32(at + 84)),
        };
      case 'hkbClipGenerator': {
        const triggers = file.object(at + 80);
        const list =
          triggers?.className === 'hkbClipTriggerArray'
            ? file.array(triggers.offset + 16)
            : undefined;
        return {
          kind: 'clip',
          name,
          animation: file.string(at + 72) ?? '',
          cropStart: file.f32(at + 88),
          cropEnd: file.f32(at + 92),
          startTime: bindable('startTime', file.f32(at + 96)),
          playbackSpeed: file.f32(at + 100),
          speed: bindable('playbackSpeed', file.f32(at + 100)),
          enforcedDuration: file.f32(at + 104),
          userControlledTimeFraction: bindable('userControlledTimeFraction', file.f32(at + 108)),
          mode: file.i8(at + 114),
          flags: file.i8(at + 115),
          triggers: list
            ? Array.from({ length: list.size }, (_, i): ClipTrigger => {
                const t = list.data + i * CLIP_TRIGGER_SIZE;
                return {
                  localTime: file.f32(t),
                  event: this.event(t + 8),
                  relativeToEndOfClip: file.bool(t + 24),
                  acyclic: file.bool(t + 25),
                  isAnnotation: file.bool(t + 26),
                };
              })
            : [],
        };
      }
      case 'hkbManualSelectorGenerator':
        return {
          kind: 'manual-selector',
          name,
          generators: file.objectArray(at + 72).map((object) => this.generator(object)),
          selectedGeneratorIndex: bindable('selectedGeneratorIndex', file.i8(at + 88)),
        };
      case 'BSiStateTaggingGenerator':
        return {
          kind: 'state-tagging',
          name,
          generator: child(80),
          iState: bindable('iStateToSetAs', file.i32(at + 88)),
          priority: file.i32(at + 92),
        };
      case 'BSCyclicBlendTransitionGenerator':
        return {
          kind: 'cyclic-blend',
          name,
          generator: child(80),
          freezeEvent: this.event(at + 88),
          crossBlendEvent: this.event(at + 104),
          blendParameter: bindable('fBlendParameter', file.f32(at + 120)),
          transitionDuration: file.f32(at + 124),
          blendCurve: file.i8(at + 128),
        };
      case 'BSBoneSwitchGenerator':
        return {
          kind: 'bone-switch',
          name,
          generator: child(80),
          children: file.objectArray(at + 88).flatMap((data) => {
            if (data?.className !== 'BSBoneSwitchGeneratorBoneData') return [];
            const boneWeights = this.boneWeights(file.object(data.offset + 56));
            return [
              {
                generator: this.generator(file.object(data.offset + 48)),
                ...(boneWeights && { boneWeights }),
              },
            ];
          }),
        };
      case 'BSSynchronizedClipGenerator':
        return { kind: 'synchronized-clip', name, generator: child(80) };
      case 'BSOffsetAnimationGenerator':
        return {
          kind: 'offset-animation',
          name,
          generator: child(80),
          offsetGenerator: child(96),
          offsetVariable: bindable('fOffsetVariable', file.f32(at + 104)),
          rangeStart: file.f32(at + 108),
          rangeEnd: file.f32(at + 112),
        };
      case 'hkbBehaviorReferenceGenerator':
        return { kind: 'behavior-reference', name, behavior: file.string(at + 72) ?? '' };
      case 'hkbReferencePoseGenerator':
        return { kind: 'reference-pose', name };
      default:
        return { kind: 'other', name, className: object.className };
    }
  }

  #readModifier(object: HkxObject): BehaviorModifier {
    const file = this.#file;
    const at = object.offset;
    const name = file.string(at + NODE_NAME) ?? '';
    const bindable = bindableReader(file, at);
    const base = { name, enable: bindable('enable', file.bool(at + MODIFIER_ENABLE) ? 1 : 0) };
    const sub = (offset: number): BehaviorModifier | undefined =>
      this.modifier(file.object(at + offset));
    switch (object.className) {
      case 'hkbModifierList':
        return {
          ...base,
          kind: 'list',
          modifiers: file
            .objectArray(at + 80)
            .map((child) => this.modifier(child))
            .filter((child): child is BehaviorModifier => child !== undefined),
        };
      case 'hkbEvaluateExpressionModifier': {
        const array = file.object(at + 80);
        const list =
          array?.className === 'hkbExpressionDataArray' ? file.array(array.offset + 16) : undefined;
        return {
          ...base,
          kind: 'expressions',
          expressions: list
            ? Array.from({ length: list.size }, (_, i): ExpressionData => {
                const e = list.data + i * EXPRESSION_DATA_SIZE;
                return {
                  expression: file.string(e) ?? '',
                  variable: file.i32(e + 8),
                  event: file.i32(e + 12),
                  eventMode: file.i8(e + 16),
                };
              })
            : [],
        };
      }
      case 'BSIsActiveModifier':
        return {
          ...base,
          kind: 'is-active',
          slots: [0, 1, 2, 3, 4].map((i) => ({
            output: bindable(`bIsActive${String(i)}`, file.bool(at + 80 + i * 2) ? 1 : 0),
            invert: file.bool(at + 81 + i * 2),
          })),
        };
      case 'hkbTimerModifier':
        return {
          ...base,
          kind: 'timer',
          alarmTime: bindable('alarmTimeSeconds', file.f32(at + 80)),
          alarmEvent: this.event(at + 88),
        };
      case 'hkbEventDrivenModifier':
        return {
          ...base,
          kind: 'event-driven',
          modifier: sub(80),
          activateEventId: file.i32(at + 88),
          deactivateEventId: file.i32(at + 92),
          activeByDefault: file.bool(at + 96),
        };
      case 'BSEventOnDeactivateModifier':
        return { ...base, kind: 'event-on-deactivate', event: this.event(at + 80) };
      case 'BSEventOnFalseToTrueModifier':
        return {
          ...base,
          kind: 'event-on-false-to-true',
          slots: [0, 1, 2].map((i) => ({
            enabled: bindable(`bEnableEvent${String(i + 1)}`, file.bool(at + 80 + i * 24) ? 1 : 0),
            test: bindable(`bVariableToTest${String(i + 1)}`, file.bool(at + 81 + i * 24) ? 1 : 0),
            event: this.event(at + 88 + i * 24),
          })),
        };
      case 'BSEventEveryNEventsModifier':
        return {
          ...base,
          kind: 'every-n-events',
          eventToCheckFor: this.event(at + 80),
          eventToSend: this.event(at + 96),
          count: bindable('numberOfEventsBeforeSend', file.i8(at + 112)),
          minimum: bindable('minimumNumberOfEventsBeforeSend', file.i8(at + 113)),
          randomize: file.bool(at + 114),
        };
      case 'hkbDampingModifier':
        return {
          ...base,
          kind: 'damping',
          kP: bindable('kP', file.f32(at + 80)),
          kI: bindable('kI', file.f32(at + 84)),
          kD: bindable('kD', file.f32(at + 88)),
          rawValue: bindable('rawValue', file.f32(at + 96)),
          dampedValue: bindable('dampedValue', file.f32(at + 100)),
        };
      case 'BSInterpValueModifier':
        return {
          ...base,
          kind: 'interp-value',
          source: bindable('source', file.f32(at + 80)),
          target: bindable('target', file.f32(at + 84)),
          result: bindable('result', file.f32(at + 88)),
          gain: bindable('gain', file.f32(at + 92)),
        };
      case 'BSModifyOnceModifier':
        return { ...base, kind: 'modify-once', onActivate: sub(80), onDeactivate: sub(96) };
      case 'hkbEventsFromRangeModifier': {
        const array = file.object(at + 88);
        const list =
          array?.className === 'hkbEventRangeDataArray' ? file.array(array.offset + 16) : undefined;
        return {
          ...base,
          kind: 'events-from-range',
          input: bindable('inputValue', file.f32(at + 80)),
          lowerBound: bindable('lowerBound', file.f32(at + 84)),
          ranges: list
            ? Array.from({ length: list.size }, (_, i) => {
                const r = list.data + i * EVENT_RANGE_SIZE;
                return { upperBound: file.f32(r), event: this.event(r + 8), mode: file.i8(r + 24) };
              })
            : [],
        };
      }
      case 'BSSpeedSamplerModifier':
        return {
          ...base,
          kind: 'speed-sampler',
          state: bindable('state', file.i32(at + 80)),
          direction: bindable('direction', file.f32(at + 84)),
          goalSpeed: bindable('goalSpeed', file.f32(at + 88)),
          speedOut: bindable('speedOut', file.f32(at + 92)),
        };
      default:
        return { ...base, kind: 'other', className: object.className };
    }
  }

  /** The transitions of an hkbStateMachineTransitionInfoArray. */
  #transitions(array: HkxObject | undefined): StateTransition[] {
    const file = this.#file;
    if (array?.className !== 'hkbStateMachineTransitionInfoArray') return [];
    const { data, size } = file.array(array.offset + 16);
    const interval = (i: number): TimeInterval => ({
      enterEventId: file.i32(i),
      exitEventId: file.i32(i + 4),
      enterTime: file.f32(i + 8),
      exitTime: file.f32(i + 12),
    });
    return Array.from({ length: size }, (_, i): StateTransition => {
      const at = data + i * TRANSITION_SIZE;
      const effect = file.object(at + 32);
      const condition = file.object(at + 40);
      const expression =
        condition?.className === 'hkbExpressionCondition' ||
        condition?.className === 'hkbStringCondition'
          ? file.string(condition.offset + 16)
          : undefined;
      const blending =
        effect?.className === 'hkbBlendingTransitionEffect'
          ? {
              duration: file.f32(effect.offset + 80),
              toGeneratorStartTimeFraction: file.f32(effect.offset + 84),
              flags: file.u16(effect.offset + 88),
              endMode: file.i8(effect.offset + 90),
              blendCurve: file.i8(effect.offset + 91),
              selfTransitionMode: file.i8(effect.offset + 72),
              eventMode: file.i8(effect.offset + 73),
            }
          : undefined;
      return {
        triggerInterval: interval(at),
        initiateInterval: interval(at + 16),
        eventId: file.i32(at + 48),
        toStateId: file.i32(at + 52),
        fromNestedStateId: file.i32(at + 56),
        toNestedStateId: file.i32(at + 60),
        priority: file.i16(at + 64),
        flags: file.u16(at + 66),
        conditional: condition !== undefined,
        ...(expression !== undefined && { condition: expression }),
        duration: blending?.duration ?? 0,
        ...(blending && { effect: blending }),
      };
    });
  }
}

/** Reads members of a bindable object, with the variable or property bound to each. */
function bindableReader(file: Packfile, at: number): (member: string, value: number) => Bindable {
  const bindings = readBindings(file, at);
  return (member, value) => {
    const binding = bindings.get(member);
    if (!binding) return { value };
    return binding.type === BINDING_TYPE_CHARACTER_PROPERTY
      ? { value, property: binding.index }
      : { value, variable: binding.index };
  };
}

/** Member path → bound variable (or character property) of an hkbBindable. */
function readBindings(
  file: Packfile,
  bindable: number,
): Map<string, { type: number; index: number }> {
  const result = new Map<string, { type: number; index: number }>();
  const set = file.object(bindable + BINDABLE_BINDINGS);
  if (set?.className !== 'hkbVariableBindingSet') return result;
  const { data, size } = file.array(set.offset + 16);
  for (let i = 0; i < size; i++) {
    const at = data + i * BINDING_SIZE;
    const type = file.i8(at + 33);
    if (type !== BINDING_TYPE_VARIABLE && type !== BINDING_TYPE_CHARACTER_PROPERTY) continue;
    const path = file.string(at);
    if (path !== undefined) result.set(path, { type, index: file.i32(at + 28) });
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
      case 'state-tagging':
      case 'cyclic-blend':
      case 'synchronized-clip':
      case 'bone-switch':
      case 'offset-animation':
        visit(node.generator);
        return;
      case 'manual-selector':
        visit(node.generators[resolve(node.selectedGeneratorIndex)]);
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
      case 'behavior-reference':
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
export function activeChildren(
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
  // parameter blend linearly (clamped at the ends; cyclic blends wrap from the last child to
  // the first).
  let parameter = resolve(blender.blendParameter);
  const sorted = [...weighted].sort((a, b) => a[1] - b[1]);
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!first || !last) return [];
  const cyclic = (blender.flags & BLENDER_FLAGS.isParametricBlendCyclic) !== 0;
  if (cyclic) {
    const min = blender.minCyclicBlendParameter ?? first[1];
    const max = blender.maxCyclicBlendParameter ?? last[1];
    const span = max - min;
    if (span > 0) parameter = min + ((((parameter - min) % span) + span) % span);
    if (parameter > last[1]) {
      const t = (parameter - last[1]) / (max - last[1] + (first[1] - min) || 1);
      return active([
        [last[0], 1 - t],
        [first[0], t],
      ]);
    }
    if (parameter < first[1]) {
      const t = (first[1] - parameter) / (max - last[1] + (first[1] - min) || 1);
      return active([
        [first[0], 1 - t],
        [last[0], t],
      ]);
    }
  }
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

/** A path relative to a behavior project's folder; ".." steps up (bows share weapons\bow\). */
export function projectRelative(project: string, name: string): string {
  const folder = folderOf(normalizePath(project));
  const parts: string[] = [];
  for (const part of normalizePath(folder ? `${folder}\\${name}` : name).split('\\')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  return parts.join('\\');
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
  const character = await readProjectCharacter(path, read);
  return parseBehaviorGraph(
    Packfile.parse(
      await readHavokFile(projectRelative(path, characterBehaviorFile(character)), read),
    ),
  );
}

/**
 * Reads a Havok file. A missing .hkx is looked for as a tagfile (.hkt): Creation Club and
 * resource-pack meshes name their behavior projects .hkx while only the .hkt exists, and the
 * game plays those graphs. TODO(M13): inferred from the data; confirm how the engine resolves
 * the name.
 */
export async function readHavokFile(
  path: string,
  read: (path: string) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  try {
    return await read(path);
  } catch (error) {
    if (!/\.hkx$/i.test(path)) throw error;
    try {
      return await read(path.replace(/\.hkx$/i, '.hkt'));
    } catch {
      throw error;
    }
  }
}

/** A behavior project's character file (`path` normalized). */
async function readProjectCharacter(
  path: string,
  read: (path: string) => Promise<Uint8Array>,
): Promise<Packfile> {
  const project = Packfile.parse(await readHavokFile(path, read));
  return Packfile.parse(
    await readHavokFile(projectRelative(path, projectCharacterFile(project)), read),
  );
}

/**
 * A behavior file and every file it references (hkbBehaviorReferenceGenerator), read: keyed by
 * their lower-case VFS path. `project` gives the folder the references are relative to.
 */
export async function loadBehaviorFiles(
  project: string,
  root: string,
  read: (path: string) => Promise<Uint8Array>,
): Promise<{ readonly root: BehaviorGraph; readonly files: ReadonlyMap<string, BehaviorGraph> }> {
  const files = new Map<string, BehaviorGraph>();
  const load = async (path: string): Promise<BehaviorGraph> => {
    const key = normalizePath(path);
    const known = files.get(key);
    if (known) return known;
    const graph = parseBehaviorGraph(Packfile.parse(await readHavokFile(key, read)));
    files.set(key, graph);
    const references = new Set<string>();
    const seen = new Set<object>();
    const visit = (node: BehaviorGenerator | undefined): void => {
      if (!node || seen.has(node)) return;
      seen.add(node);
      switch (node.kind) {
        case 'behavior-reference':
          references.add(node.behavior);
          return;
        case 'state-machine':
          for (const state of node.states) visit(state.generator);
          return;
        case 'blender':
          for (const child of node.children) visit(child.generator);
          return;
        case 'manual-selector':
          for (const child of node.generators) visit(child);
          return;
        case 'bone-switch':
          visit(node.generator);
          for (const child of node.children) visit(child.generator);
          return;
        case 'offset-animation':
          visit(node.generator);
          visit(node.offsetGenerator);
          return;
        case 'modifier-generator':
        case 'state-tagging':
        case 'cyclic-blend':
        case 'synchronized-clip':
          visit(node.generator);
          return;
        default:
          return;
      }
    };
    visit(graph.root);
    for (const reference of references) await load(projectRelative(project, reference));
    return graph;
  };
  return { root: await load(root), files };
}

/** What a behavior project's character names (hkbCharacterStringData), as VFS paths. */
export interface CharacterInfo {
  readonly name: string;
  /** The Havok skeleton (rigName). */
  readonly rig: string | undefined;
  /** The ragdoll skeleton (ragdollName). */
  readonly ragdoll: string | undefined;
  readonly behavior: string | undefined;
  /** Every animation the character's behaviors may play (animationNames). */
  readonly animations: readonly string[];
  /** The character properties its graphs may read (characterPropertyNames). */
  readonly properties: readonly string[];
}

/** Reads a behavior project's character: its skeleton, behavior and animations. */
export async function loadCharacterInfo(
  project: string,
  read: (path: string) => Promise<Uint8Array>,
): Promise<CharacterInfo> {
  const path = normalizePath(project);
  const character = await readProjectCharacter(path, read);
  const data = requireObject(character, 'hkbCharacterData');
  const strings = character.object(data.offset + 152);
  if (strings?.className !== 'hkbCharacterStringData') {
    throw new FormatError('hkbCharacterData without string data', data.offset);
  }
  // hkbCharacterStringData: animationNames 48, characterPropertyNames 80, name 160, rigName
  // 168, ragdollName 176, behaviorFilename 184 (paths relative to the project's folder).
  const file = (offset: number): string | undefined => {
    const name = character.string(strings.offset + offset);
    return name ? projectRelative(path, name) : undefined;
  };
  return {
    name: character.string(strings.offset + 160) ?? '',
    rig: file(168),
    ragdoll: file(176),
    behavior: file(184),
    animations: character
      .stringArray(strings.offset + 48)
      .map((name) => projectRelative(path, name)),
    properties: character.stringArray(strings.offset + 80),
  };
}
