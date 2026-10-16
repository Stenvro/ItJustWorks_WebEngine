// Scenes (SCEN): a quest's staged conversations and actions. A scene runs its phases in order;
// each phase starts when its start conditions hold and completes when its actions are done
// and its completion conditions hold. Its actors are aliases of its quest; its actions span a
// range of phases: a line of dialogue (a topic said by an actor), packages an actor runs, or a
// timer. Platform-independent.
// Layout: docs/formats/esm.md ("Scenes"), after xEdit's SCEN definition and CommonLibSSE's
// BGSScene / BGSSceneAction*.

import { view } from '../formats/esm/fields.ts';
import { parseVmad, type ScriptAttachments } from '../formats/esm/vmad.ts';
import { conditionAt, type Condition } from '../scripting/conditions.ts';
import type { GameRecord } from '../world/record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'formIdAt'>;

/** SCEN FNAM flags. */
export const SceneFlag = {
  beginOnQuestStart: 0x1,
  stopQuestOnEnd: 0x2,
  showAllText: 0x4,
  repeatConditionsWhileTrue: 0x8,
  interruptible: 0x10,
} as const;

/** An actor's LNAM flags (the last two after CommonLibSSE; xEdit names only the first two). */
export const SceneActorFlag = {
  noPlayerActivation: 0x1,
  optional: 0x2,
  runOnlyScenePackages: 0x4,
  noCommandState: 0x8,
} as const;

/** An actor's DNAM behaviour flags: what death, combat, dialogue, observed combat do. */
export const SceneActorBehaviour = {
  /** Unused. */
  deathPause: 0x1,
  deathEnd: 0x2,
  combatPause: 0x4,
  combatEnd: 0x8,
  dialoguePause: 0x10,
  dialogueEnd: 0x20,
  observeCombatPause: 0x40,
  observeCombatEnd: 0x80,
} as const;

/** An action's FNAM flags. */
export const SceneActionFlag = {
  faceTarget: 0x8000,
  looping: 0x10000,
  headtrackPlayer: 0x20000,
} as const;

/** VNAM: the actor behaviour the scene sets for all its actors, per event. */
export const SceneBehaviourSetting = {
  setAllNormal: 0,
  setAllPause: 1,
  setAllEnd: 2,
  dontSetAll: 3,
} as const;

/** A phase: HNAM, NAM0, start conditions, NEXT, completion conditions, NEXT, WNAM, HNAM. */
export interface ScenePhase {
  /** NAM0: its name in the Creation Kit (often empty). */
  readonly name: string;
  /** CTDA before the first NEXT: when the phase may start. */
  readonly startConditions: readonly Condition[];
  /** CTDA after it: when it completes (with its actions done). */
  readonly completionConditions: readonly Condition[];
  /** WNAM: its width in the Creation Kit's scene editor. */
  readonly editorWidth: number;
}

/**
 * An actor's behaviour without a DNAM (156 vanilla actors of early scenes have only their
 * ALID): xEdit's default for a new actor, death end, combat end, dialogue pause.
 */
export const DEFAULT_ACTOR_BEHAVIOUR =
  SceneActorBehaviour.deathEnd | SceneActorBehaviour.combatEnd | SceneActorBehaviour.dialoguePause;

/** An actor: an alias of the scene's quest. */
export interface SceneActor {
  /** ALID: the alias id. */
  readonly alias: number;
  /** LNAM: SceneActorFlag. */
  readonly flags: number;
  /** DNAM: SceneActorBehaviour (DEFAULT_ACTOR_BEHAVIOUR without one). */
  readonly behaviour: number;
}

interface SceneActionBase {
  /** NAM0: its name in the Creation Kit (often empty). */
  readonly name: string;
  /** ALID: the actor (alias id) whose row it is on in the Creation Kit (timers too). */
  readonly alias: number;
  /** INAM: its index (unique in the scene; the scene's INAM is the last given). */
  readonly index: number;
  /** FNAM: SceneActionFlag. */
  readonly flags: number;
  /** SNAM / ENAM: the phases it starts and ends in (indices into `phases`). */
  readonly startPhase: number;
  readonly endPhase: number;
  /** LNAM: undocumented (xEdit: unknown); no vanilla action has one. */
  readonly unknown: number | undefined;
}

/** A line: the actor says one of the topic's infos. */
export interface SceneDialogueAction extends SceneActionBase {
  readonly type: 'dialogue';
  /** DATA: the topic (DIAL); undefined: none (the actor only looks at its headtrack target). */
  readonly topic: number | undefined;
  /** HTID: the actor (alias id) it looks at; −1 none. */
  readonly headtrackAlias: number;
  /** DMAX / DMIN: with SceneActionFlag.looping, the most and least seconds between lines. */
  readonly loopingMax: number;
  readonly loopingMin: number;
  /**
   * DEMO / DEVA: its emotion (0 neutral, 1 anger, 2 disgust, 3 fear, 4 sad, 5 happy, 6
   * surprise, 7 puzzled) and its value.
   */
  readonly emotion: number;
  readonly emotionValue: number;
}

/** Packages the actor runs while the action lasts. */
export interface ScenePackageAction extends SceneActionBase {
  readonly type: 'package';
  /** PNAM: the packages (PACK), in order. */
  readonly packages: readonly number[];
}

/** A wait. */
export interface SceneTimerAction extends SceneActionBase {
  readonly type: 'timer';
  /** SNAM (the second): its length in seconds. */
  readonly seconds: number;
}

export type SceneAction = SceneDialogueAction | ScenePackageAction | SceneTimerAction;

/** VNAM: SceneBehaviourSetting per event. */
export interface SceneBehaviourSettings {
  readonly death: number;
  readonly combat: number;
  readonly dialogue: number;
  readonly observeCombat: number;
}

export interface SceneRecord {
  readonly formId: number;
  readonly editorId: string;
  /** FNAM: SceneFlag. */
  readonly flags: number;
  readonly phases: readonly ScenePhase[];
  readonly actors: readonly SceneActor[];
  readonly actions: readonly SceneAction[];
  /** PNAM: the quest it belongs to; its actors are this quest's aliases. */
  readonly quest: number | undefined;
  /** INAM: the last action index given. */
  readonly lastActionIndex: number;
  readonly behaviourSettings: SceneBehaviourSettings | undefined;
  /** CTDA after the rest: when the scene may start. */
  readonly conditions: readonly Condition[];
  /**
   * VMAD: its scripts and fragments (`fragments`: begin / end of the scene;
   * `phaseFragments`: per phase); undefined without one or when it is corrupt.
   */
  readonly scripts: ScriptAttachments | undefined;
}

/** ANAM action types. */
const ACTION_TYPES = ['dialogue', 'package', 'timer'] as const;

const decodeName = (data: Uint8Array): string => {
  const end = data.indexOf(0);
  return String.fromCharCode(...data.subarray(0, end < 0 ? data.length : end));
};

interface OpenAction {
  type: number;
  name: string;
  alias: number;
  index: number;
  flags: number;
  startPhase: number;
  endPhase: number;
  /** ENAM seen: a later SNAM is a timer's seconds. */
  ended: boolean;
  unknown: number | undefined;
  topic: number | undefined;
  headtrackAlias: number;
  loopingMax: number;
  loopingMin: number;
  emotion: number;
  emotionValue: number;
  packages: number[];
  seconds: number;
}

function closeAction(action: OpenAction): SceneAction | undefined {
  const type = ACTION_TYPES[action.type];
  const base: SceneActionBase = {
    name: action.name,
    alias: action.alias,
    index: action.index,
    flags: action.flags,
    startPhase: action.startPhase,
    endPhase: action.endPhase,
    unknown: action.unknown,
  };
  switch (type) {
    case 'dialogue':
      return {
        ...base,
        type,
        topic: action.topic,
        headtrackAlias: action.headtrackAlias,
        loopingMax: action.loopingMax,
        loopingMin: action.loopingMin,
        emotion: action.emotion,
        emotionValue: action.emotionValue,
      };
    case 'package':
      return { ...base, type, packages: action.packages };
    case 'timer':
      return { ...base, type, seconds: action.seconds };
    default:
      return undefined;
  }
}

export function parseScene(record: RecordSource): SceneRecord {
  const fields = record.fields.list;
  const u32 = (data: Uint8Array): number | undefined =>
    data.length >= 4 ? view(data).getUint32(0, true) : undefined;
  const i32 = (data: Uint8Array): number | undefined =>
    data.length >= 4 ? view(data).getInt32(0, true) : undefined;
  const f32 = (data: Uint8Array): number | undefined =>
    data.length >= 4 ? view(data).getFloat32(0, true) : undefined;
  const form = (data: Uint8Array): number | undefined => {
    if (data.length < 4) return undefined;
    const id = record.formIdAt(data, 0);
    return id === 0 ? undefined : id;
  };

  let flags = 0;
  const phases: ScenePhase[] = [];
  const actors: SceneActor[] = [];
  const actions: SceneAction[] = [];
  const conditions: Condition[] = [];
  let quest: number | undefined;
  let lastActionIndex = 0;
  let behaviourSettings: SceneBehaviourSettings | undefined;
  // The phase being read, and how many NEXT markers it has had (0: start conditions).
  let phase:
    | {
        name: string;
        startConditions: Condition[];
        completionConditions: Condition[];
        editorWidth: number;
        next: number;
      }
    | undefined;
  let actor: { alias: number; flags: number; behaviour: number } | undefined;
  let action: OpenAction | undefined;
  const closeActor = (): void => {
    if (actor) actors.push(actor);
    actor = undefined;
  };
  const endPhase = (): void => {
    if (phase) {
      const { name, startConditions, completionConditions, editorWidth } = phase;
      phases.push({ name, startConditions, completionConditions, editorWidth });
    }
    phase = undefined;
  };
  const endAction = (): void => {
    const done = action && closeAction(action);
    if (done) actions.push(done);
    action = undefined;
  };
  /** ANAM: an action of its type (u16) starts; an empty one ends it. */
  const startAction = (data: Uint8Array): void => {
    endAction();
    if (data.length < 2) return;
    action = {
      type: view(data).getUint16(0, true),
      name: '',
      alias: -1,
      index: 0,
      flags: 0,
      startPhase: 0,
      endPhase: 0,
      ended: false,
      unknown: undefined,
      topic: undefined,
      headtrackAlias: -1,
      loopingMax: 0,
      loopingMin: 0,
      emotion: 0,
      emotionValue: 0,
      packages: [],
      seconds: 0,
    };
  };

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const { type, data } = field;
    // Leftovers of earlier Creation Kit versions (SCHR, SCDA, SCTX, QNAM, SCRO) are skipped.
    if (phase) {
      switch (type) {
        case 'NAM0':
          phase.name = decodeName(data);
          break;
        case 'CTDA': {
          const condition = conditionAt(fields, i, record);
          if (condition) {
            (phase.next === 0 ? phase.startConditions : phase.completionConditions).push(condition);
          }
          break;
        }
        case 'NEXT':
          phase.next++;
          break;
        case 'WNAM':
          phase.editorWidth = u32(data) ?? 0;
          break;
        case 'HNAM':
          endPhase();
          break;
      }
      continue;
    }
    if (action) {
      switch (type) {
        case 'ANAM':
          startAction(data);
          break;
        case 'NAM0':
          action.name = decodeName(data);
          break;
        case 'ALID':
          action.alias = i32(data) ?? -1;
          break;
        case 'LNAM':
          action.unknown = u32(data);
          break;
        case 'INAM':
          action.index = u32(data) ?? 0;
          break;
        case 'FNAM':
          action.flags = u32(data) ?? 0;
          break;
        case 'SNAM':
          if (action.ended) action.seconds = f32(data) ?? 0;
          else action.startPhase = u32(data) ?? 0;
          break;
        case 'ENAM':
          action.endPhase = u32(data) ?? 0;
          action.ended = true;
          break;
        case 'DATA':
          action.topic = form(data);
          break;
        case 'HTID':
          action.headtrackAlias = i32(data) ?? -1;
          break;
        case 'DMAX':
          action.loopingMax = f32(data) ?? 0;
          break;
        case 'DMIN':
          action.loopingMin = f32(data) ?? 0;
          break;
        case 'DEMO':
          action.emotion = u32(data) ?? 0;
          break;
        case 'DEVA':
          action.emotionValue = u32(data) ?? 0;
          break;
        case 'PNAM': {
          const pack = form(data);
          if (pack !== undefined) action.packages.push(pack);
          break;
        }
      }
      continue;
    }
    switch (type) {
      case 'FNAM':
        flags = u32(data) ?? 0;
        break;
      case 'HNAM':
        closeActor();
        phase = {
          name: '',
          startConditions: [],
          completionConditions: [],
          editorWidth: 0,
          next: 0,
        };
        break;
      case 'ALID':
        closeActor();
        actor = { alias: i32(data) ?? -1, flags: 0, behaviour: DEFAULT_ACTOR_BEHAVIOUR };
        break;
      case 'LNAM':
        if (actor) actor.flags = u32(data) ?? 0;
        break;
      case 'DNAM':
        if (actor) actor.behaviour = u32(data) ?? 0;
        break;
      case 'ANAM':
        closeActor();
        startAction(data);
        break;
      case 'PNAM':
        closeActor();
        quest = form(data);
        break;
      case 'INAM':
        lastActionIndex = u32(data) ?? 0;
        break;
      case 'VNAM':
        if (data.length >= 16) {
          const v = view(data);
          behaviourSettings = {
            death: v.getUint32(0, true),
            combat: v.getUint32(4, true),
            dialogue: v.getUint32(8, true),
            observeCombat: v.getUint32(12, true),
          };
        }
        break;
      case 'CTDA': {
        closeActor();
        const condition = conditionAt(fields, i, record);
        if (condition) conditions.push(condition);
        break;
      }
    }
  }
  endPhase();
  closeActor();
  endAction();
  const vmad = record.fields.first('VMAD');
  let scripts: ScriptAttachments | undefined;
  if (vmad) {
    try {
      scripts = parseVmad(vmad, 'SCEN');
    } catch {
      scripts = undefined;
    }
  }
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    flags,
    phases,
    actors,
    actions,
    quest,
    lastActionIndex,
    behaviourSettings,
    conditions,
    scripts,
  };
}
