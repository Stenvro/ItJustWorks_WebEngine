// The game's console commands (the ~ console, src/shell/console-menu.ts): a line (read by
// src/shell/console-parse.ts) names a command of the game's table (src/shell/console-table.ts)
// by its name or short name, with its parameters, and for a reference function the reference
// it acts on: the one before the dot ("player.additem f 100", "0001a694.disable"), else the
// one selected (prid, or a click on the world while the console is open). Parameters are read
// by their types as the game's script compiler reads them: a form by editor id or form id
// (its load order prefix included), a reference by editor id, form id or "player"; what it
// cannot read it reports as the game does ("Item 'x' not found for parameter ObjectID.",
// "Missing parameter Count."). Each command does what the game's does through the engine's own
// systems, the Papyrus natives where there is one (the same native the scripts call), and
// prints what the game prints (its formats observed in the original: "God Mode enabled.",
// "GetStage >> 10.00", ...). A command the engine cannot do yet says so as the game says it of
// a function it does not support ("This function not supported"), never pretending.
// Notes: docs/ui.md ("The console").

import { ConditionRunOn, NOT_VALUED, type Condition } from '../scripting/conditions.ts';
import type { NativeCall } from '../scripting/papyrus-vm.ts';
import { conditionFunctionValue } from '../scripting/runtime/condition-values.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { referenceName } from '../scripting/runtime/quest-text.ts';
import type { Placement, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ObjectHandle, PapyrusArray, type Value } from '../scripting/values.ts';
import { actorValueIndex } from '../world/actor-values.ts';
import type { GameSettings } from '../world/game-settings.ts';
import { ITEM_TYPES } from '../world/item-records.ts';
import { MapMarkerFlag, readMapMarkers } from '../world/map-markers.ts';
import type { QuestRecord } from '../world/quest-records.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import { parseSpell, SpellType } from '../world/spell-records.ts';
import { cellPlacement, gridPlacement } from './cell-placement.ts';

import {
  conditionLine,
  mathFunction,
  NATIVE_FUNCTIONS,
  referenceLine,
  type NativeArgument,
  type NativeFunction,
} from './console-script-functions.ts';
import { parseAxis, parseConsoleLine, parseConsoleNumber, parseFormId } from './console-parse.ts';
import {
  CONSOLE_COMMANDS,
  consoleCommand,
  type ConsoleCommandInfo,
  type ConsoleParam,
  type ConsoleParamType,
} from './console-table.ts';

import {
  globalLine,
  hex8,
  PAPYRUS_HEADER,
  questStateLines,
  registrationLines,
  scriptsLines,
} from './console-papyrus.ts';

export { parseConsoleLine } from './console-parse.ts';

/** A quest target as movetoqt and sqt take it: its quest, its reference and where that is. */
export interface QuestTargetEntry {
  readonly quest: number;
  readonly reference: number;
  readonly placement?: Placement;
}

/** What the commands act on. */
export interface ConsoleContext {
  readonly runtime: ScriptRuntime;
  readonly db: RecordDatabase;
  /** Takes the player to a place. */
  travel(at: Placement): Promise<void>;
  /** Shows or hides the game's menus and HUD (tm); whether they are shown now. */
  toggleMenus(): boolean;
  /** Forces a weather at once (fw <weather> [override]). */
  forceWeather(weather: number, override: boolean): void;
  /** Makes a weather active with a change (sw <weather> [override]). */
  setWeather(weather: number, override: boolean): void;
  /** Lets the regions choose the weather again (rwo). */
  releaseWeatherOverride(): void;
  /** Turns the sky off or on again (ts); whether it is on now. */
  toggleSky(): boolean;
  /** Opens the race menu (showracemenu). */
  showRaceMenu(): void;
  /** The player's controls changed (epc, dpc). */
  controlsChanged(): void;
  /** Quits the game (qqq). */
  quit(): void;
  /** The player's collision (tcl) off or on again; whether it is on now. */
  toggleCollision?(): boolean;
  /** The free camera (tfc) on or off again; whether it is on now. */
  toggleFreeCamera?(): boolean;
  /** Grass (tg) hidden or shown again; whether it is shown now. */
  toggleGrass?(): boolean;
  /** The field of view (fov): the world's and first person's, degrees. */
  setFov?(world: number, firstPerson: number): void;
  /** The game settings the session's systems read (setgs changes them there too). */
  gameSettings?(): Promise<GameSettings>;
  /** The active quests' targets (movetoqt). */
  questTargets?(): Promise<readonly QuestTargetEntry[]>;
  /**
   * The load door toward a quest target (sqt): the door, 'same' when the target is in the
   * player's space, 'unreachable' when no way there is found.
   */
  questTargetDoor?(target: QuestTargetEntry): Promise<number | 'same' | 'unreachable'>;
  /** Clears the console's history (clear). */
  clear?(): void;
  /** The renderer's switches (tll: distant LOD, tt: trees, tws: water); whether it is on now. */
  toggleRenderer?(what: 'lod' | 'trees' | 'water'): boolean;
  /** Opens the container menu of a container (openactorcontainer on one). */
  openContainer?(reference: number): void;
  /** The world held still or going again (tfc 1). */
  freezeWorld?(frozen: boolean): void;
  /** The reference under a point of the frame (see ConsoleRunner.click). */
  pick?(x: number, y: number, aspect: number): number | undefined;
  /** Saves the game under a name (save <name>). */
  saveGame?(name: string): Promise<void>;
  /** Loads a save by its name (load <name>); whether there is one. */
  loadGame?(name: string): Promise<boolean>;
  /** Opens or closes a menu by its name (ShowMenu, HideMenu); whether there is one. */
  showMenu?(name: string, shown: boolean): boolean;
  /** An INI setting ("fJumpHeightMin:Movement") as the session reads it, if there is one. */
  iniSetting?(name: string): number | undefined;
  /** Sets an INI setting for the session; whether there is one. */
  setIniSetting?(name: string, value: number): boolean;
}

/** The types help searches, and those a form's editor id is looked up in. */
const SEARCHED = [
  ...ITEM_TYPES,
  'QUST',
  'GLOB',
  'NPC_',
  'SPEL',
  'PERK',
  'WTHR',
  'CELL',
  'FACT',
  'SHOU',
  'WOOP',
  'RACE',
  'WRLD',
  'FLST',
  'LVLI',
  'LVLN',
  'ENCH',
  'MGEF',
  'ACTI',
  'TACT',
  'STAT',
  'MSTT',
  'FURN',
  'DOOR',
  'CONT',
  'TREE',
  'FLOR',
  'IDLM',
  'EXPL',
  'HAZD',
  'ARTO',
  // The other record types the game's parameters take (src/shell/console-table.ts).
  'SNDR',
  'SOUN',
  'DIAL',
  'CLAS',
  'PACK',
  'CSTY',
  'EFSH',
  'IMAD',
  'IMGS',
  'VTYP',
  'ECZN',
  'IDLE',
  'MESG',
  'EQUP',
  'MUSC',
  'KYWD',
  'LCRT',
  'LCTN',
  'SCEN',
  'ASTP',
  'RFCT',
  'SNCT',
  'REGN',
  'AACT',
  'LIGH',
  'SCRL',
] as const;

/** Record types of placed references. */
const REFERENCE_TYPES = new Set([
  'REFR',
  'ACHR',
  'PGRE',
  'PMIS',
  'PHZD',
  'PARW',
  'PBAR',
  'PBEA',
  'PCON',
  'PFLA',
]);

/** Tamriel (Skyrim.esm): coe's worldspace from an interior. */
const TAMRIEL = 0x3c;

/** The last line of a script compiler error, as the console prints it. */
const NOT_SAVED = 'Compiled script not saved!';
/** What the game prints for a function it does not support. */
const NOT_SUPPORTED = 'This function not supported';

/** EquipItemEx's slot of a casting source parameter's hand (0 left, 1 right): 2 left, 1 right. */
function handOfSource(source: number): number | undefined {
  return source === 1 ? 1 : source === 0 ? 2 : undefined;
}

/** EquipItemEx's slot of a hand the console names: 1 right, 2 left. */
export function handSlot(hand: string): number | undefined {
  const lower = hand.toLowerCase();
  if (lower === 'right') return 1;
  if (lower === 'left') return 2;
  return undefined;
}

/**
 * Where PlaceAtMe's distance puts a reference from its placer facing `heading` degrees (0 north,
 * clockwise): direction 0 in front, 1 behind, 2 to the left, 3 to the right.
 */
export function placementOffset(
  heading: number,
  distance: number,
  direction: number,
): [number, number] {
  const turn = [0, 180, -90, 90][direction] ?? 0;
  const angle = ((heading + turn) * Math.PI) / 180;
  return [distance * Math.sin(angle), distance * Math.cos(angle)];
}

const onOff = (on: boolean): string => (on ? 'On' : 'Off');
const fixed = (value: number): string => value.toFixed(2);
const hex = (formId: number): string => formId.toString(16).toUpperCase().padStart(8, '0');

/** SetRace's parameter, for its message when the race is not found. */
const RACE_PARAM: ConsoleParam = { name: 'String', type: { kind: 'string' }, code: 0 };

/** An INI setting's value as GetINISetting prints it, by its name's type letter. */
function iniValue(name: string, value: number): string {
  const letter = name.charAt(0).toLowerCase();
  if (letter === 'i' || letter === 'b') return String(Math.trunc(value));
  if (letter === 'u') return String(Math.trunc(value) >>> 0);
  return value.toFixed(2);
}

/** A float as the condition's integer parameter holds it (its bits). */
function floatBits(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  return view.getInt32(0, true);
}

/**
 * The condition a script function's parameters make: the first two as its parameters (a form
 * by its id, an axis by its letter's code, an actor value by its index, a float by its bits),
 * text as its strings, run on the reference.
 */
export function consoleCondition(info: ConsoleCommandInfo, args: readonly Arg[]): Condition {
  const raw = (index: number): number => {
    const param = info.params[index];
    const value = args[index];
    if (param === undefined || value === undefined) return 0;
    if (param.type.kind === 'axis' && typeof value === 'number') return 0x58 + value;
    if (param.type.kind === 'actorValue' && typeof value === 'string')
      return actorValueIndex(value) ?? 0;
    if (param.type.kind === 'float' && typeof value === 'number') return floatBits(value);
    return typeof value === 'number' ? value : 0;
  };
  const strings = args.filter((value): value is string => typeof value === 'string');
  return {
    function: info.condition ?? 0,
    operator: 0,
    or: false,
    comparand: 0,
    form: raw(0),
    raw1: raw(0),
    param2: raw(1),
    form2: raw(1),
    strings,
    runOn: ConditionRunOn.subject,
    reference: 0,
    param3: -1,
    eventMember: '',
  };
}

/** A casting source parameter's words (0 left hand, 1 right hand, 2 voice, 3 instant). */
const CASTING_SOURCES = ['left', 'right', 'voice', 'instant'];

/** A parameter's value as read: a number (a form, reference, number, axis, sex) or text. */
type Arg = number | string | undefined;

interface NamedForm {
  readonly formId: number;
  readonly type: string;
  readonly editorId: string;
  readonly name: string;
}

/** A command as it runs: the reference it acts on and its parameters. */
interface Invocation {
  readonly info: ConsoleCommandInfo;
  /** The reference before the dot, else the one selected. */
  readonly self: number | undefined;
  readonly args: readonly Arg[];
  /** The parameters as typed. */
  readonly typed: readonly string[];
}

export class ConsoleCommands {
  readonly #context: ConsoleContext;
  /** Editor ids of the searched types, lowercase, read once. */
  #names: Promise<Map<string, NamedForm>> | undefined;
  /** Editor ids of the persistent references, lowercase, read once. */
  #references: Promise<Map<string, number>> | undefined;
  /** The reference selected (prid, a click). */
  #selected: number | undefined;
  /** The console's scope quest (ssq): its aliases may be named as references. */
  #scope: number | undefined;

  constructor(context: ConsoleContext) {
    this.#context = context;
  }

  /** The reference the console has selected, if any. */
  get selected(): number | undefined {
    return this.#selected;
  }

  /** Runs a line; resolves to what it prints. */
  async run(line: string): Promise<string[]> {
    const parsed = parseConsoleLine(line);
    if (parsed.command === '') return [];
    if (parsed.error) return [parsed.error];
    // The script language's set statement: set <global> to <value>.
    if (parsed.command === 'set' && parsed.reference === undefined) return this.#set(parsed.args);
    const info = consoleCommand(parsed.command);
    if (!info) return [`Script command "${parsed.typed}" not found.`];
    let self = this.#selected;
    if (parsed.reference !== undefined) {
      self = await this.#reference(parsed.reference);
      if (self === undefined) return [`Unknown referenced object '${parsed.reference}'.`];
    }
    if (info.reference && self === undefined) return ['No Reference Selected'];
    const args: Arg[] = [];
    for (const [index, param] of info.params.entries()) {
      const text = parsed.args[index];
      if (text === undefined) {
        if (!param.optional) return [`Missing parameter ${param.name}.`, NOT_SAVED];
        args.push(undefined);
        continue;
      }
      const value = await this.#arg(param.type, text);
      if (value === undefined) return this.#notFound(text, param);
      args.push(value);
    }
    return this.#execute({ info, self, args, typed: parsed.args });
  }

  /** A click on the world below the console: the reference there is selected (as prid). */
  click(x: number, y: number, aspect: number): Promise<string[]> {
    const picked = this.#context.pick?.(x, y, aspect);
    if (picked === undefined) return Promise.resolve([]);
    return this.#pick(picked);
  }

  #notFound(text: string, param: ConsoleParam): string[] {
    return [`Item '${text}' not found for parameter ${param.name}.`, NOT_SAVED];
  }

  // --- Reading parameters --------------------------------------------------------------------

  async #arg(type: ConsoleParamType, text: string): Promise<Arg> {
    switch (type.kind) {
      case 'string':
        return text;
      case 'int': {
        const value = parseConsoleNumber(text);
        return value === undefined ? undefined : Math.trunc(value);
      }
      case 'float':
        return parseConsoleNumber(text);
      case 'axis':
        return parseAxis(text);
      case 'actorValue':
        return actorValueIndex(text) === undefined ? undefined : text;
      case 'sex': {
        const sex = text.toLowerCase();
        return sex === 'male' ? 0 : sex === 'female' ? 1 : undefined;
      }
      case 'castingSource': {
        const source = CASTING_SOURCES.indexOf(text.toLowerCase());
        return source < 0 ? undefined : source;
      }
      case 'reference':
        return this.#reference(text);
      case 'form':
        return this.#form(text, type.types);
    }
  }

  async #index(): Promise<Map<string, NamedForm>> {
    this.#names ??= (async () => {
      const names = new Map<string, NamedForm>();
      await this.#context.db.scan(
        SEARCHED,
        () => true,
        (record) => {
          const editorId = record.editorId;
          if (!editorId || record.deleted) return;
          names.set(editorId.toLowerCase(), {
            formId: record.formId,
            type: record.type,
            editorId,
            name: record.text('FULL') ?? '',
          });
        },
      );
      return names;
    })();
    return this.#names;
  }

  /** A record's type (a created form's too). */
  async #typeOf(formId: number): Promise<string | undefined> {
    return (await this.#context.runtime.forms.record(formId))?.type;
  }

  /** A base form of the types by editor id or hex form id. */
  async #form(name: string, types: readonly string[]): Promise<number | undefined> {
    const formId = parseFormId(name);
    if (formId !== undefined) {
      const type = await this.#typeOf(formId);
      if (type !== undefined && (types.length === 0 || types.includes(type))) return formId;
    }
    const named = (await this.#index()).get(name.toLowerCase());
    return named && (types.length === 0 || types.includes(named.type)) ? named.formId : undefined;
  }

  /** A placed reference by "player", hex form id or (a persistent one's) editor id. */
  async #reference(name: string): Promise<number | undefined> {
    if (name.toLowerCase() === 'player') return PLAYER_REF;
    const aliased = await this.#scopeAlias(name);
    if (aliased !== undefined) return aliased;
    const formId = parseFormId(name);
    if (formId !== undefined) {
      if (formId === PLAYER_REF) return formId;
      const runtime = this.#context.runtime;
      if (runtime.state.created.has(formId)) return formId;
      const type = await this.#typeOf(formId);
      if (type !== undefined && REFERENCE_TYPES.has(type)) return formId;
    }
    this.#references ??= (async () => {
      const references = new Map<string, number>();
      const PERSISTENT = 0x400;
      await this.#context.db.scan(
        ['REFR', 'ACHR'],
        (flags) => (flags & PERSISTENT) !== 0,
        (record) => {
          if (record.editorId && !record.deleted)
            references.set(record.editorId.toLowerCase(), record.formId);
        },
      );
      return references;
    })();
    return (await this.#references).get(name.toLowerCase());
  }

  // --- Natives -------------------------------------------------------------------------------

  /** Calls a Papyrus native as a script would ("objectreference.moveto"). */
  async #native(
    name: string,
    self: number | undefined,
    args: readonly Value[] = [],
  ): Promise<Value> {
    const runtime = this.#context.runtime;
    const dot = name.indexOf('.');
    const native = runtime.native(name.slice(0, dot), name.slice(dot + 1));
    if (!native) throw new Error(`the native ${name} is missing`);
    const call: NativeCall = {
      vm: runtime.vm,
      self: self === undefined ? null : new ObjectHandle(self, name.slice(0, dot)),
      args,
      name,
      latent: <T>(work: Promise<T>): Promise<T> => work,
      where: () => 'console',
    };
    return native(call);
  }

  #ref(reference: number | undefined): Value {
    return reference === undefined ? null : this.#context.runtime.referenceHandle(reference);
  }

  #formValue(formId: number | undefined): Value {
    return formId === undefined ? null : this.#context.runtime.formHandle(formId);
  }

  // --- Running -------------------------------------------------------------------------------

  async #execute(call: Invocation): Promise<string[]> {
    const context = this.#context;
    const runtime = context.runtime;
    const { self, args } = call;
    const num = (index: number, fallback = 0): number => {
      const value = args[index];
      return typeof value === 'number' ? value : fallback;
    };
    const text = (index: number): string => {
      const value = args[index];
      return typeof value === 'string' ? value : '';
    };
    const target = self ?? PLAYER_REF;
    const name = call.info.name.toLowerCase();
    switch (name) {
      // --- Toggles ---------------------------------------------------------------------------
      // God mode: the player's health, magicka and stamina are not used up (ActorEngine).
      case 'togglegodmode':
        runtime.godMode = !runtime.godMode;
        return [`God Mode ${runtime.godMode ? 'enabled.' : 'disabled.'}`];
      case 'toggleimmortalmode':
        runtime.debug.immortal = !runtime.debug.immortal;
        return [`Immortal Mode ${runtime.debug.immortal ? 'enabled.' : 'disabled.'}`];
      case 'togglecollision': {
        // With a reference selected the engine turns that reference's collision off.
        // TODO(M13): a selected reference's collision.
        if (self !== undefined || !context.toggleCollision) return [NOT_SUPPORTED];
        return [`Collision -> ${onOff(context.toggleCollision())}`];
      }
      // tai <actor>: as Actor.EnableAI; without an actor (nor one selected), all AI processing.
      case 'toggleai': {
        const actor = typeof args[0] === 'number' ? args[0] : self;
        if (actor !== undefined && (await runtime.actors.isActor(actor))) {
          const enabled = runtime.state.actors.get(actor)?.aiEnabled !== false;
          await this.#native('actor.enableai', actor, [!enabled]);
          return [`${await referenceName(runtime, actor)} processing is  ${onOff(!enabled)}`];
        }
        runtime.debug.ai = !runtime.debug.ai;
        return [`All AI Processing is  ${onOff(runtime.debug.ai)}`];
      }
      case 'togglecombatai':
        runtime.debug.combatAi = !runtime.debug.combatAi;
        return [`All Combat AI processing is ${onOff(runtime.debug.combatAi)}`];
      case 'toggledetection':
        runtime.debug.detection = !runtime.debug.detection;
        return [`AI Detection is  ${onOff(runtime.debug.detection)}`];
      case 'toggleflycam': {
        if (!context.toggleFreeCamera) return [NOT_SUPPORTED];
        // tfc 1 also holds the world still while the free camera is on.
        // TODO(M13): tfc 2 and 5 (the camera's own debug modes).
        if ([2, 5].includes(num(0))) return [NOT_SUPPORTED];
        if (num(0) === 1 && !context.freezeWorld) return [NOT_SUPPORTED];
        const free = context.toggleFreeCamera();
        context.freezeWorld?.(free && num(0) === 1);
        return [`Fly Camera Is ${onOff(free)}`];
      }
      case 'togglemenus':
        return [`Menus -> ${onOff(context.toggleMenus())}`];
      // Observed in the original: the debug text commands do nothing and print nothing (their
      // actions return at once; the Debug Text Menu is never opened).
      case 'toggledebugtext':
      case 'setdebugtext':
      case 'savedebugtextpages':
        return [];
      case 'togglesky':
        return [`Sky -> ${onOff(context.toggleSky())}`];
      case 'togglegrass':
        if (!context.toggleGrass) return [NOT_SUPPORTED];
        return [`Grass Display ${context.toggleGrass() ? 'Enabled.' : 'Disabled.'}`];
      case 'togglefogofwar':
        runtime.debug.fogOfWar = !runtime.debug.fogOfWar;
        return [`Fog of war - ${runtime.debug.fogOfWar ? 'ENABLED' : 'DISABLED'}.`];
      // The renderer's switches: trees, the water, the distant land and trees (tll).
      case 'toggletrees':
        if (!context.toggleRenderer) return [NOT_SUPPORTED];
        return [`Trees -> ${onOff(context.toggleRenderer('trees'))}`];
      case 'togglewatersystem':
        if (!context.toggleRenderer) return [NOT_SUPPORTED];
        return [`Water -> ${onOff(context.toggleRenderer('water'))}`];
      case 'togglelodland':
        if (!context.toggleRenderer) return [NOT_SUPPORTED];
        return [`LOD Land -> ${onOff(context.toggleRenderer('lod'))}`];

      // --- Places ----------------------------------------------------------------------------
      case 'centeroncell': {
        const at = await cellPlacement(context.db, text(0), async (cell) => {
          const found = (await this.#index()).get(cell);
          return found?.type === 'CELL' ? found.formId : undefined;
        });
        if (typeof at === 'string') return [at];
        await context.travel(at);
        return [];
      }
      // coe x y: a cell of the player's worldspace (from an interior, the game's first:
      // Tamriel); cow <world> x y: of a worldspace named.
      case 'centeronexterior':
      case 'centeronworld': {
        const world =
          name === 'centeronworld'
            ? num(0)
            : ((await runtime.placement(PLAYER_REF))?.world ?? TAMRIEL);
        const [x, y] = name === 'centeronworld' ? [num(1), num(2)] : [num(0), num(1)];
        const at = await gridPlacement(context.db, world, x, y);
        if (typeof at === 'string') return [at];
        await context.travel(at);
        return [];
      }
      // movetoqt <quest> [n]: the player goes to the quest's nth current target.
      case 'movetoquesttarget': {
        const quest = num(0);
        const targets = (await (context.questTargets?.() ?? Promise.resolve([]))).filter(
          (entry) => entry.quest === quest,
        );
        if (targets.length === 0) return ['No current targets'];
        const index = num(1, 1);
        if (index < 1 || index > targets.length) {
          return [`Target index out of bounds.  Must be between 1 and ${String(targets.length)}`];
        }
        const chosen = targets[index - 1];
        if (chosen)
          await this.#native('objectreference.moveto', PLAYER_REF, [this.#ref(chosen.reference)]);
        return [];
      }
      case 'movetomarker':
        await this.#native('objectreference.moveto', target, [
          this.#ref(num(0)),
          num(1),
          num(2),
          num(3),
        ]);
        return [];
      // PlaceAtMe <form> [count] [distance] [direction: 0 front, 1 back, 2 left, 3 right].
      case 'placeatme': {
        const placed = await this.#native('objectreference.placeatme', target, [
          this.#formValue(num(0)),
          Math.max(1, num(1, 1)),
        ]);
        const distance = num(2);
        if (distance !== 0 && placed instanceof ObjectHandle) {
          const heading = await this.#native('objectreference.getanglez', target);
          const [dx, dy] = placementOffset(
            typeof heading === 'number' ? heading : 0,
            distance,
            num(3),
          );
          await this.#native('objectreference.moveto', placed.formId, [
            this.#ref(target),
            dx,
            dy,
            0,
          ]);
        }
        return [];
      }
      case 'getpos':
      case 'getangle': {
        const at = await runtime.placement(target);
        const axis = num(0) as 0 | 1 | 2;
        const value =
          name === 'getpos'
            ? (at?.position[axis] ?? 0)
            : ((at?.rotation[axis] ?? 0) * 180) / Math.PI;
        const label = ['X', 'Y', 'Z'][axis] ?? 'X';
        return [`${name === 'getpos' ? 'GetPos' : 'GetAngle'}: ${label} >> ${fixed(value)}`];
      }
      case 'setpos': {
        const at = await runtime.placement(target);
        const position = [...(at?.position ?? [0, 0, 0])];
        position[num(0)] = num(1);
        await this.#native('objectreference.setposition', target, position);
        return [];
      }
      case 'setangle': {
        const at = await runtime.placement(target);
        const angles = (at?.rotation ?? [0, 0, 0]).map((angle) => (angle * 180) / Math.PI);
        angles[num(0)] = num(1);
        await this.#native('objectreference.setangle', target, angles);
        return [];
      }
      case 'getdistance': {
        const distance = await this.#native('objectreference.getdistance', target, [
          this.#ref(num(0)),
        ]);
        return [`GetDistance >> ${fixed(typeof distance === 'number' ? distance : 0)}`];
      }
      case 'setscale':
        await this.#native('objectreference.setscale', target, [num(0)]);
        return [];

      // --- Items -----------------------------------------------------------------------------
      case 'additem':
      case 'removeitem':
        await this.#native(`objectreference.${name}`, target, [
          this.#formValue(num(0)),
          num(1),
          num(2) !== 0,
        ]);
        return [];
      case 'removeallitems':
        await this.#native('objectreference.removeallitems', target, [
          this.#ref(typeof args[0] === 'number' ? args[0] : undefined),
          num(1) !== 0,
        ]);
        return [];
      case 'getitemcount': {
        const count = await runtime.itemCountOf(target, this.#formValue(num(0)));
        return [`GetItemCount >> ${fixed(count)}`];
      }
      case 'equipitem':
      case 'unequipitem':
        // A hand named (left, right): as EquipItemEx/UnequipItemEx's slot (1 right, 2 left).
        if (typeof args[2] === 'number') {
          const hand = handOfSource(args[2]);
          if (hand === undefined) return [NOT_SUPPORTED];
          await this.#native(`actor.${name}ex`, target, [
            this.#formValue(num(0)),
            hand,
            ...(name === 'equipitem' ? [num(1) !== 0, false] : []),
          ]);
          return [];
        }
        await this.#native(`actor.${name}`, target, [this.#formValue(num(0)), num(1) !== 0, false]);
        return [];

      // --- Actor values and levels -----------------------------------------------------------
      case 'getactorvalue': {
        const index = actorValueIndex(text(0));
        if (index === undefined) return [];
        const value = await runtime.actors.value(target, index);
        return [`GetActorValue: ${text(0)} >> ${fixed(value.current)}`];
      }
      case 'setactorvalue':
      case 'modactorvalue':
      case 'forceactorvalue':
      case 'restoreactorvalue':
        await this.#native(`actor.${name}`, target, [text(0), num(1)]);
        return [];
      case 'getlevel':
        return [`GetLevel >> ${fixed(await runtime.actors.level(target))}`];
      // player.AdvLevel: the experience to the next level-up; AdvSkill <skill> <uses>: skill
      // uses' experience; IncPCS <skill>: one level as if earned (UESP "Console").
      case 'advancepclevel':
        await runtime.progression.advanceLevel();
        return [];
      case 'advancepcskill':
      case 'incrementpcskill':
        if (runtime.progression.skillIndex(text(0)) === undefined) {
          return this.#notFound(
            call.typed[0] ?? '',
            call.info.params[0] ?? { name: 'Actor Value', type: { kind: 'actorValue' }, code: 5 },
          );
        }
        if (name === 'incrementpcskill') await runtime.progression.incrementSkill(text(0), 1);
        else await runtime.progression.useSkill(PLAYER_REF, text(0), num(1));
        return [];
      // SetLevel <level>: the actor's level set outright (the player's experience to the next
      // level starts again). TODO(M13): an NPC's level multiplier and calc min and max.
      case 'setlevel': {
        runtime.state.actor(target).level = Math.max(1, Math.round(num(0, 1)));
        if (target === PLAYER_REF) runtime.state.playerExperience = 0;
        return [];
      }

      // --- Quests ----------------------------------------------------------------------------
      case 'setstage':
        await runtime.quests.setStage(num(0), num(1));
        return [];
      case 'getstage':
        return [`GetStage >> ${fixed(runtime.state.quests.get(num(0))?.stage ?? 0)}`];
      case 'getquestrunning':
        return [`GetQuestRunning >> ${fixed(runtime.quests.isRunning(num(0)) ? 1 : 0)}`];
      case 'startquest':
        await this.#native('quest.start', num(0));
        return [];
      case 'stopquest':
        await this.#native('quest.stop', num(0));
        return [];
      case 'completequest':
        await this.#native('quest.completequest', num(0));
        return [];
      case 'resetquest':
        await this.#native('quest.reset', num(0));
        return [];
      case 'completeallobjectives':
        await this.#native('quest.completeallobjectives', num(0));
        return [];
      case 'setobjectivecompleted':
        await this.#native('quest.setobjectivecompleted', num(0), [num(1), num(2) !== 0]);
        return [];
      case 'setobjectivedisplayed':
        await this.#native('quest.setobjectivedisplayed', num(0), [num(1), num(2) !== 0, true]);
        return [];
      case 'showqueststages':
        return this.#questStages(num(0));
      case 'showquestobjectives':
        return this.#questObjectives(typeof args[0] === 'number' ? args[0] : undefined);

      // --- Actors and references -------------------------------------------------------------
      // <ref>.kill [killer]: as Actor.Kill (an essential actor bleeds out instead).
      case 'killactor': {
        if (!(await runtime.actors.isActor(target))) return [];
        await runtime.actors.scriptKill(target, typeof args[0] === 'number' ? args[0] : undefined);
        return [];
      }
      // killall: every living actor loaded but the player, as Actor.Kill. TODO(M13): whether the
      // engine leaves out the player's teammates and essential actors (here they bleed out).
      case 'killallactors': {
        for (const reference of [...(runtime.world.loadedReferences?.() ?? [])]) {
          if (reference === PLAYER_REF || !(await runtime.livingActor(reference))) continue;
          await runtime.actors.scriptKill(reference, undefined);
        }
        return [];
      }
      case 'getdead':
        return [`GetDead >> ${fixed((await runtime.actors.isDead(target)) ? 1 : 0)}`];
      case 'resurrectactor':
        await this.#native('actor.resurrect', target);
        return [];
      case 'enable':
      case 'disable':
        await this.#native(`objectreference.${name}`, target, [num(0) !== 0]);
        return [];
      case 'markfordelete':
        await this.#native('objectreference.delete', target);
        return [];
      case 'lock':
        if (args[0] !== undefined)
          await this.#native('objectreference.setlocklevel', target, [num(0)]);
        await this.#native('objectreference.lock', target, [true, num(1) !== 0]);
        return [];
      case 'unlock':
        await this.#native('objectreference.lock', target, [false, num(0) !== 0]);
        return [];
      case 'getlocked': {
        const locked = (await runtime.lock(target)).locked;
        return [`GetLocked >> ${fixed(locked ? 1 : 0)}`];
      }
      // As Actor.OpenInventory(true): the actor's inventory as a container.
      // On a container: its container menu (no lock or owner asked).
      case 'openactorcontainer':
        if (await runtime.actors.isActor(target)) {
          await this.#native('actor.openinventory', target, [true]);
          return [];
        }
        if (!context.openContainer) return [NOT_SUPPORTED];
        if ((await this.#typeOf((await runtime.baseOf(target)) ?? 0)) !== 'CONT') {
          return [NOT_SUPPORTED];
        }
        context.openContainer(target);
        return [];
      // SetOwnership [owner]: an actor base's or a faction's; without one, the player's.
      case 'setownership': {
        const owner = typeof args[0] === 'number' ? args[0] : undefined;
        if (owner !== undefined && (await this.#typeOf(owner)) === 'FACT') {
          await this.#native('objectreference.setfactionowner', target, [this.#formValue(owner)]);
        } else {
          const base = owner ?? (await runtime.baseOf(PLAYER_REF));
          await this.#native('objectreference.setactorowner', target, [this.#formValue(base)]);
        }
        return [];
      }
      case 'activate':
        await this.#native('objectreference.activate', target, [
          this.#ref(typeof args[0] === 'number' ? args[0] : PLAYER_REF),
          num(1) !== 0,
        ]);
        return [];
      // SetEssential <base> [0/1]: the base's flag in the game state (as ActorBase.SetEssential).
      case 'setessential':
        runtime.state.actorBase(num(0)).essential = num(1, 1) !== 0;
        return [];
      case 'setignorefriendlyhits':
        await this.#native('objectreference.ignorefriendlyhits', target, [num(0, 1) !== 0]);
        return [];

      // --- Crime and factions ----------------------------------------------------------------
      // SetCrimeGold <gold> [faction], PayCrimeGold [remove stolen] [go to jail] [faction]:
      // without a faction, the crime faction of where the player is.
      case 'setcrimegold':
      case 'paycrimegold': {
        const named = name === 'setcrimegold' ? args[1] : args[2];
        const faction =
          typeof named === 'number' ? named : await runtime.crime.placeCrimeFaction(PLAYER_REF);
        if (faction === undefined) return [];
        if (name === 'setcrimegold') {
          await this.#native('faction.setcrimegold', faction, [num(0)]);
        } else {
          await this.#native('faction.playerpaycrimegold', faction, [
            num(0, 1) !== 0,
            num(1, 1) !== 0,
          ]);
        }
        return [];
      }
      // A member keeps the rank it has (as Actor.AddToFaction).
      case 'addtofaction':
        if ((await runtime.actors.factionRank(target, num(0))) < 0) {
          await this.#native('actor.setfactionrank', target, [this.#formValue(num(0)), 0]);
        }
        return [];
      case 'removefromfaction':
        await this.#native('actor.removefromfaction', target, [this.#formValue(num(0))]);
        return [];
      // A rank below 0 takes the actor out.
      case 'setfactionrank':
        await this.#native(
          num(1) < 0 ? 'actor.removefromfaction' : 'actor.setfactionrank',
          target,
          [this.#formValue(num(0)), num(1)],
        );
        return [];
      case 'getfactionrank': {
        const rank = await runtime.actors.factionRank(target, num(0));
        return [`GetFactionRank >> ${fixed(Math.max(-1, rank))}`];
      }
      case 'setrelationshiprank':
        await this.#native('actor.setrelationshiprank', target, [this.#ref(num(0)), num(1)]);
        return [];
      case 'getrelationshiprank': {
        const rank = await this.#native('actor.getrelationshiprank', target, [this.#ref(num(0))]);
        return [`GetRelationshipRank >> ${fixed(typeof rank === 'number' ? rank : 0)}`];
      }

      // --- Inventories -----------------------------------------------------------------------
      case 'showinventory':
        return this.#inventory(target);
      // DuplicateAllItems <container>: a copy of everything it holds put in the other.
      case 'duplicateallitems': {
        const into = args[0];
        if (typeof into !== 'number') return [];
        for (const [item, count] of await runtime.inventory(target)) {
          if (count <= 0) continue;
          await this.#native('objectreference.additem', into, [this.#formValue(item), count, true]);
        }
        return [];
      }

      // --- Magic -----------------------------------------------------------------------------
      case 'playerspellbook':
        return this.#spellBook();
      // <ref>.AddPerk / RemovePerk <perk>: as Actor.AddPerk (its abilities and quest stages with
      // it); AddSpell / RemoveSpell: as Actor.AddSpell (the player's new spell is announced).
      case 'addperk':
        await runtime.perks.add(target, num(0));
        return [];
      case 'removeperk':
        await runtime.perks.remove(target, num(0));
        return [];
      case 'addspell':
      case 'removespell': {
        const spell = num(0);
        const changed =
          name === 'addspell'
            ? await runtime.actors.addSpell(target, spell)
            : await runtime.actors.removeSpell(target, spell);
        if (changed && name === 'addspell' && target === PLAYER_REF)
          runtime.detach(runtime.spellMessage(spell));
        if (changed) await runtime.magic.syncLasting(target);
        return [];
      }
      case 'addshout':
      case 'removeshout':
        await this.#native(`actor.${name}`, target, [this.#formValue(num(0))]);
        return [];
      case 'teachword':
      case 'unlockword':
        await this.#native(`game.${name}`, undefined, [this.#formValue(num(0))]);
        return [];
      // <ref>.Cast <spell> <target>: as Spell.Cast (player.cast WerewolfChange player).
      case 'cast':
        // The casting source (left, right, voice, instant) only picks the node the spell leaves
        // from. TODO(M13): the launch node by the source (the world launches from the caster's own).
        await runtime.magic.cast(num(0), target, num(1));
        return [];

      // --- Weather ---------------------------------------------------------------------------
      // fw / sw <weather> [1]: the weather at once, or with a change; 1 holds it over the
      // regions (an override) until rwo or until a weather's time is up.
      case 'forceweather':
        context.forceWeather(num(0), num(1) !== 0);
        return [];
      case 'setweather':
        context.setWeather(num(0), num(1) !== 0);
        return [];
      case 'releaseweatheroverride':
        context.releaseWeatherOverride();
        return [];

      // --- Settings, the player, the game ----------------------------------------------------
      case 'getgamesetting':
        return [await this.#getSetting(text(0))];
      case 'setgamesetting':
        return this.#setSetting(text(0), call.typed[1] ?? '');
      // fov [world] [first person]: each 0 (or left out) is 75, at most 160 (observed in the
      // original).
      case 'setcamerafov': {
        if (!context.setFov) return [NOT_SUPPORTED];
        const fov = (value: number): number => (value === 0 ? 75 : Math.min(160, value));
        context.setFov(fov(num(0)), fov(num(1)));
        return [];
      }
      case 'showracemenu':
        if (typeof args[0] === 'number') {
          // SetPlayerRace <race>: the player's race changes (their 3D made again in it).
          await this.#native('actor.setrace', PLAYER_REF, [this.#formValue(args[0])]);
          return [];
        }
        // After the opening a new race resets the skills (UESP "Console"): the race menu's.
        context.showRaceMenu();
        return [];
      // TODO(M13): SexChange (the player's body and face made again in the other sex).
      case 'sexchange':
        return [NOT_SUPPORTED];
      case 'enableplayercontrols':
      case 'disableplayercontrols': {
        // As Game.EnablePlayerControls / DisablePlayerControls with every control named.
        const enabled = name === 'enableplayercontrols';
        const controls = runtime.controls;
        controls.movement = enabled;
        controls.fighting = enabled;
        controls.camSwitch = enabled;
        controls.looking = enabled;
        controls.sneaking = enabled;
        controls.menu = enabled;
        controls.activate = enabled;
        controls.journalTabs = enabled;
        // The camera's switch: epc frees it of every lock (the scripts' too, as it frees the
        // other controls); dpc locks it as abCamSwitch with aiDisablePOVType 0 (the natives'
        // default) does, so Toggle POV does nothing meanwhile.
        controls.povLocks = enabled ? [] : [...controls.povLocks.filter((lock) => lock !== 0), 0];
        context.controlsChanged();
        return [];
      }
      case 'showallmapmarkers':
        return this.#mapMarkers(num(0) !== 0, num(1, 1) !== 0, num(2) !== 0);
      case 'quitgame':
        context.quit();
        return [];
      case 'help':
        return this.#help(text(0), num(1), text(2));
      case 'pickrefbyid':
        if (typeof args[0] !== 'number') {
          this.#selected = undefined;
          return [];
        }
        return this.#pick(args[0]);
      case 'clearconsole':
        context.clear?.();
        return [];

      // --- Scripts and quests ------------------------------------------------------------------
      case 'showglobalvars':
        return this.#globals();
      case 'showvars':
        return this.#variables(target);
      case 'showquestvars':
        return this.#questVariables(num(0));
      case 'showquestaliases':
        return this.#aliases(num(0));
      // setpqv <quest> <property> <value>, setpv <property> <value>: a script property set.
      case 'setpapyrusquestvar':
        await this.#setProperty(new ObjectHandle(num(0), 'quest'), text(1), text(2));
        return [];
      case 'setpapyrusvar':
        await this.#setProperty(new ObjectHandle(target, 'objectreference'), text(0), text(1));
        return [];
      case 'startallquests':
        await this.#everyQuest(async (quest) => {
          await this.#native('quest.start', quest.formId);
        });
        return ['All Quests Enabled.'];
      case 'completeallqueststages':
        await this.#everyQuest(async (quest) => {
          for (const stage of quest.stages)
            await runtime.quests.setStage(quest.formId, stage.index);
        });
        return ['All Quest Stages Completed.'];
      // ssq [quest]: the quest whose aliases the console's references may name.
      case 'setconsolescopequest': {
        this.#scope = typeof args[0] === 'number' ? args[0] : undefined;
        if (this.#scope === undefined) return ['Console Scope Quest >> EMPTY'];
        const record = await runtime.forms.record(this.#scope);
        return [`Console Scope Quest >> ${record?.editorId ?? ''} (${hex(this.#scope)})`];
      }
      case 'showquesttargets':
        return this.#questTargetLines();

      // --- Saves, menus and settings -------------------------------------------------------------
      case 'savegame':
        await context.saveGame?.(text(0));
        return [];
      case 'loadgame':
        if (context.loadGame && !(await context.loadGame(text(0)))) return [NOT_SUPPORTED];
        return [];
      case 'showmenu':
      case 'hidemenu':
        context.showMenu?.(text(0), name === 'showmenu');
        return [];
      case 'getinisetting': {
        const value = context.iniSetting?.(text(0));
        return [
          `INISetting ${text(0)} >> ${value === undefined ? 'NOT FOUND' : iniValue(text(0), value)}`,
        ];
      }
      case 'setinisetting': {
        const value = parseConsoleNumber(text(1));
        if (value === undefined || !context.setIniSetting?.(text(0), value))
          return [`INISetting ${text(0)} >> NOT FOUND`];
        return [];
      }
      // SetUFOCamSpeedMult <speed>: the free camera's fFreeCameraTranslationSpeed set to it, the
      // units it moves an update (observed in the original: the command sets that setting).
      case 'setufocamspeedmult':
        context.setIniSetting?.('fFreeCameraTranslationSpeed:Camera', num(0, 1));
        return [];
      // SetRace <race>: the player's race (as Actor.SetRace).
      case 'setrace': {
        const race = await this.#form(text(0), ['RACE']);
        if (race === undefined) return this.#notFound(text(0), call.info.params[0] ?? RACE_PARAM);
        await this.#native('actor.setrace', PLAYER_REF, [this.#formValue(race)]);
        return [];
      }
      default:
        return this.#generic(call, target);
    }
  }

  /**
   * A command no case above runs: one whose action returns at once does nothing (observed in the
   * original); a script function with a condition function prints that function's value for the
   * reference, as the game's actions of those functions do ("GetIsID >> 1.00").
   */
  async #generic(call: Invocation, target: number): Promise<string[]> {
    const { info, args } = call;
    if (info.returnsAtOnce) return [];
    if (info.name === 'GetSelf') return [referenceLine(info.name, target)];
    const viaNative = NATIVE_FUNCTIONS[info.name.toLowerCase()];
    if (viaNative) return this.#viaNative(info, viaNative, args, target);
    const math = mathFunction(info.name, args);
    if (math !== undefined) return [`${info.name} >> ${fixed(math)}`];
    if (info.condition === undefined || info.noAction) return [NOT_SUPPORTED];
    const value = await conditionFunctionValue(
      this.#context.runtime,
      consoleCondition(info, args),
      this.#context.runtime.referenceHandle(target),
    );
    if (value === NOT_VALUED) return [NOT_SUPPORTED];
    const axis = info.params.findIndex((param) => param.type.kind === 'axis');
    const axisValue = axis < 0 ? undefined : args[axis];
    return [conditionLine(info.name, value ?? 0, typeof axisValue === 'number' ? axisValue : 0)];
  }

  /** A script function a Papyrus native does (src/shell/console-script-functions.ts). */
  async #viaNative(
    info: ConsoleCommandInfo,
    spec: NativeFunction,
    args: readonly Arg[],
    target: number,
  ): Promise<string[]> {
    const value = (argument: NativeArgument): Value => {
      if ('self' in argument) return this.#ref(target);
      if ('fixed' in argument) return argument.fixed;
      if ('form' in argument) {
        const raw = args[argument.form];
        return this.#formValue(typeof raw === 'number' ? raw : undefined);
      }
      if ('reference' in argument) {
        const raw = args[argument.reference];
        return this.#ref(typeof raw === 'number' ? raw : undefined);
      }
      if ('text' in argument) {
        const raw = args[argument.text];
        return typeof raw === 'string' ? raw : '';
      }
      if ('number' in argument) {
        const raw = args[argument.number];
        return typeof raw === 'number' ? raw : (argument.fallback ?? 0);
      }
      const raw = args[argument.bool];
      return typeof raw === 'number' ? raw !== 0 : (argument.fallback ?? false);
    };
    const on = spec.on ?? 'reference';
    let self: number | undefined;
    if (on === 'reference') self = target;
    else if (on !== 'none') {
      const raw = args[on.form];
      self = typeof raw === 'number' ? raw : undefined;
    }
    const result = await this.#native(spec.native, self, spec.args.map(value));
    if (spec.printsReference) {
      const formId = result instanceof ObjectHandle ? result.formId : undefined;
      return [referenceLine(info.name, formId)];
    }
    if (!spec.prints) return [];
    const number = typeof result === 'boolean' ? (result ? 1 : 0) : Number(result ?? 0);
    return [conditionLine(info.name, number)];
  }

  // --- Scripts and quests ----------------------------------------------------------------------

  /** The reference an alias of the scope quest (ssq) holds, by the alias's name. */
  async #scopeAlias(name: string): Promise<number | undefined> {
    if (this.#scope === undefined) return undefined;
    const runtime = this.#context.runtime;
    const record = await runtime.forms.quest(this.#scope);
    const alias = record?.aliases.find(
      (entry) => !entry.location && entry.name.toLowerCase() === name.toLowerCase(),
    );
    if (!alias) return undefined;
    return runtime.state.quests.get(this.#scope)?.aliases.get(alias.id);
  }

  /**
   * sglv: every global and its value (a float's with four decimals, a long's whole, a short's
   * as 16 bits: observed in the original), in the load order.
   */
  async #globals(): Promise<string[]> {
    const lines = ['--- Global Variables -----------------------------'];
    const globals: { formId: number; editorId: string; type: 'f' | 'l' | 's' }[] = [];
    await this.#context.db.scan(
      ['GLOB'],
      () => true,
      (record) => {
        if (!record.editorId || record.deleted) return;
        const code = record.fields.first('FNAM')?.[0];
        // FNAM: f(loat), l(ong) or s(hort); another prints nothing.
        const type = code === 0x66 ? 'f' : code === 0x6c ? 'l' : code === 0x73 ? 's' : undefined;
        if (type) globals.push({ formId: record.formId, editorId: record.editorId, type });
      },
    );
    for (const global of globals) {
      const value = await this.#native('globalvariable.getvalue', global.formId);
      const number = typeof value === 'number' ? value : 0;
      lines.push(globalLine(global.editorId, global.type, number));
    }
    return lines;
  }

  /**
   * sv: what runs on a reference: its update registrations, each of its scripts with their
   * variables (src/shell/console-papyrus.ts), then the same for each alias holding it (observed
   * in the original). TODO(M13): the original then lists an actor's active magic effects'
   * scripts ("--- Papyrus - Active magic effect <n>"); not built.
   */
  async #variables(reference: number): Promise<string[]> {
    const runtime = this.#context.runtime;
    const lines = [
      PAPYRUS_HEADER,
      ...(await this.#objectLines(new ObjectHandle(reference, 'form'))),
    ];
    for (const { quest, alias } of runtime.aliasesHolding(reference)) {
      const record = await runtime.forms.quest(quest);
      const name = record?.aliases.find((entry) => entry.id === alias)?.name ?? '';
      const questName = (await runtime.forms.record(quest))?.editorId ?? '';
      lines.push(`--- Papyrus - Alias ${name} on Quest ${questName} (${hex8(quest)})`);
      lines.push(...(await this.#objectLines(new ObjectHandle(quest, 'form', alias))));
    }
    return lines;
  }

  /**
   * sqv: a quest's registrations and scripts as sv's, its aliases as ShowQuestAliases', then its
   * state (observed in the original): Waiting For Stage while its start waits to run;
   * "Waiting For Promotion" (the original's references being made persistent) never, as every
   * reference here can be held.
   */
  async #questVariables(quest: number): Promise<string[]> {
    const runtime = this.#context.runtime;
    const record = await runtime.forms.quest(quest);
    if (!record) return [];
    const state = runtime.state.quests.get(quest);
    return [
      PAPYRUS_HEADER,
      ...(await this.#objectLines(new ObjectHandle(quest, 'quest'))),
      ...(await this.#aliases(quest)),
      ...questStateLines({
        enabled: state?.running === true,
        waitingForStage: runtime.quests.starting.has(quest),
        waitingForPromotion: false,
        stage: state?.stage ?? 0,
        priority: record.priority,
      }),
    ];
  }

  /** An object's update registrations and scripts with their variables. */
  async #objectLines(handle: ObjectHandle): Promise<string[]> {
    const runtime = this.#context.runtime;
    const scripts = await runtime.vm.scriptVariables(handle);
    const texts = await this.#handleTexts(scripts.flatMap((script) => script.variables));
    return [
      ...registrationLines(
        runtime.updateInterval(handle, false),
        runtime.updateInterval(handle, true),
      ),
      ...scriptsLines(scripts, (value) => texts.get(value.key) ?? ` (${hex8(value.formId)})`),
    ];
  }

  /**
   * How each object the variables hold is told: an alias as "alias <name> on quest <quest>
   * (<id>)" (observed in the original); a form by its editor id and id, a reference by its id
   * alone (TODO(M13): as the game's Papyrus logs write them, not confirmed in the original).
   */
  async #handleTexts(
    variables: readonly { readonly value: Value }[],
  ): Promise<Map<string, string>> {
    const runtime = this.#context.runtime;
    const texts = new Map<string, string>();
    const visit = async (value: Value): Promise<void> => {
      if (value instanceof PapyrusArray) {
        for (const item of value.items) await visit(item);
        return;
      }
      if (!(value instanceof ObjectHandle) || texts.has(value.key)) return;
      const record = await runtime.forms.record(value.formId);
      const editorId = record?.editorId ?? '';
      if (value.alias >= 0) {
        const quest = await runtime.forms.quest(value.formId);
        const name = quest?.aliases.find((entry) => entry.id === value.alias)?.name ?? '';
        texts.set(value.key, `alias ${name} on quest ${editorId} (${hex8(value.formId)})`);
        return;
      }
      const reference = record !== undefined && REFERENCE_TYPES.has(record.type);
      texts.set(value.key, `${reference ? '' : editorId} (${hex8(value.formId)})`);
    };
    for (const variable of variables) await visit(variable.value);
    return texts;
  }

  /**
   * ShowQuestAliases: how many aliases the quest has, then each, a reference alias as
   * "REF '<alias>'-> '<reference>' (<id>)" and a location alias as "LOC ...", or "-> NONE"
   * while empty (observed in the original). TODO(M13): the name the original gives a reference
   * or location there (its form's editor-id call) is not confirmed: the reference's name and
   * the location's editor id here.
   */
  async #aliases(quest: number): Promise<string[]> {
    const runtime = this.#context.runtime;
    const record = await runtime.forms.quest(quest);
    if (!record) return [];
    const fills = runtime.state.quests.get(quest)?.aliases;
    const editorId = (await runtime.forms.record(quest))?.editorId ?? '';
    const lines = [
      `- ${String(record.aliases.length)} Aliases for quest '${editorId}' (${hex8(quest)})-`,
    ];
    for (const alias of record.aliases) {
      const kind = alias.location ? 'LOC' : 'REF';
      const filled = fills?.get(alias.id);
      if (filled === undefined) {
        lines.push(`${kind} '${alias.name}'-> NONE`);
        continue;
      }
      const name = alias.location
        ? ((await runtime.forms.record(filled))?.editorId ?? '')
        : await referenceName(runtime, filled);
      lines.push(`${kind} '${alias.name}'-> '${name}' (${hex8(filled)})`);
    }
    return lines;
  }

  /** setpqv, setpv: a property set to a number, a bool, None or a form named. */
  async #setProperty(target: ObjectHandle, property: string, text: string): Promise<void> {
    const lower = text.toLowerCase();
    let value: Value;
    const number = parseConsoleNumber(text);
    if (lower === 'true' || lower === 'false') value = lower === 'true';
    else if (lower === 'none') value = null;
    else if (number !== undefined && !/^[0-9a-f]{8}$/i.test(text)) value = number;
    else {
      const reference = await this.#reference(text);
      const formId = reference ?? (await this.#form(text, []));
      value =
        reference !== undefined
          ? this.#ref(reference)
          : formId !== undefined
            ? this.#formValue(formId)
            : text;
    }
    await this.#context.runtime.vm.setProperty(target, property, value);
  }

  /** Runs work on every quest of the load order. */
  async #everyQuest(work: (quest: QuestRecord) => Promise<void>): Promise<void> {
    const runtime = this.#context.runtime;
    const quests: number[] = [];
    await this.#context.db.scan(
      ['QUST'],
      () => true,
      (record) => {
        if (!record.deleted) quests.push(record.formId);
      },
    );
    for (const formId of quests) {
      const quest = await runtime.forms.quest(formId);
      if (quest) await work(quest);
    }
  }

  /**
   * sqt: for each quest with targets, "Current quest: <quest>", how many, then each target's
   * reference and the load door toward it (observed in the original). TODO(M13): the original
   * also names the container carrying a target ("(carrying ...)"), not tracked here; which of
   * its words a target without a door gets ("Same cell/exterior" or "UNREACHABLE") is mapped
   * here to the same space and no route found; the reference's name as in ShowQuestAliases.
   */
  async #questTargetLines(): Promise<string[]> {
    const runtime = this.#context.runtime;
    const byQuest = new Map<number, QuestTargetEntry[]>();
    for (const target of (await this.#context.questTargets?.()) ?? []) {
      const list = byQuest.get(target.quest) ?? [];
      list.push(target);
      byQuest.set(target.quest, list);
    }
    const lines: string[] = [];
    for (const [quest, targets] of byQuest) {
      lines.push(`Current quest: ${(await runtime.forms.record(quest))?.editorId ?? ''}`);
      lines.push(`${String(targets.length)} current targets`);
      let index = 1;
      for (const target of targets) {
        const name = await referenceName(runtime, target.reference);
        const way = await this.#context.questTargetDoor?.(target);
        const door =
          way === undefined
            ? ''
            : way === 'same'
              ? 'Same cell/exterior'
              : way === 'unreachable'
                ? 'UNREACHABLE'
                : `${await referenceName(runtime, way)} (${hex8(way)})`;
        lines.push(
          `Target ${String(index++)}:  Reference: ${name} (${hex8(target.reference)}), load door: ${door}`,
        );
      }
    }
    return lines;
  }

  /** showinventory: each item it holds with its count, name and form id. */
  async #inventory(reference: number): Promise<string[]> {
    const runtime = this.#context.runtime;
    const lines: string[] = [];
    for (const [item, count] of await runtime.inventory(reference)) {
      if (count <= 0) continue;
      const record = await runtime.forms.record(item);
      const name = record?.text('FULL') ?? record?.editorId ?? '';
      lines.push(`${String(count)} - ${name} (${hex(item)})`);
    }
    return lines;
  }

  /** Selects a reference for the console (prid, a click). */
  async #pick(reference: number): Promise<string[]> {
    this.#selected = reference;
    const name = await referenceName(this.#context.runtime, reference);
    return [`PickRefByIDFunction: ${name} (${hex(reference)})`];
  }

  // --- set -----------------------------------------------------------------------------------

  async #set(args: readonly string[]): Promise<string[]> {
    const runtime = this.#context.runtime;
    const [name, to, text] = args;
    if (!name) return ['Missing variable name in set command.', NOT_SAVED];
    if (to?.toLowerCase() !== 'to')
      return ['Syntax Error.  Missing "to" in set command.', NOT_SAVED];
    const value = parseConsoleNumber(text);
    if (value === undefined)
      return ['Syntax Error.  Missing expression in set command.', NOT_SAVED];
    // set <quest>.<variable> to <value>: a property of a script on the quest.
    const dot = name.indexOf('.');
    if (dot > 0) {
      const quest = await this.#form(name.slice(0, dot), ['QUST']);
      if (quest === undefined) return [`Unknown variable '${name}'.`, NOT_SAVED];
      await runtime.vm.setProperty(new ObjectHandle(quest, 'quest'), name.slice(dot + 1), value);
      return [];
    }
    const global = await this.#form(name, ['GLOB']);
    if (global === undefined) return [`Unknown variable '${name}'.`, NOT_SAVED];
    if (name.toLowerCase() === 'timescale') runtime.timeScale = value;
    if (!runtime.setClockGlobal(global, value)) runtime.state.globals.set(global, value);
    return [];
  }

  // --- Quests --------------------------------------------------------------------------------

  /** sqs: each stage, whether it is done, and its log entries. */
  async #questStages(quest: number): Promise<string[]> {
    const runtime = this.#context.runtime;
    const record = await runtime.forms.quest(quest);
    const done = runtime.state.quests.get(quest)?.stagesDone;
    return (record?.stages ?? []).map((stage) => {
      const items = stage.logEntries.map((_entry, index) => `Item ${String(index)}`).join(', ');
      return `Stage ${String(stage.index)}: ${done?.has(stage.index) === true ? '1' : '0'} ${items}`.trimEnd();
    });
  }

  /**
   * sqo [quest]: a quest's objectives, or those of every quest the player has shown, each by
   * its index, text and state (COMPLETED, DISPLAYED, DORMANT); every quest under its name.
   */
  async #questObjectives(quest: number | undefined): Promise<string[]> {
    const runtime = this.#context.runtime;
    const lines: string[] = [];
    const quests = quest === undefined ? [...runtime.state.quests.keys()] : [quest];
    for (const formId of quests) {
      const record = await runtime.forms.quest(formId);
      const state = runtime.state.quests.get(formId);
      const shown = (record?.objectives ?? []).filter(
        (objective) => quest !== undefined || state?.objectives.get(objective.index)?.displayed,
      );
      if (shown.length === 0) continue;
      if (quest === undefined) {
        if (lines.length > 0) lines.push('');
        lines.push(`== ${record?.name ?? record?.editorId ?? ''} ==`, '( Instance: 0 )');
      }
      for (const objective of shown) {
        const at = state?.objectives.get(objective.index);
        const status = at?.completed ? 'COMPLETED' : at?.displayed ? 'DISPLAYED' : 'DORMANT';
        lines.push(`${String(objective.index)} ${objective.text ?? ''} ${status}`);
      }
    }
    return lines;
  }

  // --- Magic ---------------------------------------------------------------------------------

  /**
   * psb: every spell, power and lesser power (spell types 0, 2, 3) the player lacks, every shout,
   * and every word of power learned (observed in the original).
   */
  async #spellBook(): Promise<string[]> {
    const runtime = this.#context.runtime;
    const db = this.#context.db;
    let spells = 0;
    let shouts = 0;
    let words = 0;
    const kinds: ReadonlySet<number> = new Set([
      SpellType.spell,
      SpellType.power,
      SpellType.lesserPower,
    ]);
    for (const formId of db.formIdsOfType('SPEL')) {
      const record = await db.get(formId);
      if (!record || record.deleted || !kinds.has(parseSpell(record).spellType)) continue;
      if (await runtime.actors.addSpell(PLAYER_REF, formId)) spells++;
    }
    for (const formId of db.formIdsOfType('SHOU')) {
      // TODO(M13): only the shouts the player lacks counted (here every one added).
      await this.#native('actor.addshout', PLAYER_REF, [this.#formValue(formId)]);
      shouts++;
    }
    for (const formId of db.formIdsOfType('WOOP')) {
      if (runtime.wordsLearned.get(formId) !== undefined) continue;
      await this.#native('game.teachword', undefined, [this.#formValue(formId)]);
      words++;
    }
    await runtime.magic.syncLasting(PLAYER_REF);
    return [
      `${String(spells)} spells, ${String(shouts)} shouts, ${String(words)} words added to Player Character`,
    ];
  }

  // --- Settings ------------------------------------------------------------------------------

  async #getSetting(name: string): Promise<string> {
    const value = await this.#context.runtime.gameSetting(name);
    if (value === undefined) return `GameSetting ${name} >> NOT FOUND`;
    if (typeof value === 'string') return `GameSetting ${name} >> '${value}'`;
    return name.toLowerCase().startsWith('f')
      ? `GameSetting ${name} >> ${fixed(value)}`
      : `GameSetting ${name} >> ${String(Math.trunc(value))}`;
  }

  /**
   * setgs <setting> <value>: the scripts' settings and the session's take the value. TODO(M13):
   * the systems that read their settings once (detection, combat, ...) see it from their next
   * reading only.
   */
  async #setSetting(name: string, text: string): Promise<string[]> {
    const runtime = this.#context.runtime;
    const sessionSettings = await this.#context.gameSettings?.();
    const settings = [
      await runtime.gameSettingTable(),
      ...(sessionSettings ? [sessionSettings] : []),
    ];
    const isString = name.toLowerCase().startsWith('s');
    const value = isString ? text : parseConsoleNumber(text);
    if (value === undefined) return [`GameSetting ${name} >> Invalid Value`];
    for (const each of settings) each.set(name, value);
    return [];
  }

  // --- Map markers ---------------------------------------------------------------------------

  /**
   * tmm <show> [travel] [all]: every map marker shown (and reachable by fast travel unless
   * travel is 0) or hidden; those flagged hidden from it ("Show All" Hidden) only with all 1.
   */
  async #mapMarkers(show: boolean, travel: boolean, all: boolean): Promise<string[]> {
    const runtime = this.#context.runtime;
    for (const marker of await readMapMarkers(this.#context.db)) {
      if (!all && (marker.flags & MapMarkerFlag.showAllHidden) !== 0) continue;
      runtime.mapMarker(marker.reference, show, show && travel);
    }
    return [`All map markers ${show ? 'shown.' : 'hidden.'}`];
  }

  // --- help ----------------------------------------------------------------------------------

  /**
   * help <word> [filter] [form type]: the commands (filter 0 or 1), the globals (0 or 3) and the
   * forms (0 or 4; of a type if given) whose names hold the word; the game's settings it does
   * not list ("VIEWER STRINGS NOT AVAILABLE"). Without a word, its usage.
   */
  async #help(word: string, filter: number, formType: string): Promise<string[]> {
    const usage = [
      'usage: help <search word> <filter> <form type>',
      'filters: 0-all 1-functions, 2-settings, 3-globals, 4-forms',
      'form type is 4 characters and is ignored unless the filter is 0 or 4.',
    ];
    if (word === '') return usage;
    const needle = word.toLowerCase();
    const has = (value: string | undefined): boolean =>
      value?.toLowerCase().includes(needle) === true;
    const lines: string[] = [];
    if (filter < 2) {
      for (const consoleOnly of [true, false]) {
        lines.push(
          consoleOnly
            ? '----CONSOLE COMMANDS--------------------'
            : '----SCRIPT FUNCTIONS--------------------',
        );
        for (const info of CONSOLE_COMMANDS) {
          if (info.console !== consoleOnly) continue;
          if (!has(info.help) && !has(info.name) && !has(info.short)) continue;
          const named = info.short ? `${info.name} (${info.short})` : info.name;
          lines.push(info.help === '' ? named : `${named} -> ${info.help}`);
        }
      }
    }
    lines.push('----VIEWER STRINGS NOT AVAILABLE--------');
    const names = await this.#index();
    if (filter === 0 || filter === 3) {
      lines.push('----GLOBAL VARIABLES--------------------');
      for (const form of names.values()) {
        if (form.type !== 'GLOB' || !has(form.editorId)) continue;
        const value = await this.#native('globalvariable.getvalue', form.formId);
        lines.push(`${form.editorId} = ${fixed(typeof value === 'number' ? value : 0)}`);
      }
    }
    if (filter === 0 || filter === 4) {
      lines.push('----OTHER FORMS--------------------');
      const type = formType.toUpperCase();
      const found = [...names.values()]
        .filter(
          (form) =>
            form.type !== 'GLOB' &&
            (type === '' || form.type === type) &&
            (has(form.editorId) || has(form.name)),
        )
        .sort((a, b) => a.editorId.localeCompare(b.editorId));
      for (const form of found) {
        lines.push(`${form.type}: ${form.editorId} (${hex(form.formId)}) '${form.name}'`);
      }
    }
    return [...lines, ...usage];
  }
}
