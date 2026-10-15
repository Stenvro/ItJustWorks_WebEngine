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
  type BranchRecord,
  type InfoRecord,
  type TopicRecord,
} from '../../world/dialogue-records.ts';
import { DialogueIndex, voiceFileName } from '../../world/dialogue.ts';
import { ObjectHandle } from '../values.ts';
import { PLAYER_REF } from './forms.ts';
import type { ScriptRuntime } from './runtime.ts';

/** A topic the player may choose. */
export interface TopicChoice {
  readonly topic: TopicRecord;
  /** What the player says: the info's prompt, else the topic's text. */
  readonly text: string;
  /** Never chosen before (the menu marks it). */
  readonly isNew: boolean;
  readonly quest: number;
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

  /** The greeting an actor says as the conversation starts (its Hello topics' first valid info). */
  greeting(speaker: number): Promise<SpokenInfo | undefined> {
    return this.#firstOfSubtype(speaker, HELLO);
  }

  /** What an actor says as the player ends the conversation (its Goodbye topics). */
  goodbye(speaker: number): Promise<SpokenInfo | undefined> {
    return this.#firstOfSubtype(speaker, GOODBYE);
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
    const choices: (TopicChoice & { priority: number; blocking: boolean })[] = [];
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
      choices.push({
        topic,
        text: info.prompt ?? topic.text,
        isNew: !this.#chosen.has(topic.formId),
        quest,
        priority: (record?.priority ?? 0) * 1000 + topic.priority,
        blocking,
      });
    }
    const blocking = choices.filter((choice) => choice.blocking);
    const shown = blocking.length > 0 ? blocking.slice(0, 1) : choices;
    return shown
      .sort((a, b) => b.priority - a.priority)
      .map(({ topic, text, isNew, quest }) => ({ topic, text, isNew, quest }));
  }

  /** The info a chosen topic says (its first whose conditions hold), marking it chosen. */
  async choose(choice: TopicChoice, speaker: number): Promise<SpokenInfo | undefined> {
    this.#chosen.add(choice.topic.formId);
    const info = await this.#validInfo(choice.topic, choice.quest, speaker);
    return info && (await this.#spoken(info, choice.topic, choice.quest));
  }

  /** What an actor says of a topic (ObjectReference.Say): its first valid info. */
  async topicLine(topic: number, speaker: number): Promise<SpokenInfo | undefined> {
    const record = await this.index.topic(topic);
    if (record?.quest === undefined) return undefined;
    const info = await this.#validInfo(record, record.quest, speaker);
    return info && (await this.#spoken(info, record, record.quest));
  }

  /** The info is said: Say Once infos are not said again. */
  said(info: InfoRecord): void {
    if ((info.flags & InfoFlag.sayOnce) !== 0) this.#saidOnce.add(info.formId);
  }

  /**
   * The voice file of a response for a voice type (by its editor id):
   * SoundVoice<plugin><voice type><file>.fuz.
   */
  async voiceFile(
    spoken: SpokenInfo,
    response: number,
    voiceType: string,
  ): Promise<string | undefined> {
    const db = this.#runtime.forms.db;
    const quest = await db.get(spoken.source.quest);
    const plugin = db.locate(spoken.source.info.formId)?.plugin.entry.name;
    if (!quest?.editorId || !plugin) return undefined;
    const name = voiceFileName(
      quest.editorId,
      spoken.source.topic,
      spoken.source.info.formId,
      response,
    );
    return ['sound', 'voice', plugin, voiceType, `${name}.fuz`].join('\\').toLowerCase();
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

  async #firstOfSubtype(speaker: number, subtype: string): Promise<SpokenInfo | undefined> {
    const runtime = this.#runtime;
    await this.index.build();
    // The topics of the subtype of running quests, higher quest priority first.
    const topics: { topic: TopicRecord; quest: number; priority: number }[] = [];
    for (const formId of this.index.topicsOfSubtype(subtype)) {
      const topic = await this.index.topic(formId);
      const quest = topic?.quest;
      if (!topic || quest === undefined || !runtime.quests.isRunning(quest)) continue;
      topics.push({ topic, quest, priority: (await runtime.forms.quest(quest))?.priority ?? 0 });
    }
    topics.sort((x, y) => y.priority - x.priority || y.topic.priority - x.topic.priority);
    const speaks = new Map<number, boolean>();
    for (const { topic, quest } of topics) {
      let questSpeaks = speaks.get(quest);
      if (questSpeaks === undefined) {
        questSpeaks = await this.#questSpeaks(quest, speaker);
        speaks.set(quest, questSpeaks);
      }
      if (!questSpeaks) continue;
      const info = await this.#validInfo(topic, quest, speaker);
      if (info) return this.#spoken(info, topic, quest);
    }
    return undefined;
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
  ): Promise<InfoRecord | undefined> {
    const runtime = this.#runtime;
    const infos = await this.index.infos(topic.formId);
    const holds = async (info: InfoRecord): Promise<boolean> =>
      !this.#saidOnce.has(info.formId) &&
      (await runtime.conditionsHold(info.conditions, runtime.referenceHandle(speaker), undefined, {
        target: runtime.referenceHandle(PLAYER_REF),
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
}
