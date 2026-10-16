// The game data packages are started from (PackageWorld over the record database): packages,
// where references and cells are, globals, and the quests at the start of a new game. Quests
// that start with the game (QUST DNAM 0x01) run, and their start-up stage (INDX flag 0x02) is
// done; where that stage runs a script fragment, what the script sets is not known. Other
// quests have not started: stage 0, no stage done. Once the running game's scripts are there,
// their quests, aliases and globals are used instead. Platform-independent.
// Notes: docs/ai.md ("Where packages put actors").

import { view } from '../formats/esm/fields.ts';
import { parseVmad } from '../formats/esm/vmad.ts';
import { parseReference } from '../world/cell-records.ts';
import type { RecordDatabase } from '../world/record-db.ts';
import { globalValue } from '../scripting/runtime/condition-values.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { parsePackage, type PackageRecord } from './package-records.ts';
import type { PackageActor, PackageReference, PackageWorld, Space } from './package-start.ts';

/** QUST DNAM flag: the quest starts with the game. */
const START_GAME_ENABLED = 0x01;
/** QUST INDX flag: the stage set when the quest starts. */
const START_UP_STAGE = 0x02;
/** CELL DATA flag: an interior. */
const CELL_INTERIOR = 0x01;

/** Stages set so far (the scripts' world state), over the new game's. */
export interface QuestStates {
  readonly currentStage: ReadonlyMap<number, number>;
  readonly stagesDone: ReadonlyMap<number, ReadonlySet<number>>;
}

/** The quests running at the start and the actors their aliases with packages hold. */
interface QuestIndex {
  readonly startEnabled: ReadonlySet<number>;
  /**
   * Of those, the ones whose start is known (no script fragment on their start-up stage): the
   * stage they are at and the stages done.
   */
  readonly started: ReadonlyMap<number, { stage: number; done: ReadonlySet<number> }>;
  /** Forced references (ALFR) and unique actors (ALUA, NPC_) → quests with alias packages. */
  readonly holders: ReadonlyMap<number, readonly number[]>;
}

export class PackageData implements PackageWorld {
  readonly #db: RecordDatabase;
  readonly #states: () => QuestStates | undefined;
  readonly #packages = new Map<number, Promise<PackageRecord | undefined>>();
  readonly #globals = new Map<number, number | undefined>();
  #quests: Promise<QuestIndex> | undefined;
  #index: QuestIndex | undefined;

  readonly #scripts: () => ScriptRuntime | undefined;

  /**
   * `states`: the stages scripts have set (the player-home quests'), if any ran;
   * `scripts`: the running game's scripts, whose quests, aliases and globals are then the
   * truth.
   */
  constructor(
    db: RecordDatabase,
    states: () => QuestStates | undefined = () => undefined,
    scripts: () => ScriptRuntime | undefined = () => undefined,
  ) {
    this.#db = db;
    this.#states = states;
    this.#scripts = scripts;
  }

  /** Reads the quests once (aliasPackages and the quest state need them). */
  async ready(): Promise<void> {
    this.#quests ??= this.#readQuests();
    this.#index = await this.#quests;
  }

  package(formId: number): Promise<PackageRecord | undefined> {
    let entry = this.#packages.get(formId);
    if (!entry) {
      entry = this.#db
        .get(formId)
        .then((record) =>
          record?.type === 'PACK' && !record.deleted ? parsePackage(record) : undefined,
        );
      this.#packages.set(formId, entry);
    }
    return entry;
  }

  async reference(formId: number): Promise<PackageReference | undefined> {
    const record = await this.#db.get(formId);
    if (!record || record.deleted) return undefined;
    const cell = this.#db.cellOfReference(formId);
    const space = cell === undefined ? undefined : await this.cellSpace(cell);
    if (!space) return undefined;
    const base = await this.#db.get(record.formIdField('NAME') ?? 0);
    return { space, baseType: base?.type ?? '', position: parseReference(record).position };
  }

  async cellSpace(cell: number): Promise<Space | undefined> {
    const record = await this.#db.get(cell);
    if (record?.type !== 'CELL') return undefined;
    const data = record.fields.first('DATA');
    if (data && data.length >= 1 && ((data[0] ?? 0) & CELL_INTERIOR) !== 0) {
      return { kind: 'interior', cell };
    }
    const world = this.#db.worldOfCell(cell);
    return world === undefined ? undefined : { kind: 'world', world };
  }

  global(formId: number): number | undefined {
    return this.#globals.get(formId);
  }

  async readGlobals(formIds: Iterable<number>): Promise<void> {
    const runtime = this.#scripts();
    for (const formId of formIds) {
      // The running game's values (scripts set them; the clock's move).
      if (runtime) {
        this.#globals.set(formId, await globalValue(runtime, formId));
        continue;
      }
      if (this.#globals.has(formId)) continue;
      const record = await this.#db.get(formId);
      this.#globals.set(formId, record?.type === 'GLOB' ? record.fields.f32('FLTV') : undefined);
    }
  }

  questStage(quest: number): number | undefined {
    const runtime = this.#scripts();
    if (runtime) return runtime.state.quests.get(quest)?.stage ?? 0;
    const set = this.#states()?.currentStage.get(quest);
    if (set !== undefined) return set;
    if (!this.#startsWithGame(quest)) return 0;
    return this.#index?.started.get(quest)?.stage;
  }

  stageDone(quest: number, stage: number): boolean | undefined {
    const runtime = this.#scripts();
    if (runtime) return runtime.state.quests.get(quest)?.stagesDone.has(stage) ?? false;
    if (this.#states()?.stagesDone.get(quest)?.has(stage) === true) return true;
    if (!this.#startsWithGame(quest)) return false;
    return this.#index?.started.get(quest)?.done.has(stage);
  }

  questRunning(quest: number): boolean | undefined {
    const runtime = this.#scripts();
    if (runtime) return runtime.quests.isRunning(quest);
    if (this.#states()?.stagesDone.has(quest) === true) return true;
    return this.#index ? this.#index.startEnabled.has(quest) : undefined;
  }

  questCompleted(quest: number): boolean | undefined {
    const runtime = this.#scripts();
    if (runtime) return runtime.state.quests.get(quest)?.completed ?? false;
    return !this.#startsWithGame(quest) || this.#index?.started.has(quest) === true
      ? false
      : undefined;
  }

  async aliasPackages(actor: PackageActor): Promise<readonly number[] | undefined> {
    const runtime = this.#scripts();
    if (runtime) {
      // The aliases that hold it now, their quests by priority (the highest first).
      const held: { priority: number; packages: readonly number[] }[] = [];
      for (const { quest, alias } of runtime.aliasesHolding(actor.reference)) {
        const record = await runtime.forms.quest(quest);
        const packages = record?.aliases.find((entry) => entry.id === alias)?.packages ?? [];
        if (record && packages.length > 0) held.push({ priority: record.priority, packages });
      }
      return held.sort((a, b) => b.priority - a.priority).flatMap((entry) => entry.packages);
    }
    await this.ready();
    const holders = this.#index?.holders;
    const quests = [
      ...(holders?.get(actor.reference) ?? []),
      ...(holders?.get(actor.base) ?? []),
      ...(actor.npc === actor.base ? [] : (holders?.get(actor.npc) ?? [])),
    ];
    return quests.length > 0 ? undefined : [];
  }

  /** Whether a quest starts with the game (unknown until the quests are read). */
  #startsWithGame(quest: number): boolean {
    return this.#index?.startEnabled.has(quest) ?? true;
  }

  async #readQuests(): Promise<QuestIndex> {
    const startEnabled = new Set<number>();
    const started = new Map<number, { stage: number; done: Set<number> }>();
    const holders = new Map<number, number[]>();
    for (const formId of this.#db.formIdsOfType('QUST')) {
      const record = await this.#db.get(formId);
      if (!record || record.deleted) continue;
      const dnam = record.fields.first('DNAM');
      if (!dnam || dnam.length < 1 || ((dnam[0] ?? 0) & START_GAME_ENABLED) === 0) continue;
      startEnabled.add(formId);
      // Its start-up stage, and whether a script fragment runs on it.
      const startUp: number[] = [];
      for (const { type, data } of record.fields.list) {
        if (type === 'INDX' && data.length >= 3 && ((data[2] ?? 0) & START_UP_STAGE) !== 0) {
          startUp.push(view(data).getInt16(0, true));
        }
      }
      const vmad = record.fields.first('VMAD');
      let scripted = false;
      if (vmad && startUp.length > 0) {
        try {
          scripted = parseVmad(vmad, 'QUST').fragments.some(
            (fragment) => typeof fragment.stage === 'number' && startUp.includes(fragment.stage),
          );
        } catch {
          scripted = true;
        }
      }
      if (!scripted) {
        started.set(formId, { stage: Math.max(0, ...startUp), done: new Set(startUp) });
      }
      // Its reference aliases: whom they hold (forced reference, unique actor), and whether
      // they give packages.
      let held: number[] = [];
      let packages = false;
      for (const { type, data } of record.fields.list) {
        if (type === 'ALST' || type === 'ALLS') {
          held = [];
          packages = false;
        } else if ((type === 'ALFR' || type === 'ALUA') && data.length >= 4) {
          held.push(record.formIdAt(data, 0));
        } else if (type === 'ALPC' && data.length >= 4 && view(data).getUint32(0, true) !== 0) {
          packages = true;
        } else if (type === 'ALED' && packages) {
          for (const reference of held) {
            const quests = holders.get(reference) ?? [];
            quests.push(formId);
            holders.set(reference, quests);
          }
        }
      }
    }
    return { startEnabled, started, holders };
  }
}
