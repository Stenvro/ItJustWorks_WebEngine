// What the headless simulation observes, as a typed log: every game event of the event hub (the
// engine's event sources), every event sent to scripts with its arguments, every story manager
// event with the quests it started, what the HUD is told, the sounds asked for, the menus that
// open, and the engine's own log lines. The presentation's ports are recording ones here: the HUD
// sink, the menus and the actors' sound output write into the log instead of a screen or a
// speaker. Conformance cases (tests/conformance/) assert on it.

import type { SoundPlace } from '../audio/sound-instance.ts';
import type { Vec3 } from '../render/math.ts';
import type { GameEventKind, GameEvents } from '../scripting/runtime/event-hub.ts';
import type { MenuRequest, QuestUpdate } from '../scripting/runtime/runtime.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { StoryEventData } from '../scripting/runtime/story-manager.ts';
import { ObjectHandle, PapyrusArray, type Value } from '../scripting/values.ts';
import type { PlacedActor } from '../shell/actors.ts';
import type { ActorSoundOutput } from '../shell/actor-sounds.ts';
import type { GameSession } from '../shell/game-session.ts';
import type { HelpMessage, HudSink, MenuSink } from '../shell/hud-signals.ts';
import { keepProblem, type LoggedProblem, type LogTone, type Terminal } from '../shell/terminal.ts';
import type { FootstepGait, FootstepGround } from '../world/footstep-records.ts';

/** A script value as logged: forms by form id (an alias with its quest's), arrays as lists. */
export type SimValue =
  | null
  | boolean
  | number
  | string
  | { readonly form: number; readonly alias?: number }
  | readonly SimValue[];

/** A game event of one kind, as the event hub told it. */
type GameRecord = {
  [K in GameEventKind]: {
    readonly kind: 'game';
    readonly at: number;
    readonly type: K;
    readonly event: GameEvents[K];
  };
}[GameEventKind];

/** One thing the simulation observed, at a time on its clock (seconds since it started). */
export type SimRecord =
  | GameRecord
  | {
      /** An event sent to an object's scripts (OnActivate, OnStoryChangeLocation, ...). */
      readonly kind: 'script';
      readonly at: number;
      readonly target: number;
      /** The quest alias the event went to, if it went to one. */
      readonly alias?: number;
      readonly event: string;
      readonly args: readonly SimValue[];
    }
  | {
      /** A story manager event once processed, and the quests it started. */
      readonly kind: 'story';
      readonly at: number;
      readonly type: string;
      readonly forms: Readonly<Record<string, number>>;
      readonly values: Readonly<Record<string, number>>;
      readonly started: readonly number[];
    }
  | {
      /** What the HUD shows as text: a notification, a location's name, a subtitle, ... */
      readonly kind: 'hud';
      readonly at: number;
      readonly type:
        'notification' | 'location' | 'discovered' | 'subtitle' | 'helpMessage' | 'loadDoor';
      readonly text: string;
    }
  | { readonly kind: 'questUpdate'; readonly at: number; readonly update: QuestUpdate }
  | {
      /** A sound asked for: a descriptor (SNDR) or a sound by editor id, where, by whom. */
      readonly kind: 'sound';
      readonly at: number;
      readonly descriptor?: number;
      readonly editorId?: string;
      readonly source: number | undefined;
      readonly position: Vec3 | undefined;
    }
  | {
      /** A spoken line's voice file played (where the speaker's head is). */
      readonly kind: 'voice';
      readonly at: number;
      readonly file: string;
      readonly position: Vec3 | undefined;
    }
  | {
      readonly kind: 'footstep';
      readonly at: number;
      readonly set: number;
      readonly tag: string;
      readonly gait: FootstepGait;
      readonly position: Vec3;
      readonly ground: FootstepGround;
    }
  | {
      /** A menu the game opened (a message box, a conversation, a container, a script's). */
      readonly kind: 'menu';
      readonly at: number;
      readonly menu: string;
      readonly text?: string;
      readonly buttons?: readonly string[];
      readonly reference?: number;
    };

export type SimRecordKind = SimRecord['kind'];

/** Every kind of game event (the record makes the list complete: a new kind must be added). */
const GAME_EVENT_KINDS: Readonly<Record<GameEventKind, true>> = {
  activate: true,
  activeEffectApplyRemove: true,
  actorLocationChange: true,
  bookRead: true,
  cellAttachDetach: true,
  cellFullyLoaded: true,
  combat: true,
  containerChanged: true,
  death: true,
  destructionStageChanged: true,
  enterBleedout: true,
  equip: true,
  fastTravelEnd: true,
  furniture: true,
  grabRelease: true,
  hit: true,
  loadGame: true,
  locationCleared: true,
  lockChanged: true,
  magicEffectApply: true,
  magicWardHit: true,
  moveAttachDetach: true,
  objectLoaded: true,
  objectTranslation: true,
  openClose: true,
  package: true,
  perkEntryRun: true,
  playerBowShot: true,
  questInit: true,
  questStage: true,
  questStartStop: true,
  reset: true,
  scene: true,
  sell: true,
  sleep: true,
  spellCast: true,
  switchRaceComplete: true,
  topicInfo: true,
  trackedStats: true,
  trapHit: true,
  trigger: true,
  triggerEnterLeave: true,
  wait: true,
};

/** A logged script value (see SimValue). */
export function simValue(value: Value): SimValue {
  if (value instanceof ObjectHandle) {
    return value.alias >= 0 ? { form: value.formId, alias: value.alias } : { form: value.formId };
  }
  if (value instanceof PapyrusArray) return value.items.map(simValue);
  return value;
}

/** Where a sound place is now (a point, or a point that follows something). */
function placeNow(place: SoundPlace): Vec3 | undefined {
  if (place === undefined) return undefined;
  const at = typeof place === 'function' ? place() : place;
  return [at[0], at[1], at[2]];
}

/** The engine's log lines, kept (Terminal for the simulation). */
export class SimTerminal implements Terminal {
  readonly lines: { readonly tag: string; readonly text: string; readonly tone: LogTone }[] = [];
  readonly problems: LoggedProblem[] = [];
  /** Also prints warnings and errors (a tool's run). */
  echo = false;

  log(tag: string, text: string, tone: LogTone = 'info'): void {
    keepProblem(this.problems, tag, text, tone);
    this.lines.push({ tag, text, tone });
    if (this.lines.length > 20_000) this.lines.splice(0, 10_000);
    if (this.echo && (tone === 'warn' || tone === 'error')) console.warn(`[${tag}] ${text}`);
  }
}

/**
 * The simulation's log: it listens to the runtime and the session, and is the HUD, the menus and
 * the actors' sound output (the recording ports).
 */
export class SimLog {
  readonly records: SimRecord[] = [];
  /** The simulation's clock (seconds), stamped on every record. */
  clock: () => number = () => 0;
  /** The buttons message boxes answer with, in order (then the first button). */
  readonly answers: number[] = [];

  /** Every record of a kind. */
  of<K extends SimRecordKind>(kind: K): Extract<SimRecord, { readonly kind: K }>[] {
    return this.records.filter(
      (record): record is Extract<SimRecord, { readonly kind: K }> => record.kind === kind,
    );
  }

  /** Every game event of a type, as the hub told it. */
  game<K extends GameEventKind>(type: K): GameEvents[K][] {
    const events: GameEvents[K][] = [];
    for (const record of this.records) {
      if (record.kind === 'game' && record.type === type)
        events.push(record.event as GameEvents[K]);
    }
    return events;
  }

  /** Records from a time on (seconds on the simulation's clock). */
  since(at: number): SimRecord[] {
    return this.records.filter((record) => record.at >= at);
  }

  #push(record: SimRecord): void {
    this.records.push(record);
  }

  /** Listens to a runtime: its event hub, the events its VM sends, its story manager. */
  attachRuntime(runtime: ScriptRuntime): void {
    for (const type of Object.keys(GAME_EVENT_KINDS) as GameEventKind[])
      this.#listen(runtime, type);
    runtime.vm.onEventSent = (target, event, args) => {
      this.#push({
        kind: 'script',
        at: this.clock(),
        target: target.formId,
        ...(target.alias >= 0 && { alias: target.alias }),
        event,
        args: args.map(simValue),
      });
    };
    runtime.storyManager.onProcessed = (event: StoryEventData, started) => {
      this.#push({
        kind: 'story',
        at: this.clock(),
        type: event.type,
        forms: Object.fromEntries(event.forms),
        values: Object.fromEntries(event.values),
        started: [...started],
      });
    };
  }

  #listen(runtime: ScriptRuntime, type: GameEventKind): void {
    runtime.events.on(type, (event) => {
      // The record's type and event belong together (the union is keyed by the kind).
      const record = { kind: 'game', at: this.clock(), type, event } as GameRecord;
      this.#push(record);
    });
  }

  /** Listens to a session: the sounds asked for; the HUD and menus are this log. */
  attachSession(session: GameSession): void {
    session.soundRequests.add(({ descriptor, place, source }) => {
      this.#push({
        kind: 'sound',
        at: this.clock(),
        descriptor,
        source,
        position: placeNow(place),
      });
    });
    session.hud.sink = this.hud;
    session.hud.menus = this.menus;
  }

  /** A voice line was played (src/sim/headless-voices.ts). */
  voice(file: string, place: SoundPlace): void {
    this.#push({ kind: 'voice', at: this.clock(), file, position: placeNow(place) });
  }

  /** The recording HUD. */
  readonly hud: HudSink = {
    target: () => undefined,
    notification: (text) => {
      this.#push({ kind: 'hud', at: this.clock(), type: 'notification', text });
    },
    questUpdate: (update) => {
      this.#push({ kind: 'questUpdate', at: this.clock(), update });
    },
    helpMessage: (message: HelpMessage) => {
      this.#push({ kind: 'hud', at: this.clock(), type: 'helpMessage', text: message.text });
    },
    resetHelpMessage: () => undefined,
    userEvent: () => undefined,
    mode: () => undefined,
    shown: () => undefined,
    subtitle: (text) => {
      if (text !== undefined) this.#push({ kind: 'hud', at: this.clock(), type: 'subtitle', text });
    },
    location: (name) => {
      this.#push({ kind: 'hud', at: this.clock(), type: 'location', text: name });
    },
    discovered: (name) => {
      this.#push({ kind: 'hud', at: this.clock(), type: 'discovered', text: name });
    },
    loadDoor: (text) => {
      if (text !== undefined) this.#push({ kind: 'hud', at: this.clock(), type: 'loadDoor', text });
    },
  };

  /**
   * The recording menus: a message box answers with the next of `answers` (else its first
   * button); the others are logged and close at once. TODO(sim): the dialogue, container,
   * barter, gift and training menus have no headless runner yet: a conversation or a trade a
   * test needs is driven through the runtime's dialogue and inventory directly.
   */
  readonly menus: MenuSink = {
    messageBox: (text, buttons) => {
      this.#push({ kind: 'menu', at: this.clock(), menu: 'MessageBoxMenu', text, buttons });
      return Promise.resolve(this.answers.shift() ?? 0);
    },
    userEvent: () => undefined,
    talk: (speaker: PlacedActor) => {
      this.#push({
        kind: 'menu',
        at: this.clock(),
        menu: 'Dialogue Menu',
        reference: speaker.actor.reference,
      });
    },
    container: (reference, closed) => {
      this.#push({ kind: 'menu', at: this.clock(), menu: 'ContainerMenu', reference });
      closed();
    },
    open: (request: MenuRequest) => {
      this.#push({
        kind: 'menu',
        at: this.clock(),
        menu: request.name,
        ...('actor' in request && request.actor !== undefined && { reference: request.actor }),
      });
      return Promise.resolve(0);
    },
    fastTravel: (destination) => {
      this.#push({ kind: 'menu', at: this.clock(), menu: 'FastTravel', reference: destination });
    },
  };

  /** The actors' sound output (their footsteps and the sounds their graphs play). */
  readonly actorSounds: ActorSoundOutput = {
    footstep: (set, tag, gait, position, ground) => {
      this.#push({
        kind: 'footstep',
        at: this.clock(),
        set,
        tag,
        gait,
        position: [position[0], position[1], position[2]],
        ground,
      });
      return Promise.resolve(true);
    },
    playNamed: (editorId, place, source) => {
      this.#push({
        kind: 'sound',
        at: this.clock(),
        editorId,
        source,
        position: placeNow(place),
      });
      return Promise.resolve(undefined);
    },
  };
}
