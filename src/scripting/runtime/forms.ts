// The game's forms as scripts see them: the native script type of each record, the scripts
// attached to a form (a reference runs its own and its base object's; aliases run those the
// quest gives them), quests parsed once, and the placed reference of each unique actor.
// Platform-independent. Notes: docs/scripting.md ("Forms").

import { parseVmad, type PropertyValue, type ScriptAttachments } from '../../formats/esm/vmad.ts';
import { parseQuest, type QuestAlias, type QuestRecord } from '../../world/quest-records.ts';
import type { GameRecord, RecordDatabase } from '../../world/record-db.ts';
import type { AttachedScriptInfo } from '../papyrus-vm.ts';
import { ObjectHandle, PapyrusArray, type Value } from '../values.ts';

/** The player's reference (PlayerRef) and base (Player). */
export const PLAYER_REF = 0x14;
export const PLAYER_BASE = 0x7;

/** The native script of each record type. */
export const SCRIPT_TYPES: Readonly<Record<string, string>> = {
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
  LCRT: 'locationreftype',
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
  MSTT: 'movablestatic',
  SOUN: 'sound',
  SNDR: 'sounddescriptor',
  WRLD: 'worldspace',
  IDLE: 'idle',
  ENCH: 'enchantment',
  SHOU: 'shout',
  WOOP: 'wordofpower',
  OTFT: 'outfit',
  LVLI: 'leveleditem',
  LVLN: 'leveledactor',
  LVSP: 'leveledspell',
  COBJ: 'constructibleobject',
  AMMO: 'ammo',
  SLGM: 'soulgem',
  SCRL: 'scroll',
  EXPL: 'explosion',
  PROJ: 'projectile',
  HAZD: 'hazard',
  IMAD: 'imagespacemodifier',
  EFSH: 'effectshader',
  VTYP: 'voicetype',
  ENCZ: 'encounterzone',
  TREE: 'treeobject',
  FLOR: 'flora',
  TACT: 'talkingactivator',
  DIAL: 'topic',
  RACE: 'race',
  CLAS: 'class',
  PERK: 'perk',
  WTHR: 'weather',
  MUSC: 'musictype',
  SNCT: 'soundcategory',
  SPGD: 'shaderparticlegeometry',
  RFCT: 'visualeffect',
  ASTP: 'associationtype',
  EQUP: 'equipslot',
  IPDS: 'form',
  ASPC: 'form',
};

export class FormIndex {
  readonly db: RecordDatabase;
  readonly #records = new Map<number, Promise<GameRecord | undefined>>();
  readonly #vmad = new Map<number, Promise<ScriptAttachments | undefined>>();
  readonly #quests = new Map<number, Promise<QuestRecord | undefined>>();
  #unique: Promise<Map<number, number>> | undefined;

  constructor(db: RecordDatabase) {
    this.db = db;
  }

  /** Every version of a record in load order (the last one wins). */
  async versions(formId: number): Promise<GameRecord[]> {
    return Promise.all(this.db.locateAll(formId).map((location) => this.db.read(location)));
  }

  record(formId: number): Promise<GameRecord | undefined> {
    let pending = this.#records.get(formId);
    if (!pending) {
      pending = this.db.get(formId).then((record) => (record?.deleted ? undefined : record));
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

  quest(formId: number): Promise<QuestRecord | undefined> {
    let pending = this.#quests.get(formId);
    if (!pending) {
      pending = this.record(formId).then((record) =>
        record?.type === 'QUST' ? parseQuest(record) : undefined,
      );
      this.#quests.set(formId, pending);
    }
    return pending;
  }

  async alias(quest: number, alias: number): Promise<QuestAlias | undefined> {
    return (await this.quest(quest))?.aliases.find((entry) => entry.id === alias);
  }

  /** A form's native script type ("actor", "quest", ...); aliases are reference or location. */
  async scriptType(target: ObjectHandle): Promise<string | undefined> {
    if (target.alias >= 0) {
      const alias = await this.alias(target.formId, target.alias);
      return alias?.location ? 'locationalias' : 'referencealias';
    }
    if (target.formId === PLAYER_REF) return 'actor';
    const record = await this.record(target.formId);
    return record ? (SCRIPT_TYPES[record.type] ?? 'form') : undefined;
  }

  /**
   * The scripts attached to a form: a reference's own (VMAD) and its base object's (the
   * reference's property values win for a script both name), a quest's, an alias's.
   */
  async attachedScripts(target: ObjectHandle): Promise<AttachedScriptInfo[]> {
    if (target.alias >= 0) {
      const record = await this.record(target.formId);
      const attachments = await this.attachments(target.formId);
      const scripts = attachments?.aliases.find((a) => a.alias === target.alias)?.scripts ?? [];
      return record ? scripts.map((script) => this.#info(record, script)) : [];
    }
    const record = await this.record(target.formId);
    if (!record) return [];
    const own = (await this.attachments(target.formId))?.scripts ?? [];
    const scripts = own.map((script) => this.#info(record, script));
    if (record.type === 'REFR' || record.type === 'ACHR' || record.type === 'PGRE') {
      const base = record.formIdField('NAME');
      const baseRecord = base === undefined ? undefined : await this.record(base);
      const baseScripts = base === undefined ? [] : ((await this.attachments(base))?.scripts ?? []);
      for (const script of baseScripts) {
        if (!baseRecord) break;
        const info = this.#info(baseRecord, script);
        const mine = scripts.find(
          (entry) => entry.name.toLowerCase() === script.name.toLowerCase(),
        );
        if (!mine) {
          scripts.push(info);
          continue;
        }
        // The base's values for the properties the reference does not set.
        const merged = new Map(info.properties);
        for (const [name, value] of mine.properties) merged.set(name, value);
        scripts[scripts.indexOf(mine)] = { name: mine.name, properties: merged };
      }
    }
    return scripts;
  }

  #info(
    record: GameRecord,
    script: {
      readonly name: string;
      readonly properties: readonly { readonly name: string; readonly value: PropertyValue }[];
    },
  ): AttachedScriptInfo {
    return {
      name: script.name,
      properties: new Map(
        script.properties.map((p) => [p.name.toLowerCase(), this.value(record, p.value)]),
      ),
    };
  }

  /** A property value of a record's VMAD as a Papyrus value (forms as global handles). */
  value(record: GameRecord, value: PropertyValue): Value {
    const object = (formId: number, alias: number): Value =>
      formId === 0
        ? null
        : new ObjectHandle(this.db.toGlobal(record.plugin, formId), 'form', alias);
    switch (value.type) {
      case 'object':
        return object(value.value.formId, value.value.alias);
      case 'object[]':
        return new PapyrusArray(value.value.map((v) => object(v.formId, v.alias)));
      case 'string[]':
      case 'int[]':
      case 'float[]':
      case 'bool[]':
        return new PapyrusArray([...value.value]);
      default:
        return value.value;
    }
  }

  /** The forms in a form list (FLST), as global form ids. */
  async formList(formId: number): Promise<number[]> {
    const record = await this.record(formId);
    return record?.fields.all('LNAM').map((data) => record.formIdAt(data)) ?? [];
  }

  /** The placed reference (ACHR) of a unique actor (an NPC_ placed once); the player's. */
  async uniqueReference(npc: number): Promise<number | undefined> {
    if (npc === PLAYER_BASE) return PLAYER_REF;
    this.#unique ??= (async () => {
      const byBase = new Map<number, number[]>();
      for (const formId of this.db.formIdsOfType('ACHR')) {
        const record = await this.record(formId);
        const base = record?.formIdField('NAME');
        if (base === undefined) continue;
        const refs = byBase.get(base) ?? [];
        refs.push(formId);
        byBase.set(base, refs);
      }
      const unique = new Map<number, number>();
      for (const [base, refs] of byBase) {
        const [only] = refs;
        if (refs.length === 1 && only !== undefined) unique.set(base, only);
      }
      return unique;
    })();
    return (await this.#unique).get(npc);
  }
}
