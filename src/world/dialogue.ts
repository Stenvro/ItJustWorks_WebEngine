// The game's dialogue as the engine looks it up: every topic's infos in their order (an info
// follows the one its PNAM names; the first has none), the topics by quest, and the voice file
// of a response. Platform-independent: Node tools use it too. Notes: docs/formats/esm.md
// ("Dialogue").

import { GroupType } from '../formats/esm/record.ts';
import { parseInfo, parseTopic, type InfoRecord, type TopicRecord } from './dialogue-records.ts';
import type { RecordDatabase } from './record-db.ts';

export class DialogueIndex {
  readonly #db: RecordDatabase;
  /** Topic → its infos' form ids (unordered until asked for). */
  readonly #infos = new Map<number, number[]>();
  readonly #ordered = new Map<number, Promise<InfoRecord[]>>();
  readonly #topics = new Map<number, Promise<TopicRecord | undefined>>();
  /** Quest → its topics. */
  readonly #byQuest = new Map<number, number[]>();
  #built: Promise<void> | undefined;

  constructor(db: RecordDatabase) {
    this.#db = db;
  }

  /** Reads which infos each topic has and which topics each quest has (once). */
  build(): Promise<void> {
    this.#built ??= (async () => {
      const db = this.#db;
      for (const formId of db.formIdsOfType('INFO')) {
        const location = db.locate(formId);
        const group = location && db.parentGroup(location);
        if (group?.type !== GroupType.topicChildren) continue;
        const list = this.#infos.get(group.label) ?? [];
        list.push(formId);
        this.#infos.set(group.label, list);
      }
      for (const formId of db.formIdsOfType('DIAL')) {
        const topic = await this.topic(formId);
        if (topic?.quest === undefined) continue;
        const list = this.#byQuest.get(topic.quest) ?? [];
        list.push(formId);
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

  /** Every quest with topics (after build). */
  questsWithTopics(): Iterable<number> {
    return this.#byQuest.keys();
  }

  /** A topic's infos in their order: from the one without a previous info along PNAM. */
  infos(topic: number): Promise<InfoRecord[]> {
    let pending = this.#ordered.get(topic);
    if (!pending) {
      pending = (async () => {
        await this.build();
        const infos: InfoRecord[] = [];
        for (const formId of this.#infos.get(topic) ?? []) {
          const record = await this.#db.get(formId);
          if (record && !record.deleted) infos.push(parseInfo(record));
        }
        return orderInfos(infos);
      })();
      this.#ordered.set(topic, pending);
    }
    return pending;
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
 * A response's voice file (SoundVoice<plugin><voice type><file>.fuz):
 * <quest>_<topic>_<info>_<n>, of the topic's quest's and the topic's editor ids, the info's form
 * id as 8 hex digits without the load order index, and the response's number. Editor ids longer
 * than 25 characters together are cut, the quest's to 10 and the topic's to 15 (a topic
 * without one leaves its part empty: "DialogueGe__00023C13_1"). Checked against every voiced
 * line of the vanilla data (tools/dialogue-info.ts; 35,580 of 35,580).
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
    topicPart = topicPart.slice(0, 15);
  }
  return `${quest}_${topicPart}_${hex8(infoFormId & 0xffffff)}_${String(response)}`;
}
