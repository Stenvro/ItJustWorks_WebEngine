// The game's dialogue as the engine looks it up: every topic's infos in their order (an info
// follows the one its PNAM names; the first has none), the topics by quest, and the voice file
// of a response. Platform-independent: Node tools use it too. Notes: docs/formats/esm.md
// ("Dialogue").

import { GroupType } from '../formats/esm/record.ts';
import {
  parseBranch,
  parseInfo,
  parseTopic,
  type BranchRecord,
  type InfoRecord,
  type TopicRecord,
} from './dialogue-records.ts';
import { DIALOGUE_SUBTYPES } from './dialogue-subtypes.ts';
import type { RecordDatabase } from './record-db.ts';

export class DialogueIndex {
  readonly #db: RecordDatabase;
  /** Topic → its infos (unordered until asked for). */
  readonly #infos = new Map<number, InfoRecord[]>();
  readonly #ordered = new Map<number, InfoRecord[]>();
  readonly #topics = new Map<number, Promise<TopicRecord | undefined>>();
  /** Quest → its topics. */
  readonly #byQuest = new Map<number, number[]>();
  /** Every dialogue branch. */
  readonly #branches: BranchRecord[] = [];
  /** Subtype code ("HELO", "GBYE", ...) → the topics of that subtype. */
  readonly #bySubtype = new Map<string, number[]>();
  #built: Promise<void> | undefined;

  constructor(db: RecordDatabase) {
    this.#db = db;
  }

  /**
   * Reads the dialogue (once): every topic, branch and info, in bulk (one by one would take
   * long in the browser; the infos take some 40 MB), each info under its topic.
   */
  build(): Promise<void> {
    this.#built ??= (async () => {
      const db = this.#db;
      const topics: TopicRecord[] = [];
      await db.scan(
        ['DIAL', 'DLBR', 'INFO'],
        () => true,
        (record) => {
          if (record.deleted) return;
          if (record.type === 'DIAL') topics.push(parseTopic(record));
          else if (record.type === 'DLBR') this.#branches.push(parseBranch(record));
          else {
            const location = db.locate(record.formId);
            const group = location && db.parentGroup(location);
            if (group?.type !== GroupType.topicChildren) return;
            const list = this.#infos.get(group.label) ?? [];
            list.push(parseInfo(record));
            this.#infos.set(group.label, list);
          }
        },
      );
      for (const topic of topics) {
        this.#topics.set(topic.formId, Promise.resolve(topic));
        const ofSubtype = this.#bySubtype.get(topic.subtypeName) ?? [];
        ofSubtype.push(topic.formId);
        this.#bySubtype.set(topic.subtypeName, ofSubtype);
        if (topic.quest === undefined) continue;
        const list = this.#byQuest.get(topic.quest) ?? [];
        list.push(topic.formId);
        this.#byQuest.set(topic.quest, list);
      }
    })();
    return this.#built;
  }

  topic(formId: number): Promise<TopicRecord | undefined> {
    let pending = this.#topics.get(formId);
    if (!pending) {
      pending = this.#db
        .get(formId)
        .then((record) =>
          record?.type === 'DIAL' && !record.deleted ? parseTopic(record) : undefined,
        );
      this.#topics.set(formId, pending);
    }
    return pending;
  }

  /** A quest's topics (after build). */
  topicsOfQuest(quest: number): readonly number[] {
    return this.#byQuest.get(quest) ?? [];
  }

  /** Every dialogue branch (after build). */
  get branches(): readonly BranchRecord[] {
    return this.#branches;
  }

  /**
   * The topics of a subtype ("HELO", "IDLE", "ATCK", ...; src/world/dialogue-subtypes.ts) of
   * every quest (after build).
   */
  topicsOfSubtype(subtype: string): readonly number[] {
    return this.#bySubtype.get(subtype) ?? [];
  }

  /**
   * The topics of a category's subtypes (TopicCategory: combat barks, detection lines,
   * services, ...; by the subtype table, not each topic's own DATA category) (after build).
   */
  topicsOfCategory(category: number): number[] {
    return DIALOGUE_SUBTYPES.filter((subtype) => subtype.category === category).flatMap((subtype) =>
      this.topicsOfSubtype(subtype.code),
    );
  }

  /** Every quest with topics (after build). */
  questsWithTopics(): Iterable<number> {
    return this.#byQuest.keys();
  }

  /** A topic's infos in their order: from the one without a previous info along PNAM. */
  async infos(topic: number): Promise<InfoRecord[]> {
    await this.build();
    let ordered = this.#ordered.get(topic);
    if (!ordered) {
      ordered = orderInfos(this.#infos.get(topic) ?? []);
      this.#ordered.set(topic, ordered);
    }
    return ordered;
  }
}

/**
 * Infos in their order: each after the one its PNAM names (the first names none, or one not in
 * the topic); infos the chain does not reach follow in the order they came.
 */
export function orderInfos(infos: readonly InfoRecord[]): InfoRecord[] {
  const ids = new Set(infos.map((info) => info.formId));
  const after = new Map<number, InfoRecord[]>();
  const heads: InfoRecord[] = [];
  for (const info of infos) {
    if (info.previous === undefined || info.previous === 0 || !ids.has(info.previous)) {
      heads.push(info);
      continue;
    }
    const list = after.get(info.previous) ?? [];
    list.push(info);
    after.set(info.previous, list);
  }
  const ordered: InfoRecord[] = [];
  const seen = new Set<number>();
  const visit = (info: InfoRecord): void => {
    if (seen.has(info.formId)) return;
    seen.add(info.formId);
    ordered.push(info);
    for (const next of after.get(info.formId) ?? []) visit(next);
  };
  for (const head of heads) visit(head);
  for (const info of infos) visit(info);
  return ordered;
}

/**
 * How long a response without a voice file is said (observed in the original: as an
 * actor starts a response it finds no sound for, the line lasts its text's length in
 * characters times fAIDefaultSpeechMult, with no least time; with a file, the file's length
 * and then fGameplayVoiceFilePadding). An empty response is over at once.
 */
export function silentLineSeconds(text: string, perCharacter: number): number {
  return text.length * perCharacter;
}

/**
 * A response's voice file (SoundVoice<plugin><voice type><file>.fuz):
 * <quest>_<topic>_<info>_<n>, of the topic's quest's and the topic's editor ids, the info's form
 * id as 8 hex digits without the load order index, and the response's number. Editor ids longer
 * than 25 characters together are cut: the quest's to 10, the topic's to what is left of the 25
 * ("MS13_MS13LucanQuestGiveBra_...", "DialogueGe_OfferServicesTo_..."; a topic without one
 * leaves its part empty: "DialogueGe__00023C13_1"). Checked against the voice files of the
 * load order: 43,326 of its 44,040 responses have one.
 */
export function voiceFileName(
  questEditorId: string,
  topic: { readonly editorId: string },
  infoFormId: number,
  response: number,
): string {
  const hex8 = (value: number): string => (value >>> 0).toString(16).toUpperCase().padStart(8, '0');
  let quest = questEditorId;
  let topicPart = topic.editorId;
  if (quest.length + topicPart.length > 25) {
    quest = quest.slice(0, 10);
    topicPart = topicPart.slice(0, 25 - quest.length);
  }
  return `${quest}_${topicPart}_${hex8(infoFormId & 0xffffff)}_${String(response)}`;
}
