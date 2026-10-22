// Quest items: the references in a running quest's aliases flagged Quest Object (ALFA FNAM 0x4)
// while they are in a container (the Golden Claw in the player's pack). They cannot be dropped,
// stored, sold, given or eaten (sDropQuestItemWarning, sNoEatQuestItem), and RemoveAllItems leaves
// them unless asked (abRemoveQuestItems). Platform-independent. Notes: docs/gameplay.md
// ("Quest items").

import { AliasFlag } from '../../world/quest-records.ts';
import type { ScriptRuntime } from './runtime.ts';

/** Whether a reference fills a Quest Object alias of a quest that runs. */
export async function isQuestObject(runtime: ScriptRuntime, reference: number): Promise<boolean> {
  for (const { quest, alias } of runtime.aliasesHolding(reference)) {
    if (runtime.state.quests.get(quest)?.running !== true) continue;
    const record = await runtime.forms.quest(quest);
    const entry = record?.aliases.find((candidate) => candidate.id === alias);
    if (entry && !entry.location && (entry.flags & AliasFlag.questObject) !== 0) return true;
  }
  return false;
}

/**
 * The quest items a container holds, by base: how many of each base's items are quest items
 * (each reference counts as its count, XCNT).
 */
export async function questItems(
  runtime: ScriptRuntime,
  container: number,
): Promise<Map<number, number>> {
  const found = new Map<number, number>();
  for (const [reference, state] of runtime.state.references) {
    const held = state.container;
    if (held?.holder !== container || state.deleted === true) continue;
    if (!(await isQuestObject(runtime, reference))) continue;
    found.set(held.base, (found.get(held.base) ?? 0) + held.count);
  }
  return found;
}

/** How many of a base's items in a container are quest items. */
export async function questItemCount(
  runtime: ScriptRuntime,
  container: number,
  base: number,
): Promise<number> {
  return (await questItems(runtime, container)).get(base) ?? 0;
}
