// The game's console commands (the ~ console, src/shell/console-menu.ts): a line is a command
// and its arguments, separated by spaces (quotes keep spaces in one), with an optional
// reference before a dot ("player.additem f 100"); forms are named by editor id or by form id
// in hex. A command prints what it did or found, as the game does; an unknown one prints
// "Script command "<name>" not found." (UESP, "Skyrim:Console").
//
// Built so far: help, centeroncell (coc: where, src/shell/cell-placement.ts), additem /
// removeitem, setstage / getstage / startquest / stopquest / completequest, set <global> to
// <value> (TimeScale too), getav / setav / modav / forceav, advlevel, advskill / incpcs,
// addperk / removeperk, addspell / removespell, togglemenus (tm), forceweather (fw),
// enableplayercontrols (epc) / disableplayercontrols (dpc), togglegodmode (tgm), kill,
// showracemenu, quitquitquit (qqq).
// TODO(M13): the rest of the game's console commands (tcl, tai, resurrect, moveto, prid by
// clicking, ...).

import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { Placement, ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { actorValueIndex } from '../world/actor-values.ts';
import { cellPlacement } from './cell-placement.ts';
import { ITEM_TYPES } from '../world/item-records.ts';
import type { RecordDatabase } from '../world/record-db.ts';

/** What the commands act on. */
export interface ConsoleContext {
  readonly runtime: ScriptRuntime;
  readonly db: RecordDatabase;
  /** Takes the player to a place. */
  travel(at: Placement): Promise<void>;
  /** Shows or hides the game's menus and HUD (tm). */
  toggleMenus(): void;
  /** Forces a weather (fw). */
  forceWeather(weather: number): void;
  /** Opens the race menu (showracemenu). */
  showRaceMenu(): void;
  /** The player's controls changed (epc, dpc). */
  controlsChanged(): void;
  /** Quits the game (qqq). */
  quit(): void;
}

/** The types `help` searches, and those a form name is looked up in. */
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
] as const;

/** A console line split into its reference, command and arguments. */
export function parseConsoleLine(line: string): {
  readonly reference: string | undefined;
  readonly command: string;
  readonly args: string[];
} {
  const words = [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? '');
  const head = words.shift() ?? '';
  const dot = head.indexOf('.');
  return dot > 0
    ? { reference: head.slice(0, dot), command: head.slice(dot + 1).toLowerCase(), args: words }
    : { reference: undefined, command: head.toLowerCase(), args: words };
}

export class ConsoleCommands {
  readonly #context: ConsoleContext;
  /** Editor ids of the searched types, lowercase, read once. */
  #names:
    | Promise<Map<string, { formId: number; type: string; editorId: string; name: string }>>
    | undefined;

  constructor(context: ConsoleContext) {
    this.#context = context;
  }

  /** Runs a line; resolves to what it prints. */
  async run(line: string): Promise<string[]> {
    const { reference, command, args } = parseConsoleLine(line.trim());
    if (command === '') return [];
    const target = reference === undefined ? undefined : this.#reference(reference);
    if (reference !== undefined && target === undefined) {
      return [`Item '${reference}' not found for parameter Reference.`];
    }
    const self = target ?? PLAYER_REF;
    const runtime = this.#context.runtime;
    switch (command) {
      case 'help':
        return this.#help(args[0] ?? '');
      case 'coc':
      case 'centeroncell':
        return this.#centerOnCell(args[0] ?? '');
      case 'additem':
      case 'removeitem': {
        const item = await this.#form(args[0]);
        const count = Math.max(1, Number(args[1] ?? '1') || 1);
        if (item === undefined) return [`Item '${args[0] ?? ''}' not found for parameter Object.`];
        if (command === 'additem')
          await runtime.addItem(self, runtime.formHandle(item), count, false);
        else await runtime.removeItem(self, runtime.formHandle(item), count, false, undefined);
        return [];
      }
      case 'setstage':
      case 'getstage':
      case 'startquest':
      case 'stopquest':
      case 'completequest':
        return this.#quest(command, args);
      case 'set':
        return this.#set(args);
      case 'getav':
      case 'getactorvalue':
      case 'setav':
      case 'setactorvalue':
      case 'modav':
      case 'modactorvalue':
      case 'forceav':
      case 'forceactorvalue':
        return this.#actorValue(command, self, args);
      // player.AdvLevel: the experience to the next level-up; player.AdvSkill <skill> <uses>:
      // skill uses' experience; IncPCS <skill>: one level as if earned (UESP "Console").
      case 'advlevel':
        await runtime.progression.advanceLevel();
        return [];
      case 'advskill':
      case 'incpcs': {
        if (runtime.progression.skillIndex(args[0] ?? '') === undefined)
          return [`Item '${args[0] ?? ''}' not found for parameter Actor Value.`];
        if (command === 'incpcs') await runtime.progression.incrementSkill(args[0] ?? '', 1);
        else await runtime.progression.useSkill(PLAYER_REF, args[0] ?? '', Number(args[1]) || 0);
        return [];
      }
      // <ref>.AddPerk / RemovePerk <perk>: as Actor.AddPerk (the perk system: its abilities and
      // quest stages with it); AddSpell / RemoveSpell <spell>: as Actor.AddSpell (an ability
      // acts from now on; the player's new spell is announced).
      case 'addperk':
      case 'removeperk': {
        const perk = await this.#form(args[0]);
        if (perk === undefined || (await runtime.forms.record(perk))?.type !== 'PERK')
          return [`Item '${args[0] ?? ''}' not found for parameter Perk.`];
        if (command === 'addperk') await runtime.perks.add(self, perk);
        else await runtime.perks.remove(self, perk);
        return [];
      }
      case 'addspell':
      case 'removespell': {
        const spell = await this.#form(args[0]);
        if (spell === undefined || (await runtime.forms.record(spell))?.type !== 'SPEL')
          return [`Item '${args[0] ?? ''}' not found for parameter Spell.`];
        const changed =
          command === 'addspell'
            ? await runtime.actors.addSpell(self, spell)
            : await runtime.actors.removeSpell(self, spell);
        if (changed && command === 'addspell' && self === PLAYER_REF)
          runtime.detach(runtime.spellMessage(spell));
        if (changed) await runtime.magic.syncLasting(self);
        return [];
      }
      case 'tm':
      case 'togglemenus':
        this.#context.toggleMenus();
        return [];
      case 'fw':
      case 'forceweather': {
        const weather = await this.#form(args[0]);
        if (weather === undefined)
          return [`Item '${args[0] ?? ''}' not found for parameter Weather.`];
        this.#context.forceWeather(weather);
        return [];
      }
      case 'epc':
      case 'enableplayercontrols':
      case 'dpc':
      case 'disableplayercontrols': {
        // As Game.EnablePlayerControls / DisablePlayerControls with every control named.
        const enabled = command === 'epc' || command === 'enableplayercontrols';
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
        this.#context.controlsChanged();
        return [];
      }
      // God mode: the player takes no damage and cannot die (ActorEngine).
      case 'tgm':
      case 'togglegodmode':
        runtime.godMode = !runtime.godMode;
        return [`God Mode -- ${runtime.godMode ? 'ON' : 'OFF'}`];
      // <ref>.kill [killer]: as Actor.Kill (an essential actor bleeds out instead).
      case 'kill': {
        const killer = args[0] === undefined ? undefined : this.#reference(args[0]);
        if (!(await runtime.actors.isActor(self))) return [];
        await runtime.actors.scriptKill(self, killer);
        return [];
      }
      case 'showracemenu':
        // TODO(M11): after the opening, a new race resets the skills (UESP, "Console").
        this.#context.showRaceMenu();
        return [];
      case 'qqq':
      case 'quitquitquit':
        this.#context.quit();
        return [];
      default:
        return [`Script command "${command}" not found.`];
    }
  }

  async #index(): Promise<
    Map<string, { formId: number; type: string; editorId: string; name: string }>
  > {
    this.#names ??= (async () => {
      const names = new Map<
        string,
        { formId: number; type: string; editorId: string; name: string }
      >();
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

  /** A form by editor id or hex form id. */
  async #form(name: string | undefined): Promise<number | undefined> {
    if (!name) return undefined;
    if (/^[0-9a-f]{1,8}$/i.test(name)) {
      const formId = parseInt(name, 16);
      if (await this.#context.runtime.forms.record(formId)) return formId;
    }
    return (await this.#index()).get(name.toLowerCase())?.formId;
  }

  /** A reference by hex form id, or the player. TODO(M13): references by editor id. */
  #reference(name: string): number | undefined {
    if (name.toLowerCase() === 'player') return PLAYER_REF;
    if (/^[0-9a-f]{1,8}$/i.test(name)) return parseInt(name, 16);
    return undefined;
  }

  async #help(text: string): Promise<string[]> {
    const needle = text.toLowerCase();
    const lines: string[] = [];
    for (const [editorId, form] of await this.#index()) {
      if (needle && !editorId.includes(needle) && !form.name.toLowerCase().includes(needle)) {
        continue;
      }
      const id = form.formId.toString(16).toUpperCase().padStart(8, '0');
      lines.push(`${form.type}: ${form.editorId} (${id}) '${form.name}'`);
      if (lines.length >= 200) break;
    }
    return lines;
  }

  async #centerOnCell(name: string): Promise<string[]> {
    const at = await cellPlacement(this.#context.db, name, async (cell) => {
      const found = (await this.#index()).get(cell);
      return found?.type === 'CELL' ? found.formId : undefined;
    });
    if (typeof at === 'string') return [at];
    await this.#context.travel(at);
    return [];
  }

  async #quest(command: string, args: readonly string[]): Promise<string[]> {
    const runtime = this.#context.runtime;
    const quest = await this.#form(args[0]);
    if (quest === undefined) return [`Item '${args[0] ?? ''}' not found for parameter Quest.`];
    switch (command) {
      case 'setstage':
        await runtime.quests.setStage(quest, Number(args[1] ?? '0') || 0);
        return [];
      case 'getstage':
        return [`GetStage >> ${String(runtime.state.quest(quest).stage)}.00`];
      case 'startquest':
        await runtime.quests.start(quest);
        return [];
      case 'stopquest':
        await runtime.quests.stop(quest);
        return [];
      default:
        runtime.quests.complete(quest);
        return [];
    }
  }

  async #set(args: readonly string[]): Promise<string[]> {
    const runtime = this.#context.runtime;
    const [name, to, text] = args;
    const value = Number(text);
    if (!name || to?.toLowerCase() !== 'to' || !Number.isFinite(value)) {
      return ['Syntax: set <global> to <value>'];
    }
    const global = await this.#form(name);
    if (global === undefined) return [`Item '${name}' not found for parameter Global.`];
    if (name.toLowerCase() === 'timescale') runtime.timeScale = value;
    if (!runtime.setClockGlobal(global, value)) runtime.state.globals.set(global, value);
    return [`>> ${name} = ${String(value)}`];
  }

  async #actorValue(command: string, actor: number, args: readonly string[]): Promise<string[]> {
    const actors = this.#context.runtime.actors;
    const index = actorValueIndex(args[0] ?? '');
    if (index === undefined)
      return [`Item '${args[0] ?? ''}' not found for parameter Actor Value.`];
    const now = await actors.value(actor, index);
    const amount = Number(args[1] ?? '0') || 0;
    if (command.startsWith('get'))
      return [`GetActorValue: ${args[0] ?? ''} >> ${String(now.current)}`];
    if (command.startsWith('set')) actors.setBase(actor, index, amount);
    else if (command.startsWith('mod')) actors.modify(actor, index, amount);
    // ForceActorValue: the current value becomes the amount (by the permanent modifier).
    else actors.modify(actor, index, amount - now.current);
    return [];
  }
}
