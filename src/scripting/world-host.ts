// Binds the Papyrus VM to the game data for playing a few scripts from a new game's state
// (player-home.ts: a home's purchases and HearthFire builds, shown in the sandbox): forms and
// their scripts come from the record database, and natives act on a WorldState (enable
// states, globals, quest stages, inventories). Natives that only matter to a running game
// (sounds, animations, UI) do nothing here and are listed as such. The running game has the
// full native API on the live world: src/scripting/runtime/.

import { parseVmad, type PropertyValue, type ScriptAttachments } from '../formats/esm/vmad.ts';
import { GroupType, RecordFlag } from '../formats/esm/record.ts';
import type { GameRecord, RecordDatabase } from '../world/record-db.ts';
import type { AttachedScriptInfo, NativeCall, NativeFunction, VmHost } from './papyrus-vm.ts';
import { ObjectHandle, PapyrusArray, formatValue, type Value } from './values.ts';
import { evaluateConditions } from './conditions.ts';
import { parseQuest } from '../world/quest-records.ts';

/** The player's reference (PlayerRef). */
export const PLAYER_REF = 0x14;

/** What scripts changed, on top of the plugins' initial state. */
export class WorldState {
  /** Own enable state of references a script enabled or disabled. */
  readonly enabled = new Map<number, boolean>();
  readonly globals = new Map<number, number>();
  readonly stagesDone = new Map<number, Set<number>>();
  readonly currentStage = new Map<number, number>();
  /** Item counts per container reference, by base form. */
  readonly inventories = new Map<number, Map<number, number>>();
  /** Forced references set on quest aliases, by "quest:alias". */
  readonly aliasRefs = new Map<string, number>();
  readonly messages: string[] = [];

  inventory(container: number): Map<number, number> {
    let items = this.inventories.get(container);
    if (!items) {
      items = new Map();
      this.inventories.set(container, items);
    }
    return items;
  }
}

const RECORD_TYPES: Readonly<Record<string, string>> = {
  REFR: 'objectreference',
  ACHR: 'actor',
  PGRE: 'objectreference',
  PHZD: 'objectreference',
  QUST: 'quest',
  GLOB: 'globalvariable',
  FLST: 'formlist',
  MISC: 'miscobject',
  INFO: 'topicinfo',
  LCTN: 'location',
  KYWD: 'keyword',
  CELL: 'cell',
  NPC_: 'actorbase',
  WEAP: 'weapon',
  ARMO: 'armor',
  BOOK: 'book',
  KEYM: 'key',
  ALCH: 'potion',
  INGR: 'ingredient',
  SPEL: 'spell',
  MGEF: 'magiceffect',
  MESG: 'message',
  SCEN: 'scene',
  PACK: 'package',
  FACT: 'faction',
  ACTI: 'activator',
  CONT: 'container',
  DOOR: 'door',
  FURN: 'furniture',
  LIGH: 'light',
  STAT: 'static',
  SOUN: 'sound',
  WRLD: 'worldspace',
  IDLE: 'idle',
  ENCH: 'enchantment',
  SHOU: 'shout',
  WOOP: 'wordofpower',
  OTFT: 'outfit',
  LVLI: 'leveleditem',
  LVLN: 'leveledactor',
  COBJ: 'constructibleobject',
  AMMO: 'ammo',
  SLGM: 'soulgem',
  SCRL: 'scroll',
  EXPL: 'explosion',
  PROJ: 'projectile',
  HAZD: 'hazard',
  IMOD: 'imagespacemodifier',
  EFSH: 'effectshader',
  VTYP: 'voicetype',
  ENCZ: 'encounterzone',
  TREE: 'treeobject',
  FLOR: 'flora',
  TACT: 'talkingactivator',
  ASPC: 'form',
  DIAL: 'topic',
  RACE: 'race',
  CLAS: 'class',
  PERK: 'perk',
};

/** Natives that change nothing the world state tracks. */
const NO_OPS = [
  'form.registerforsingleupdate',
  'form.registerforupdate',
  'form.unregisterforupdate',
  'form.registerforanimationevent',
  'form.unregisterforanimationevent',
  'form.registerforsingleupdategametime',
  'objectreference.moveto',
  'objectreference.blockactivation',
  'objectreference.setopen',
  'objectreference.lock',
  'objectreference.playanimation',
  'objectreference.playgamebryoanimation',
  'objectreference.setmotiontype',
  'objectreference.setdestroyed',
  'objectreference.addtomap',
  'objectreference.enablefasttravel',
  'objectreference.setactorowner',
  'objectreference.setfactionowner',
  'objectreference.translateto',
  'objectreference.setposition',
  'objectreference.setangle',
  'objectreference.reset',
  'objectreference.setnodestate',
  'quest.setobjectivedisplayed',
  'quest.setobjectivecompleted',
  'quest.setobjectivefailed',
  'quest.setactive',
  'quest.completequest',
  'quest.completeallobjectives',
  'location.setkeyworddata',
  'game.addachievement',
  'game.incrementstat',
  'game.queryStat',
  'utility.wait',
  'utility.waitgametime',
  'utility.waitmenumode',
  'debug.trace',
  'debug.tracestack',
  'debug.traceconditional',
  'actor.evaluatepackage',
  'actor.setplayerteammate',
  'actor.setrelationshiprank',
  'actor.addtofaction',
  'actor.removefromfaction',
  'actor.setoutfit',
  'actor.moveto',
  'alias.registerforsingleupdate',
  'referencealias.clear',
  'locationalias.clear',
];

/** Records and their script attachments, read once and shared by many VM runs. */
export class FormCache {
  readonly db: RecordDatabase;
  readonly #records = new Map<number, Promise<GameRecord | undefined>>();
  readonly #vmad = new Map<number, Promise<ScriptAttachments | undefined>>();

  constructor(db: RecordDatabase) {
    this.db = db;
  }

  record(formId: number): Promise<GameRecord | undefined> {
    let pending = this.#records.get(formId);
    if (!pending) {
      pending = this.db.get(formId);
      this.#records.set(formId, pending);
    }
    return pending;
  }

  /** The script attachments (VMAD) of a form; undefined if it has none or they are corrupt. */
  attachments(formId: number): Promise<ScriptAttachments | undefined> {
    let pending = this.#vmad.get(formId);
    if (!pending) {
      pending = this.record(formId).then((record) => {
        const data = record?.fields.first('VMAD');
        if (!record || !data) return undefined;
        try {
          return parseVmad(data, record.type);
        } catch {
          return undefined;
        }
      });
      this.#vmad.set(formId, pending);
    }
    return pending;
  }

  /** The forms in a form list (FLST), as global form ids. */
  async formList(formId: number): Promise<number[]> {
    const record = await this.record(formId);
    return record?.fields.all('LNAM').map((data) => record.formIdAt(data)) ?? [];
  }
}

export class GameHost implements VmHost {
  readonly db: RecordDatabase;
  readonly cache: FormCache;
  readonly state: WorldState;
  readonly #natives = new Map<string, NativeFunction>();
  readonly #warn: (message: string) => void;

  constructor(cache: FormCache, state: WorldState, warn: (message: string) => void) {
    this.cache = cache;
    this.db = cache.db;
    this.state = state;
    this.#warn = warn;
    for (const name of NO_OPS) this.#natives.set(name.toLowerCase(), () => null);
    this.#registerNatives();
  }

  warn(message: string): void {
    this.#warn(message);
  }

  record(formId: number): Promise<GameRecord | undefined> {
    return this.cache.record(formId);
  }

  attachments(formId: number): Promise<ScriptAttachments | undefined> {
    return this.cache.attachments(formId);
  }

  async formType(target: ObjectHandle): Promise<string | undefined> {
    if (target.alias >= 0) {
      const alias = await this.#alias(target.formId, target.alias);
      return alias?.location ? 'locationalias' : 'referencealias';
    }
    if (target.formId === PLAYER_REF) return 'actor'; // created by the engine, not in a plugin
    const record = await this.record(target.formId);
    return record ? (RECORD_TYPES[record.type] ?? 'form') : undefined;
  }

  async attachedScripts(target: ObjectHandle): Promise<readonly AttachedScriptInfo[]> {
    const record = await this.record(target.formId);
    const attachments = await this.attachments(target.formId);
    if (!record || !attachments) return [];
    const scripts =
      target.alias >= 0
        ? (attachments.aliases.find((a) => a.alias === target.alias)?.scripts ?? [])
        : attachments.scripts;
    return scripts.map((script) => ({
      name: script.name,
      properties: new Map(
        script.properties.map((p) => [p.name.toLowerCase(), this.#value(record, p.value)]),
      ),
    }));
  }

  #object(record: GameRecord, formId: number, alias: number): Value {
    if (formId === 0) return null;
    return new ObjectHandle(this.db.toGlobal(record.plugin, formId), 'form', alias);
  }

  #value(record: GameRecord, value: PropertyValue): Value {
    switch (value.type) {
      case 'object':
        return this.#object(record, value.value.formId, value.value.alias);
      case 'object[]':
        return new PapyrusArray(value.value.map((v) => this.#object(record, v.formId, v.alias)));
      case 'string[]':
      case 'int[]':
      case 'float[]':
      case 'bool[]':
        return new PapyrusArray([...value.value]);
      default:
        return value.value;
    }
  }

  native(script: string, fn: string): NativeFunction | undefined {
    return this.#natives.get(`${script}.${fn}`);
  }

  // --- Enable state ---------------------------------------------------------------------

  /** Whether a reference is enabled: its own state, or its enable parent's. */
  async isEnabled(formId: number, depth = 0): Promise<boolean> {
    const record = await this.record(formId);
    if (!record) return false;
    const xesp = record.fields.first('XESP');
    if (xesp && xesp.length >= 5 && depth < 16) {
      const parent = await this.isEnabled(record.formIdAt(xesp), depth + 1);
      return ((xesp[4] ?? 0) & 1) !== 0 ? !parent : parent;
    }
    return this.state.enabled.get(formId) ?? (record.flags & RecordFlag.initiallyDisabled) === 0;
  }

  async #setEnabled(target: Value, enabled: boolean, where: () => string): Promise<void> {
    if (!(target instanceof ObjectHandle)) return;
    const formId = await this.#reference(target);
    if (formId === undefined) return;
    const record = await this.record(formId);
    if (record?.fields.has('XESP')) {
      // The engine ignores Enable/Disable on references with an enable parent and logs it as
      // an error of the calling script (src/scripting/runtime/runtime.ts setEnabled).
      this.warn(
        `${where()}: cannot ${enabled ? 'enable' : 'disable'} an object with an enable state parent (${record.editorId ?? formatValue(target)})`,
      );
      return;
    }
    this.state.enabled.set(formId, enabled);
  }

  /** The reference an object handle stands for (an alias's forced reference). */
  async #reference(target: ObjectHandle): Promise<number | undefined> {
    if (target.alias < 0) return target.formId;
    return this.aliasReference(target.formId, target.alias);
  }

  async aliasReference(quest: number, alias: number): Promise<number | undefined> {
    const set = this.state.aliasRefs.get(`${String(quest)}:${String(alias)}`);
    if (set !== undefined) return set;
    return (await this.#alias(quest, alias))?.forced;
  }

  /**
   * A quest alias from the QUST record: ALST starts a reference alias, ALLS a location
   * alias; ALFR / ALFL give its forced reference / location.
   */
  async #alias(
    quest: number,
    alias: number,
  ): Promise<{ location: boolean; forced: number | undefined } | undefined> {
    const record = await this.record(quest);
    if (!record) return undefined;
    let found: { location: boolean; forced: number | undefined } | undefined;
    for (const field of record.fields.list) {
      if ((field.type === 'ALST' || field.type === 'ALLS') && field.data.length >= 4) {
        if (found) return found;
        const id = new DataView(field.data.buffer, field.data.byteOffset, 4).getUint32(0, true);
        if (id === alias) found = { location: field.type === 'ALLS', forced: undefined };
      } else if (
        found &&
        (field.type === 'ALFR' || field.type === 'ALFL') &&
        field.data.length >= 4
      ) {
        found.forced = record.formIdAt(field.data);
      }
    }
    return found;
  }

  // --- Items ------------------------------------------------------------------------------

  async #items(form: Value): Promise<number[]> {
    if (!(form instanceof ObjectHandle)) return [];
    const record = await this.record(form.formId);
    if (record?.type === 'FLST') return this.formList(form.formId);
    return [form.formId];
  }

  formList(formId: number): Promise<number[]> {
    return this.cache.formList(formId);
  }

  async #container(self: ObjectHandle | null): Promise<number | undefined> {
    return self ? this.#reference(self) : undefined;
  }

  // --- Natives -----------------------------------------------------------------------------

  #registerNatives(): void {
    const n = (name: string, fn: NativeFunction): void => {
      this.#natives.set(name, fn);
    };
    const handle = (formId: number | undefined, type: string): Value =>
      formId === undefined || formId === 0 ? null : new ObjectHandle(formId, type);
    const num = (value: Value): number => (typeof value === 'number' ? value : 0);

    n('form.getformid', ({ self }) => self?.formId ?? 0);

    n('objectreference.enable', async ({ self, where }) =>
      this.#setEnabled(self, true, where).then(() => null),
    );
    n('objectreference.enablenowait', async ({ self, where }) =>
      this.#setEnabled(self, true, where).then(() => null),
    );
    n('objectreference.disable', async ({ self, where }) =>
      this.#setEnabled(self, false, where).then(() => null),
    );
    n('objectreference.disablenowait', async ({ self, where }) =>
      this.#setEnabled(self, false, where).then(() => null),
    );
    n('objectreference.isdisabled', async ({ self }) => {
      const formId = self && (await this.#reference(self));
      return formId === undefined || formId === null ? false : !(await this.isEnabled(formId));
    });
    n('objectreference.getbaseobject', async ({ self }) => {
      const formId = self && (await this.#reference(self));
      const record = formId ? await this.record(formId) : undefined;
      return handle(record?.formIdField('NAME'), 'form');
    });
    n('objectreference.additem', async ({ self, args }) => {
      const container = await this.#container(self);
      if (container === undefined) return null;
      const items = this.state.inventory(container);
      for (const item of await this.#items(args[0] ?? null)) {
        items.set(item, (items.get(item) ?? 0) + Math.max(1, num(args[1] ?? 1)));
      }
      return null;
    });
    n('objectreference.removeitem', async ({ self, args }) => {
      const container = await this.#container(self);
      if (container === undefined) return null;
      const items = this.state.inventory(container);
      const target = args[3];
      const destination =
        target instanceof ObjectHandle ? await this.#reference(target) : undefined;
      for (const item of await this.#items(args[0] ?? null)) {
        const have = items.get(item) ?? 0;
        const moved = Math.min(have, Math.max(1, num(args[1] ?? 1)));
        if (moved <= 0) continue;
        items.set(item, have - moved);
        if (destination !== undefined) {
          const other = this.state.inventory(destination);
          other.set(item, (other.get(item) ?? 0) + moved);
        }
      }
      return null;
    });
    n('objectreference.getitemcount', async ({ self, args }) => {
      const container = await this.#container(self);
      if (container === undefined) return 0;
      const items = this.state.inventory(container);
      let count = 0;
      for (const item of await this.#items(args[0] ?? null)) count += items.get(item) ?? 0;
      return count;
    });
    n('objectreference.getcurrentlocation', () => null);
    n('objectreference.getparentcell', () => null);

    n('formlist.getat', async ({ self, args }) => {
      const items = self ? await this.formList(self.formId) : [];
      return handle(items[num(args[0] ?? 0)], 'form');
    });
    n('formlist.getsize', async ({ self }) =>
      self ? (await this.formList(self.formId)).length : 0,
    );
    n('formlist.find', async ({ self, args }) => {
      const form = args[0];
      if (!self || !(form instanceof ObjectHandle)) return -1;
      return (await this.formList(self.formId)).indexOf(form.formId);
    });
    n('formlist.hasform', async ({ self, args }) => {
      const form = args[0];
      if (!self || !(form instanceof ObjectHandle)) return false;
      return (await this.formList(self.formId)).includes(form.formId);
    });

    n('globalvariable.getvalue', async ({ self }) => {
      if (!self) return 0;
      const set = this.state.globals.get(self.formId);
      if (set !== undefined) return set;
      return (await this.record(self.formId))?.fields.f32('FLTV') ?? 0;
    });
    n('globalvariable.setvalue', ({ self, args }) => {
      if (self) this.state.globals.set(self.formId, num(args[0] ?? 0));
      return null;
    });

    n('quest.setcurrentstageid', (call) => this.#setStage(call));
    n('quest.isstagedone', ({ self, args }) =>
      self ? (this.state.stagesDone.get(self.formId)?.has(num(args[0] ?? 0)) ?? false) : false,
    );
    n('quest.getcurrentstageid', ({ self }) =>
      self ? (this.state.currentStage.get(self.formId) ?? 0) : 0,
    );
    n('quest.isrunning', ({ self }) => (self ? this.state.stagesDone.has(self.formId) : false));
    n('quest.start', () => true);
    n('quest.stop', () => null);
    n('quest.getalias', ({ self, args }) =>
      self ? new ObjectHandle(self.formId, 'referencealias', num(args[0] ?? 0)) : null,
    );
    n('referencealias.getreference', async ({ self }) =>
      self ? handle(await this.aliasReference(self.formId, self.alias), 'objectreference') : null,
    );
    n('referencealias.forcerefto', ({ self, args }) => {
      const ref = args[0];
      if (self && ref instanceof ObjectHandle) {
        this.state.aliasRefs.set(`${String(self.formId)}:${String(self.alias)}`, ref.formId);
      }
      return null;
    });
    n('alias.getowningquest', ({ self }) => (self ? new ObjectHandle(self.formId, 'quest') : null));

    n('topicinfo.getowningquest', async ({ self }) => {
      if (!self) return null;
      const location = this.db.locate(self.formId);
      const group = location && this.db.parentGroup(location);
      if (group?.type !== GroupType.topicChildren) return null;
      const topic = await this.record(group.label);
      return handle(topic?.formIdField('QNAM'), 'quest');
    });

    n('game.getplayer', () => new ObjectHandle(PLAYER_REF, 'actor'));
    n('game.getform', ({ args }) => handle(num(args[0] ?? 0), 'form'));
    n('utility.randomint', ({ args }) => num(args[0] ?? 0));
    n('utility.randomfloat', ({ args }) => num(args[0] ?? 0));
    n('utility.getcurrentgametime', () => 0);
    n('debug.notification', ({ args }) => {
      this.state.messages.push(formatValue(args[0] ?? null));
      return null;
    });
    n('debug.messagebox', ({ args }) => {
      this.state.messages.push(formatValue(args[0] ?? null));
      return null;
    });
    n('location.issamelocation', ({ self, args }) => {
      const other = args[0];
      return self !== null && other instanceof ObjectHandle && self.sameObject(other);
    });
    n('location.getkeyworddata', () => 0);
    n('locationalias.getlocation', async ({ self }) => {
      if (!self) return null;
      return handle((await this.#alias(self.formId, self.alias))?.forced, 'location');
    });
    n('quest.updatecurrentinstanceglobal', () => true);
    n('message.show', () => 0);
    n('actor.isdead', () => false);
  }

  /**
   * Quest.SetCurrentStageID: marks the stage done and runs its fragment, on a thread of
   * its own; the caller waits for them, unlocked meanwhile (the Creation Kit warns that setting
   * a stage in OnInit can deadlock: the fragment waits for the OnInit that waits for it).
   */
  async #setStage({ vm, self, args, latent }: NativeCall): Promise<Value> {
    if (!self) return false;
    const stage = typeof args[0] === 'number' ? args[0] : 0;
    const done = this.state.stagesDone.get(self.formId) ?? new Set<number>();
    done.add(stage);
    this.state.stagesDone.set(self.formId, done);
    this.state.currentStage.set(self.formId, stage);
    const attachments = await this.attachments(self.formId);
    // A fragment belongs to a log entry and only the entry that happens runs its own: the
    // first whose conditions hold (as src/scripting/runtime/quests.ts).
    const record = await this.record(self.formId);
    const entries =
      (record && parseQuest(record).stages.find((s) => s.index === stage)?.logEntries) ?? [];
    let entry: number | undefined;
    for (const [index, logEntry] of entries.entries()) {
      if (await evaluateConditions(logEntry.conditions, vm, this, PLAYER_REF)) {
        entry = index;
        break;
      }
    }
    for (const fragment of attachments?.fragments ?? []) {
      if (fragment.stage !== stage || fragment.logEntry !== entry) continue;
      await latent(vm.call(new ObjectHandle(self.formId, fragment.script), fragment.function));
    }
    return true;
  }
}
