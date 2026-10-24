// Conversations as the game holds them (Creation Kit: "Dialogue", "Topic Info"): an actor
// greets the player with the first info of the Hello topics of the running quests whose
// conditions hold; the player picks from the topics of the top-level branches (a blocking
// branch's topic alone, when one is valid); a topic says its first info whose conditions hold
// (consecutive Random infos: one of them at random; Say Once infos once), its responses one by
// one with the info's fragments before and after; the info's choices are the topics offered
// next. Conditions run on the speaker with the player as their target. Quests are taken by
// their priority (higher first), then their topics by priority. Platform-independent.
// Notes: docs/ui.md ("Dialogue").

import {
  BranchFlag,
  InfoFlag,
  TopicCategory,
  TopicFlag,
  type BranchRecord,
  type InfoRecord,
  type TopicRecord,
} from '../../world/dialogue-records.ts';
import { DialogueIndex, voiceFileName } from '../../world/dialogue.ts';
import { ObjectHandle } from '../values.ts';
import { PLAYER_BASE, PLAYER_REF } from './forms.ts';
import { questText } from './quest-text.ts';
import type { ScriptRuntime } from './runtime.ts';
import { failsForSpeaker, type SpeakerFacts } from './speaker-filter.ts';

/** A topic the player may choose. */
export interface TopicChoice {
  readonly topic: TopicRecord;
  /** What the player says: the info's prompt, else the topic's text. */
  readonly text: string;
  /** Never chosen before (the menu marks it). */
  readonly isNew: boolean;
  readonly quest: number;
  /** A Rumors entry: the rumor topics it stands for (one of them is said, at random). */
  readonly rumors?: readonly TopicChoice[];
}

/** What an info says: its responses, from it or the info it shares them with. */
export interface SpokenInfo {
  readonly info: InfoRecord;
  readonly topic: TopicRecord;
  readonly quest: number;
  /** The info whose responses (and voice files) are said. */
  readonly source: {
    readonly info: InfoRecord;
    readonly topic: TopicRecord;
    readonly quest: number;
  };
}

/** DIAL subtype codes. */
const HELLO = 'HELO';
const GOODBYE = 'GBYE';
const RUMORS = 'RUMO';

export class DialogueEngine {
  readonly #runtime: ScriptRuntime;
  readonly index: DialogueIndex;
  /** Infos said with Say Once, topics the player has chosen (TODO(M12): in the save). */
  readonly #saidOnce = new Set<number>();
  readonly #chosen = new Set<number>();

  constructor(runtime: ScriptRuntime) {
    this.#runtime = runtime;
    this.index = new DialogueIndex(runtime.forms.db);
  }

  /**
   * Reads ahead what the first conversation would wait for: the game's dialogue, what its
   * conditions read of the whole load order (the actors' relationships), and, in parallel, the
   * starting topics and quests of the branches and the Hello and Goodbye topics (read one by one
   * as it starts, they keep it waiting for seconds).
   */
  async prepare(): Promise<void> {
    await Promise.all([this.index.build(), this.#runtime.actors.prepare()]);
    const quests = new Set<number>();
    const topics = new Set<number>();
    for (const branch of this.index.branches) {
      if (branch.quest !== undefined) quests.add(branch.quest);
      if (branch.startingTopic !== undefined) topics.add(branch.startingTopic);
    }
    await Promise.all([
      ...[...quests].map((quest) => this.#runtime.forms.quest(quest)),
      ...[...topics].map((topic) => this.index.topic(topic)),
    ]);
    await Promise.all([this.#topicsOfSubtype(HELLO), this.#topicsOfSubtype(GOODBYE)]);
  }

  /** The greeting an actor says as the conversation starts (its Hello topics' first valid info). */
  greeting(speaker: number): Promise<SpokenInfo | undefined> {
    return this.subtypeLine(speaker, HELLO);
  }

  /** What an actor says as the player ends the conversation (its Goodbye topics). */
  goodbye(speaker: number): Promise<SpokenInfo | undefined> {
    return this.subtypeLine(speaker, GOODBYE);
  }

  /**
   * The topics the player may choose: those given (an info's choices), else the starting
   * topics of the top-level branches of the running quests; a topic shows if it has an info
   * whose conditions hold. A blocking branch's valid topic is offered alone.
   */
  async topics(speaker: number, offered?: readonly number[]): Promise<TopicChoice[]> {
    const runtime = this.#runtime;
    await this.index.build();
    const candidates: { topic: TopicRecord; blocking: boolean }[] = [];
    if (offered && offered.length > 0) {
      for (const formId of offered) {
        const topic = await this.index.topic(formId);
        if (topic) candidates.push({ topic, blocking: false });
      }
    } else {
      for (const branch of await this.#topLevelBranches()) {
        if (branch.quest === undefined || !runtime.quests.isRunning(branch.quest)) continue;
        const topic =
          branch.startingTopic === undefined
            ? undefined
            : await this.index.topic(branch.startingTopic);
        if (topic?.category !== TopicCategory.topic) continue;
        candidates.push({ topic, blocking: (branch.flags & BranchFlag.blocking) !== 0 });
      }
    }
    const choices: (TopicChoice & { priority: number; blocking: boolean; rumor: boolean })[] = [];
    const speaks = new Map<number, boolean>();
    for (const { topic, blocking } of candidates) {
      const quest = topic.quest;
      if (quest === undefined) continue;
      let questSpeaks = speaks.get(quest);
      if (questSpeaks === undefined) {
        questSpeaks = await this.#questSpeaks(quest, speaker);
        speaks.set(quest, questSpeaks);
      }
      if (!questSpeaks) continue;
      const info = await this.#validInfo(topic, quest, speaker);
      if (!info) continue;
      const record = await runtime.forms.quest(quest);
      const text = info.prompt ?? topic.text;
      choices.push({
        topic,
        // Its tags filled in (<Global=RoomCost>: src/scripting/runtime/quest-text.ts).
        text: record && text !== '' ? await questText(runtime, record, text) : text,
        isNew: !this.#chosen.has(topic.formId),
        quest,
        priority: (record?.priority ?? 0) * 1000 + topic.priority,
        blocking,
        rumor: topic.subtypeName === RUMORS,
      });
    }
    const blocking = choices.filter((choice) => choice.blocking);
    let shown = blocking.length > 0 ? blocking.slice(0, 1) : choices;
    shown.sort((a, b) => b.priority - a.priority);
    // The valid rumors (subtype Rumors) are one entry, with the text of the first that has one
    // (most have none: "Give me the latest gossip." is an innkeeper's); chosen, one of them is
    // said at random. Inferred from the data, as the game asks for rumors once.
    // TODO(M13): check how the game picks among them.
    const rumors = shown.filter((choice) => choice.rumor);
    const named = rumors.find((choice) => choice.text !== '');
    if (rumors.length > 0) {
      shown = shown.filter((choice) => !choice.rumor || choice === named);
    }
    // An entry without text is never shown (the menu would list an empty line).
    return shown
      .filter((choice) => choice.text !== '')
      .map(({ topic, text, isNew, quest }) => ({
        topic,
        text,
        isNew,
        quest,
        ...(rumors.length > 1 &&
          topic === named?.topic && {
            rumors: rumors.map((rumor) => ({
              topic: rumor.topic,
              text: rumor.text,
              isNew: rumor.isNew,
              quest: rumor.quest,
            })),
          }),
      }));
  }

  /** The info a chosen topic says (its first whose conditions hold), marking it chosen. */
  async choose(choice: TopicChoice, speaker: number): Promise<SpokenInfo | undefined> {
    this.#chosen.add(choice.topic.formId);
    const rumors = choice.rumors;
    if (rumors && rumors.length > 0) {
      const rumor = rumors[Math.floor(Math.random() * rumors.length)] ?? choice;
      const info = await this.#validInfo(rumor.topic, rumor.quest, speaker);
      return info && (await this.#spoken(info, rumor.topic, rumor.quest));
    }
    const info = await this.#validInfo(choice.topic, choice.quest, speaker);
    return info && (await this.#spoken(info, choice.topic, choice.quest));
  }

  /**
   * What an actor says of a topic (ObjectReference.Say): its first valid info. `target`: whom
   * it is said to (a scene line's look target; the player by default).
   */
  async topicLine(
    topic: number,
    speaker: number,
    target: number = PLAYER_REF,
  ): Promise<SpokenInfo | undefined> {
    const record = await this.index.topic(topic);
    if (record?.quest === undefined) return undefined;
    const info = await this.#validInfo(record, record.quest, speaker, target);
    return info && (await this.#spoken(info, record, record.quest));
  }

  /** The info is said: Say Once infos are not said again. */
  said(info: InfoRecord): void {
    if ((info.flags & InfoFlag.sayOnce) !== 0) this.#saidOnce.add(info.formId);
  }

  /**
   * The voice file of a response for a voice type (by its editor id):
   * SoundVoice<plugin><voice type><file>.fuz, under the plugin that defines the info (its form
   * id's master: a mod's override of a vanilla line keeps Skyrim.esm's file).
   */
  async voiceFile(
    spoken: SpokenInfo,
    response: number,
    voiceType: string,
  ): Promise<string | undefined> {
    const db = this.#runtime.forms.db;
    const quest = await db.get(spoken.source.quest);
    const plugin = db.origin(spoken.source.info.formId)?.plugin.entry.name;
    if (!quest?.editorId || !plugin) return undefined;
    const name = voiceFileName(
      quest.editorId,
      spoken.source.topic,
      spoken.source.info.formId,
      response,
    );
    return ['sound', 'voice', plugin, voiceType, `${name}.fuz`].join('\\').toLowerCase();
  }

  /**
   * Whether the info is the game's own: the plugin that defines it is one the game loads by
   * itself (its masters, Skyrim.ccc's Creations), not a mod of plugins.txt. A voice file such
   * a line lacks is the game's own silent line (creature barks, the bards' instrumental
   * songs: vanilla ships no file for them), not a missing file.
   */
  isGameContent(spoken: SpokenInfo): boolean {
    const plugin = this.#runtime.forms.db.origin(spoken.source.info.formId)?.plugin;
    return plugin !== undefined && plugin.entry.source !== 'plugins.txt';
  }

  /** Runs an info's fragment ("begin" as its first response starts, "end" after its last). */
  async runFragment(info: InfoRecord, when: 'begin' | 'end', speaker: number): Promise<void> {
    const runtime = this.#runtime;
    const attachments = await runtime.forms.attachments(info.formId);
    for (const fragment of attachments?.fragments ?? []) {
      if (fragment.stage !== when) continue;
      await runtime.vm.call(new ObjectHandle(info.formId, fragment.script), fragment.function, [
        runtime.referenceHandle(speaker),
      ]);
    }
  }

  /** A quest's dialogue conditions (those before its stages) hold for the speaker. */
  async #questSpeaks(quest: number, speaker: number): Promise<boolean> {
    const runtime = this.#runtime;
    const record = await runtime.forms.quest(quest);
    if (!record) return false;
    return runtime.conditionsHold(
      record.dialogueConditions,
      runtime.referenceHandle(speaker),
      undefined,
      {
        target: runtime.referenceHandle(PLAYER_REF),
        quest,
      },
    );
  }

  /**
   * A topic's first info whose conditions hold (not one said once already); where it starts a
   * run of Random infos, one of the valid ones of that run at random.
   */
  async #validInfo(
    topic: TopicRecord,
    quest: number,
    speaker: number,
    target: number = PLAYER_REF,
  ): Promise<InfoRecord | undefined> {
    const runtime = this.#runtime;
    const infos = await this.index.infos(topic.formId);
    const holds = async (info: InfoRecord): Promise<boolean> =>
      !this.#saidOnce.has(info.formId) &&
      (await runtime.conditionsHold(info.conditions, runtime.referenceHandle(speaker), undefined, {
        target: runtime.referenceHandle(target),
        quest,
      }));
    for (let i = 0; i < infos.length; i++) {
      const info = infos[i];
      if (!info || !(await holds(info))) continue;
      if ((info.flags & InfoFlag.random) === 0) return info;
      const run: InfoRecord[] = [info];
      for (let j = i + 1; j < infos.length; j++) {
        const next = infos[j];
        if (!next || (next.flags & InfoFlag.random) === 0) break;
        if (await holds(next)) run.push(next);
        if ((next.flags & InfoFlag.randomEnd) !== 0) break;
      }
      return run[Math.floor(Math.random() * run.length)];
    }
    return undefined;
  }

  /** An info with the info whose responses it says (a shared info's, through DNAM). */
  async #spoken(info: InfoRecord, topic: TopicRecord, quest: number): Promise<SpokenInfo> {
    if (info.sharedInfo === undefined || info.sharedInfo === 0) {
      return { info, topic, quest, source: { info, topic, quest } };
    }
    const db = this.#runtime.forms.db;
    const location = db.locate(info.sharedInfo);
    const group = location && db.parentGroup(location);
    const sharedTopic = group ? await this.index.topic(group.label) : undefined;
    const shared = sharedTopic
      ? (await this.index.infos(sharedTopic.formId)).find(
          (entry) => entry.formId === info.sharedInfo,
        )
      : undefined;
    if (!shared || sharedTopic?.quest === undefined) {
      return { info, topic, quest, source: { info, topic, quest } };
    }
    return {
      info,
      topic,
      quest,
      source: { info: shared, topic: sharedTopic, quest: sharedTopic.quest },
    };
  }

  async #topLevelBranches(): Promise<readonly BranchRecord[]> {
    await this.index.build();
    return this.index.branches.filter((branch) => (branch.flags & BranchFlag.topLevel) !== 0);
  }

  // --- Lines outside the dialogue menu (docs/ai.md, "Talking") ------------------------------

  /** The topics of a subtype with their quests, higher quest priority first, then topic priority. */
  readonly #bySubtype = new Map<
    string,
    Promise<readonly { topic: TopicRecord; quest: number }[]>
  >();
  /** A topic that says all its infos before repeating: those said since it last started over. */
  readonly #saidInTopic = new Map<number, Set<number>>();
  /** Form lists of voice types (GetIsVoiceType of a list), read once. */
  readonly #voiceLists = new Map<number, readonly number[] | null>();

  /**
   * What an actor says of a topic subtype (a greeting "HELO", idle chatter "IDLE", a bark:
   * "ACAC", "TITG", "OBCO", ...; src/world/dialogue-subtypes.ts) to a target (the player,
   * another actor): the first valid info of the subtype's topics of the running quests, by
   * quest priority, then topic priority. Its conditions (and its quest's dialogue conditions)
   * run on the speaker with the target as their target. An info another actor says (ANAM), or
   * whose conditions name another actor, voice type or alias's reference, is passed over
   * without valuing the rest (speaker-filter.ts).
   */
  async subtypeLine(
    speaker: number,
    subtype: string,
    target: number = PLAYER_REF,
  ): Promise<SpokenInfo | undefined> {
    const runtime = this.#runtime;
    const facts = await this.#speakerFacts(speaker);
    const speaks = new Map<number, boolean>();
    for (const { topic, quest } of await this.#topicsOfSubtype(subtype)) {
      if (!runtime.quests.isRunning(quest)) continue;
      let questSpeaks = speaks.get(quest);
      if (questSpeaks === undefined) {
        questSpeaks = await this.#questSpeaksTo(quest, speaker, target);
        speaks.set(quest, questSpeaks);
      }
      if (!questSpeaks) continue;
      const info = await this.#infoFor(topic, quest, speaker, target, facts);
      if (info) return this.#spoken(info, topic, quest);
    }
    return undefined;
  }

  /**
   * What an actor says of a topic to a target (a package's Say at its target, a scene's line,
   * ObjectReference.Say): its first valid info, its conditions run with the target as theirs.
   */
  async topicLineTo(
    topic: number,
    speaker: number,
    target: number = PLAYER_REF,
  ): Promise<SpokenInfo | undefined> {
    const record = await this.index.topic(topic);
    if (record?.quest === undefined) return undefined;
    const facts = await this.#speakerFacts(speaker);
    const info = await this.#infoFor(record, record.quest, speaker, target, facts);
    return info && (await this.#spoken(info, record, record.quest));
  }

  #topicsOfSubtype(subtype: string): Promise<readonly { topic: TopicRecord; quest: number }[]> {
    let pending = this.#bySubtype.get(subtype);
    if (!pending) {
      pending = (async () => {
        await this.index.build();
        // In parallel: one record read after another takes seconds for the Hello topics.
        const read = await Promise.all(
          this.index.topicsOfSubtype(subtype).map(async (formId) => {
            const topic = await this.index.topic(formId);
            const quest = topic?.quest;
            if (!topic || quest === undefined) return undefined;
            const priority = (await this.#runtime.forms.quest(quest))?.priority ?? 0;
            return { topic, quest, priority };
          }),
        );
        const topics = read.filter((entry) => entry !== undefined);
        topics.sort((x, y) => y.priority - x.priority || y.topic.priority - x.topic.priority);
        return topics.map(({ topic, quest }) => ({ topic, quest }));
      })();
      this.#bySubtype.set(subtype, pending);
    }
    return pending;
  }

  /** What tells a speaker's infos apart before their conditions run. */
  async #speakerFacts(speaker: number): Promise<SpeakerFacts & { readonly voice?: number }> {
    const runtime = this.#runtime;
    const [base, voice] = await Promise.all([
      speaker === PLAYER_REF ? Promise.resolve(PLAYER_BASE) : runtime.baseOf(speaker),
      runtime.voiceType(speaker),
    ]);
    // The form lists of voice types the infos name, read as they come up.
    const lists = this.#voiceLists;
    return {
      reference: speaker,
      base,
      ...(voice !== undefined && { voice }),
      voiceIs: (form) => {
        if (voice === undefined) return false;
        if (form === voice) return true;
        const list = lists.get(form);
        if (list === undefined) return undefined;
        return list === null ? false : list.includes(voice);
      },
    };
  }

  /** Reads the voice type form lists conditions name (once each). */
  async #readVoiceLists(conditions: readonly InfoRecord['conditions'][number][]): Promise<void> {
    const runtime = this.#runtime;
    for (const condition of conditions) {
      if (condition.function !== GET_IS_VOICE_TYPE || this.#voiceLists.has(condition.form)) {
        continue;
      }
      const record = await runtime.forms.record(condition.form);
      this.#voiceLists.set(
        condition.form,
        record?.type === 'FLST' ? await runtime.formList(condition.form) : null,
      );
    }
  }

  /** A quest's dialogue conditions hold for the speaker and its target. */
  #questSpeaksTo(quest: number, speaker: number, target: number): Promise<boolean> {
    const runtime = this.#runtime;
    return runtime.forms
      .quest(quest)
      .then(
        (record) =>
          record !== undefined &&
          runtime.conditionsHold(
            record.dialogueConditions,
            runtime.referenceHandle(speaker),
            undefined,
            { target: runtime.referenceHandle(target), quest },
          ),
      );
  }

  /**
   * A topic's first info the speaker says to the target (its conditions hold; not said once
   * already; ANAM, if any, names it); where it starts a run of Random infos, one of the valid
   * ones of the run at random, one not said since the topic started over if the topic says all
   * before repeating (DIAL DATA flag 0x1).
   */
  async #infoFor(
    topic: TopicRecord,
    quest: number,
    speaker: number,
    target: number,
    facts: SpeakerFacts,
  ): Promise<InfoRecord | undefined> {
    const runtime = this.#runtime;
    const infos = await this.index.infos(topic.formId);
    const aliases = runtime.state.quests.get(quest)?.aliases;
    const questFacts: SpeakerFacts = {
      ...facts,
      aliasIs: (alias) => aliases?.get(alias) === speaker,
    };
    const holds = async (info: InfoRecord): Promise<boolean> => {
      if (this.#saidOnce.has(info.formId)) return false;
      if (info.speaker !== undefined && info.speaker !== 0) {
        if (info.speaker !== speaker && info.speaker !== facts.base) return false;
      }
      await this.#readVoiceLists(info.conditions);
      if (failsForSpeaker(info.conditions, questFacts)) return false;
      return runtime.conditionsHold(info.conditions, runtime.referenceHandle(speaker), undefined, {
        target: runtime.referenceHandle(target),
        quest,
      });
    };
    for (let i = 0; i < infos.length; i++) {
      const info = infos[i];
      if (!info || !(await holds(info))) continue;
      if ((info.flags & InfoFlag.random) === 0) return info;
      const run: InfoRecord[] = [info];
      for (let j = i + 1; j < infos.length; j++) {
        const next = infos[j];
        if (!next || (next.flags & InfoFlag.random) === 0) break;
        if (await holds(next)) run.push(next);
        if ((next.flags & InfoFlag.randomEnd) !== 0) break;
      }
      return this.#pick(topic, run);
    }
    return undefined;
  }

  /** One of a run of Random infos; a topic that says all before repeating one not said since. */
  #pick(topic: TopicRecord, run: readonly InfoRecord[]): InfoRecord | undefined {
    if ((topic.flags & TopicFlag.doAllBeforeRepeating) === 0) {
      return run[Math.floor(Math.random() * run.length)];
    }
    let said = this.#saidInTopic.get(topic.formId);
    if (!said) this.#saidInTopic.set(topic.formId, (said = new Set()));
    let fresh = run.filter((info) => !said.has(info.formId));
    if (fresh.length === 0) {
      said.clear();
      fresh = [...run];
    }
    const info = fresh[Math.floor(Math.random() * fresh.length)];
    if (info) said.add(info.formId);
    return info;
  }
}

/** GetIsVoiceType (UESP "Skyrim Mod:Function Indices"). */
const GET_IS_VOICE_TYPE = 426;
