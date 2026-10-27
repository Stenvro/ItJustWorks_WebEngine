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
  /** Why each quest that last failed to start did not (the sandbox's quests show it). */
  readonly notStarted = new Map<number, string>();
  /** Start-up fragments held while a new game starts its quests (holdStartUps). */
  #heldStartUps: (() => Promise<void>)[] | undefined;

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
    this.filler = new AliasFiller(runtime);
  }

  /**
   * Holds the start-up stages' fragments of the quests started from now on until
   * releaseStartUps: a new game starts all its quests in one pass of the engine's main loop,
   * and Papyrus runs the fragments that queued only after it, so every one of those quests has
   * filled its aliases before any fragment runs (BYOHHouseBuilding's start-up reads the
   * town dialogue quests' jarls). Inferred from the engine's queued fragment calls.
   */
  holdStartUps(): void {
    this.#heldStartUps ??= [];
  }

  /** Runs the held start-up fragments, in the order their quests started. */
  releaseStartUps(): void {
    const held = this.#heldStartUps ?? [];
    this.#heldStartUps = undefined;
    for (const run of held) this.#runtime.detach(run());
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
      const why = `starts only from the story manager's ${record.event} event`;
      this.notStarted.set(quest, why);
      return false;
    }
    const runOnce = (record.flags & QuestFlag.runOnce) !== 0;
    if (runOnce && state.starts > 0) {
      this.notStarted.set(quest, 'it runs once, and it ran');
      return false;
    }
    if (event) state.event = event;
    else delete state.event;
    // Quests that start with a new game may take reserved references (Creation Kit).
    const newGame = runtime.startingNewGame && (record.flags & QuestFlag.startGameEnabled) !== 0;
    if (!(await this.filler.fillAll(record, newGame))) {
      if ((record.flags & QuestFlag.warnOnAliasFillFailure) !== 0) {
        runtime.warn(`${record.editorId}: an alias could not be filled, the quest does not start`);
      }
      const alias = this.filler.failures.get(quest);
      this.notStarted.set(
        quest,
        alias
          ? `its alias ${alias.name} found nobody to fill it (${alias.fill.kind})`
          : 'an alias could not be filled',
      );
      this.#clearAliases(quest);
      delete state.event;
      return false;
    }
    this.notStarted.delete(quest);
    state.running = true;
    state.starts++;
    // The engine's quest start event (TESQuestStartStopEvent).
    runtime.events.emit('questStartStop', { quest, started: true });
    state.completed = false;
    state.failed = false;
    // A quest that does not run once is reset as it starts: its scripts start over and their
    // OnInit runs again (start-game-enabled quests get it twice: at the game's start and now).
    if (!runOnce) {
      await this.#resetScripts(record);
      await this.initialize(record);
    }
    const startUp = record.stages.find((stage) => (stage.flags & StageFlag.startUp) !== 0);
    // The start-up stage is set as it starts; its fragment runs on a thread of its own.
    if (startUp) await this.#setStageRunning(record, startUp.index, false);
    // Its scenes that begin on quest start start (src/ai/scene-runtime.ts).
    runtime.detach(runtime.scenes.questStarted(quest));
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
    runtime.events.emit('questStartStop', { quest, started: false });
    // Its scenes end with it.
    runtime.scenes.questStopped(quest);
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
    // The current stage (GetStage) is the highest set: a lower stage set later is done but does
    // not take its place. From the data: MQ101Scene1 sets stage 15 ("get everyone moving") and
    // then 14, and the cart horses' packages hold from GetStage >= 15 to 20, so the carts would
    // stop halfway if 14 became the current stage. TODO(M13): confirm against the engine.
    state.stage = Math.max(state.stage, stage);
    // The engine's stage event (TESQuestStageEvent), as the stage is set.
    runtime.events.emit('questStage', { quest: record.formId, stage });
    // Every log entry whose conditions hold happens, in order: its flags, its journal text and
    // its fragment (each log entry has its own). Observed in the original: setting a stage
    // walks all its items and runs each whose conditions hold. MQ101's keep stages (250 to 450)
    // have an entry without conditions and one per FactionPath; the route's starts its scene.
    const entries = record.stages.find((s) => s.index === stage)?.logEntries ?? [];
    const chosen = new Set<number>();
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
      chosen.add(index);
      // Its journal text, if it has one, is the quest's latest for the player.
      if (entry.text) {
        state.log.push({ stage, entry: index });
        state.updated = ++runtime.state.questClock;
      }
      if ((entry.flags & LogEntryFlag.completeQuest) !== 0) this.complete(record.formId);
      if ((entry.flags & LogEntryFlag.failQuest) !== 0) this.fail(record.formId);
      // Its next quest (NAM0) starts nothing: MQ101's stage 100 names MQ102, which its scripts start
      // only as the player leaves Helgen (stage 700/800: MQ102A or MQ102B, then MQ102.Start).
      // Started at the execution, MQ102's Alduin alias took him from the tower (its patrol away
      // outranks MQ101's approach). TODO(M13): what the engine reads it for (the journal's order).
    }
    const attachments = await runtime.forms.attachments(record.formId);
    const fragments = (attachments?.fragments ?? [])
      .filter((fragment) => fragment.stage === stage && chosen.has(fragment.logEntry))
      .sort((a, b) => a.logEntry - b.logEntry);
    const run = async (): Promise<void> => {
      for (const fragment of fragments) {
        await runtime.vm.call(new ObjectHandle(record.formId, fragment.script), fragment.function);
      }
    };
    if (wait) await run();
    else if (this.#heldStartUps) this.#heldStartUps.push(run);
    else runtime.detach(run());
    return true;
  }

  /** The quest completed (a log entry's flag, CompleteQuest): the HUD announces it once. */
  complete(quest: number): void {
    const state = this.#runtime.state.quest(quest);
    if (!state.completed) this.#runtime.questUpdated(quest, 'completed');
    state.completed = true;
  }

  fail(quest: number): void {
    const state = this.#runtime.state.quest(quest);
    if (!state.failed) this.#runtime.questUpdated(quest, 'failed');
    state.failed = true;
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
    state.log.length = 0;
    state.completed = false;
    state.failed = false;
    await this.#resetScripts(record);
    if (running) await this.start(quest);
  }

  /**
   * Its scripts and its aliases' start over, in place: a script that started its own quest
   * (Survival_NeedBase.StartNeed: Start, then SetNeedStageValues) goes on with the reset script,
   * and what it sets after Start stays (PapyrusVm.restart).
   */
  async #resetScripts(record: QuestRecord): Promise<void> {
    const vm = this.#runtime.vm;
    await vm.restart(new ObjectHandle(record.formId, 'quest'));
    await Promise.all(
      record.aliases.map((alias) => vm.restart(new ObjectHandle(record.formId, 'form', alias.id))),
    );
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
    // The engine tells it (TESQuestInitEvent) once the quest's scripts are set going.
    this.#runtime.events.emit('questInit', { quest: record.formId });
  }

  /** Quest.GetAlias: the alias as a script object. */
  aliasHandle(quest: number, alias: number, location: boolean): Value {
    return new ObjectHandle(quest, location ? 'locationalias' : 'referencealias', alias);
  }
}
