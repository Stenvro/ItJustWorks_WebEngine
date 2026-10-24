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

import type { NativeCall } from '../scripting/papyrus-vm.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { referenceName } from '../scripting/runtime/quest-text.ts';
import type { Placement, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ObjectHandle, type Value } from '../scripting/values.ts';
import { actorValueIndex } from '../world/actor-values.ts';
import type { GameSettings } from '../world/game-settings.ts';
import { ITEM_TYPES } from '../world/item-records.ts';
import { MapMarkerFlag, readMapMarkers } from '../world/map-markers.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import { parseSpell, SpellType } from '../world/spell-records.ts';
import { cellPlacement, gridPlacement } from './cell-placement.ts';
import { questTargets } from './compass.ts';
import { parseAxis, parseConsoleLine, parseConsoleNumber, parseFormId } from './console-parse.ts';
import {
  CONSOLE_COMMANDS,
  consoleCommand,
  type ConsoleCommandInfo,
  type ConsoleParam,
  type ConsoleParamType,
} from './console-table.ts';

export { parseConsoleLine } from './console-parse.ts';

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
  /** Clears the console's history (clear). */
  clear?(): void;
  /** The reference under a point of the frame (see ConsoleRunner.click). */
  pick?(x: number, y: number, aspect: number): number | undefined;
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

const onOff = (on: boolean): string => (on ? 'On' : 'Off');
const fixed = (value: number): string => value.toFixed(2);
const hex = (formId: number): string => formId.toString(16).toUpperCase().padStart(8, '0');

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
      if (type !== undefined && types.includes(type)) return formId;
    }
    const named = (await this.#index()).get(name.toLowerCase());
    return named && types.includes(named.type) ? named.formId : undefined;
  }

  /** A placed reference by "player", hex form id or (a persistent one's) editor id. */
  async #reference(name: string): Promise<number | undefined> {
    if (name.toLowerCase() === 'player') return PLAYER_REF;
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
        // tfc 1 also holds the world still. TODO(M13): the world held still under tfc 1.
        if ([1, 2, 5].includes(num(0))) return [NOT_SUPPORTED];
        return [`Fly Camera Is ${onOff(context.toggleFreeCamera())}`];
      }
      case 'togglemenus':
        return [`Menus -> ${onOff(context.toggleMenus())}`];
      case 'togglesky':
        return [`Sky -> ${onOff(context.toggleSky())}`];
      case 'togglegrass':
        if (!context.toggleGrass) return [NOT_SUPPORTED];
        return [`Grass Display ${context.toggleGrass() ? 'Enabled.' : 'Disabled.'}`];
      case 'togglefogofwar':
        runtime.debug.fogOfWar = !runtime.debug.fogOfWar;
        return [`Fog of war - ${runtime.debug.fogOfWar ? 'ENABLED' : 'DISABLED'}.`];
      // TODO(M13): the renderer's switches for trees (near and distant), the water and the
      // distant land, objects, trees and water (tll).
      case 'toggletrees':
      case 'togglewatersystem':
      case 'togglelodland':
        return [NOT_SUPPORTED];

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
        const targets = (await questTargets(runtime)).filter((entry) => entry.quest === quest);
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
      case 'placeatme': {
        // TODO(M13): PlaceAtMe's distance and direction (the new references stand at it).
        if (num(2) !== 0 || num(3) !== 0) return [NOT_SUPPORTED];
        await this.#native('objectreference.placeatme', target, [
          this.#formValue(num(0)),
          Math.max(1, num(1, 1)),
        ]);
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
        // TODO(M13): the hand (left, right) the console names.
        if (text(2) !== '') return [NOT_SUPPORTED];
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
            call.info.params[0] ?? { name: 'Actor Value', type: { kind: 'actorValue' } },
          );
        }
        if (name === 'incrementpcskill') await runtime.progression.incrementSkill(text(0), 1);
        else await runtime.progression.useSkill(PLAYER_REF, text(0), num(1));
        return [];
      // TODO(M13): SetLevel (an actor's level set outright, the player's experience with it).
      case 'setlevel':
        return [NOT_SUPPORTED];

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
      case 'openactorcontainer':
        if (!(await runtime.actors.isActor(target))) return [NOT_SUPPORTED];
        await this.#native('actor.openinventory', target, [true]);
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
      // TODO(M13): SetEssential on an actor base (the base's flag changed in the game state).
      case 'setessential':
        return [NOT_SUPPORTED];

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
        // TODO(M13): the casting source (left, right, voice, instant) the console names.
        if (text(2) !== '') return [NOT_SUPPORTED];
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
        controls.disablePov = 0;
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
      case 'getselectedref':
        return this.#selected === undefined
          ? ['No Reference Selected']
          : [
              `GetSelectedRef: ${await referenceName(runtime, this.#selected)} (${hex(this.#selected)})`,
            ];
      case 'clearconsole':
        context.clear?.();
        return [];
      default:
        return [NOT_SUPPORTED];
    }
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
    // TODO(M13): a quest script's variables (set <quest>.<variable> to <value>).
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
          lines.push(
            info.short
              ? `${info.name} (${info.short}) -> ${info.help}`
              : `${info.name} -> ${info.help}`,
          );
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
