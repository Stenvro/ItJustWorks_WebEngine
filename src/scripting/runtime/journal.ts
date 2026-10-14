// The quests as the journal shows them: those the player has been given (an objective shown, or
// a journal text from a stage), each with its name, type, whether it is the active one (shown
// on the compass and map), done or failed, its description (the latest journal text its stages
// chose: QUST log entries' CNAM) and its objectives shown, newer first. Miscellaneous quests
// (type 6) have no entry of their own: their objectives are the journal's MISCELLANEOUS list.
// Texts have their tags filled in (quest-text.ts). Platform-independent.
// Notes: docs/ui.md ("The journal").

import { questText } from './quest-text.ts';
import type { ScriptRuntime } from './runtime.ts';

/** Quest type: miscellaneous objectives. */
export const MISC_QUEST_TYPE = 6;

export interface JournalObjective {
  readonly quest: number;
  readonly index: number;
  readonly text: string;
  readonly completed: boolean;
  readonly failed: boolean;
  /** When it was shown (newer first). */
  readonly shown: number;
}

export interface JournalQuest {
  readonly formId: number;
  readonly name: string;
  /** QuestRecord.type (0 none, 1 main, ... 6 miscellaneous, ...). */
  readonly type: number;
  /** The active quest (Quest.SetActive): its targets show on the compass and map. */
  readonly active: boolean;
  /** Done: completed or failed (the journal's completed list). */
  readonly completed: boolean;
  readonly failed: boolean;
  /** When it was last updated for the player (newer first). */
  readonly updated: number;
  readonly description: string;
  readonly objectives: readonly JournalObjective[];
}

/** Every quest the journal shows, newer updates first (miscellaneous ones included). */
export async function journalQuests(runtime: ScriptRuntime): Promise<JournalQuest[]> {
  const quests: JournalQuest[] = [];
  for (const [formId, state] of runtime.state.quests) {
    const shown = [...state.objectives].filter(([, objective]) => objective.displayed);
    if (shown.length === 0 && state.log.length === 0) continue;
    const record = await runtime.forms.quest(formId);
    if (!record) continue;
    const last = state.log[state.log.length - 1];
    const logText =
      last &&
      record.stages.find((stage) => stage.index === last.stage)?.logEntries[last.entry]?.text;
    const objectives: JournalObjective[] = [];
    for (const [index, objective] of shown) {
      const text = record.objectives.find((entry) => entry.index === index)?.text ?? '';
      objectives.push({
        quest: formId,
        index,
        text: await questText(runtime, record, text),
        completed: objective.completed,
        failed: objective.failed,
        shown: objective.shown ?? 0,
      });
    }
    objectives.sort((a, b) => b.shown - a.shown || b.index - a.index);
    quests.push({
      formId,
      name: await questText(runtime, record, record.name ?? ''),
      type: record.type,
      active: state.active,
      completed: state.completed || state.failed,
      failed: state.failed,
      updated: state.updated,
      description: logText ? await questText(runtime, record, logText) : '',
      objectives,
    });
  }
  return quests.sort((a, b) => b.updated - a.updated);
}
