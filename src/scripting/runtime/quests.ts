// Quests as the Creation Kit describes them (Quest Script, Quest Stages Tab, Quest Data Tab):
// starting fills the aliases in order (an alias that is not optional and cannot be filled
// keeps the quest from starting), resets the quest unless it runs once (its scripts' OnInit
// runs again) and sets its start-up stage. Setting a stage starts the quest if it is not
// running; without "allow repeated stages" a stage is set only once; the stage's first log
// entry whose conditions hold may complete or fail the quest and start the next one; the
// caller waits for the stage's fragment. Stopping sets the shut-down stage and empties the
// aliases; completing a quest does not stop it. Platform-independent.
// Notes: docs/scripting.md ("Quests").

import { LogEntryFlag, QuestFlag, StageFlag, type QuestRecord } from '../../world/quest-records.ts';
import { ObjectHandle, type Value } from '../values.ts';
import { AliasFiller } from './alias-fill.ts';
import type { ScriptRuntime } from './runtime.ts';
import type { StoryEventData } from './story-manager.ts';

export class QuestEngine {
  readonly #runtime: ScriptRuntime;
  readonly filler: AliasFiller;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
    this.filler = new AliasFiller(runtime);
  }

  isRunning(quest: number): boolean {
    return this.#runtime.state.quests.get(quest)?.running ?? false;
  }

  /**
   * Quest.Start (or the story manager with its event): true once it runs (also when it ran
   * already). A quest with an event type starts only from that event (Creation Kit: "Quests
   * in the Story Manager").
   */
  async start(quest: number, event?: StoryEventData): Promise<boolean> {
    const runtime = this.#runtime;
    const record = await runtime.forms.quest(quest);
    if (!record) return false;
    const state = runtime.state.quest(quest);
    if (state.running) return true;
    if (record.event !== undefined && event?.type !== record.event) {
      runtime.warn(
        `${record.editorId}: starts only from the story manager's ${record.event} event`,
      );
      return false;
    }
    const runOnce = (record.flags & QuestFlag.runOnce) !== 0;
    if (runOnce && state.starts > 0) return false;
    if (event) state.event = event;
    else delete state.event;
    // Quests that start with a new game may take reserved references (Creation Kit).
    const newGame = runtime.startingNewGame && (record.flags & QuestFlag.startGameEnabled) !== 0;
    if (!(await this.filler.fillAll(record, newGame))) {
      if ((record.flags & QuestFlag.warnOnAliasFillFailure) !== 0) {
        runtime.warn(`${record.editorId}: an alias could not be filled, the quest does not start`);
      }
      this.#clearAliases(quest);
      delete state.event;
      return false;
    }
    state.running = true;
    state.starts++;
    state.completed = false;
    state.failed = false;
    // A quest that does not run once is reset as it starts: its scripts start over and their
    // OnInit runs again (start-game-enabled quests get it twice: at the game's start and now).
    if (!runOnce) {
      this.#resetScripts(record);
      await this.initialize(record);
    }
    const startUp = record.stages.find((stage) => (stage.flags & StageFlag.startUp) !== 0);
    // The start-up stage is set as it starts; its fragment runs on a thread of its own.
    if (startUp) await this.#setStageRunning(record, startUp.index, false);
    return true;
  }

  /** Quest.Stop: the shut-down stage runs, the aliases empty. */
  async stop(quest: number): Promise<void> {
    const runtime = this.#runtime;
    const record = await runtime.forms.quest(quest);
    const state = runtime.state.quests.get(quest);
    if (!record || !state?.running) return;
    const shutDown = record.stages.find((stage) => (stage.flags & StageFlag.shutDown) !== 0);
    if (shutDown) await this.#setStageRunning(record, shutDown.index);
    state.running = false;
    this.#clearAliases(quest);
  }

  #clearAliases(quest: number): void {
    const runtime = this.#runtime;
    const aliases = runtime.state.quest(quest).aliases;
    for (const [alias, filled] of aliases) runtime.aliasCleared(quest, alias, filled);
    aliases.clear();
  }

  /**
   * Quest.SetCurrentStageID: starts the quest if it does not run, marks the stage done and
   * runs its fragment (the caller waits). False if the stage was set already and the quest
   * does not allow repeated stages.
   */
  async setStage(quest: number, stage: number): Promise<boolean> {
    const record = await this.#runtime.forms.quest(quest);
    if (!record) return false;
    if (!this.isRunning(quest) && !(await this.start(quest))) return false;
    return this.#setStageRunning(record, stage);
  }

  async #setStageRunning(record: QuestRecord, stage: number, wait = true): Promise<boolean> {
    const runtime = this.#runtime;
    const state = runtime.state.quest(record.formId);
    const repeated = (record.flags & QuestFlag.allowRepeatedStages) !== 0;
    if (state.stagesDone.has(stage) && !repeated) return false;
    state.stagesDone.add(stage);
    state.stage = stage;
    // The first log entry whose conditions hold.
    // The first log entry whose conditions hold is the one that happens: its flags, its next
    // quest and its fragment (each log entry has its own; the others' do not run).
    const entries = record.stages.find((s) => s.index === stage)?.logEntries ?? [];
    let chosen: number | undefined;
    for (const [index, entry] of entries.entries()) {
      if (
        !(await runtime.conditionsHold(
          entry.conditions,
          new ObjectHandle(record.formId, 'quest'),
          state.event,
        ))
      ) {
        continue;
      }
      chosen = index;
      if ((entry.flags & LogEntryFlag.completeQuest) !== 0) state.completed = true;
      if ((entry.flags & LogEntryFlag.failQuest) !== 0) state.failed = true;
      if (entry.nextQuest !== undefined && entry.nextQuest !== 0) {
        runtime.detach(this.start(entry.nextQuest));
      }
      break;
    }
    const attachments = await runtime.forms.attachments(record.formId);
    const fragments = (attachments?.fragments ?? []).filter(
      (fragment) => fragment.stage === stage && fragment.logEntry === chosen,
    );
    const run = async (): Promise<void> => {
      for (const fragment of fragments) {
        await runtime.vm.call(new ObjectHandle(record.formId, fragment.script), fragment.function);
      }
    };
    if (wait) await run();
    else runtime.detach(run());
    return true;
  }

  /** Quest.Reset: back to its start (stages, objectives, aliases); not for run-once quests. */
  async reset(quest: number): Promise<void> {
    const runtime = this.#runtime;
    const record = await runtime.forms.quest(quest);
    if (!record || (record.flags & QuestFlag.runOnce) !== 0) return;
    const state = runtime.state.quest(quest);
    const running = state.running;
    if (running) await this.stop(quest);
    state.stagesDone.clear();
    state.stage = 0;
    state.objectives.clear();
    state.completed = false;
    state.failed = false;
    this.#resetScripts(record);
    if (running) await this.start(quest);
  }

  #resetScripts(record: QuestRecord): void {
    const vm = this.#runtime.vm;
    vm.reset(new ObjectHandle(record.formId, 'quest'));
    for (const alias of record.aliases) vm.reset(new ObjectHandle(record.formId, 'form', alias.id));
  }

  /**
   * Starts OnInit of the quest's scripts and its aliases' on threads of their own (calls into
   * them wait until it has finished); resolves once they run.
   */
  async initialize(record: QuestRecord): Promise<void> {
    const vm = this.#runtime.vm;
    await vm.startInitialize(new ObjectHandle(record.formId, 'quest'));
    await Promise.all(
      record.aliases.map((alias) =>
        vm.startInitialize(new ObjectHandle(record.formId, 'form', alias.id)),
      ),
    );
  }

  /** Quest.GetAlias: the alias as a script object. */
  aliasHandle(quest: number, alias: number, location: boolean): Value {
    return new ObjectHandle(quest, location ? 'locationalias' : 'referencealias', alias);
  }
}
