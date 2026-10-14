import { describe, expect, it } from 'vitest';
import type { QuestRecord } from '../../world/quest-records.ts';
import { GameState } from './game-state.ts';
import { journalQuests } from './journal.ts';
import type { ScriptRuntime } from './runtime.ts';

const MAIN = 0x100;
const MISC = 0x200;
const UNSEEN = 0x300;

const quest = (formId: number, name: string, type: number): QuestRecord =>
  ({
    formId,
    name,
    type,
    textGlobals: [],
    aliases: [],
    objectives: [
      { index: 10, flags: 0, text: `${name}: first`, targets: [] },
      { index: 20, flags: 0, text: `${name}: second`, targets: [] },
    ],
    stages: [
      {
        index: 5,
        flags: 0,
        logEntries: [
          { flags: 0, conditions: [], text: 'Not this one', nextQuest: undefined },
          { flags: 0, conditions: [], text: 'I must escape.', nextQuest: undefined },
        ],
      },
    ],
  }) as unknown as QuestRecord;

const records = new Map([
  [MAIN, quest(MAIN, 'Unbound', 1)],
  [MISC, quest(MISC, 'Favors', 6)],
  [UNSEEN, quest(UNSEEN, 'Hidden', 8)],
]);

describe('journalQuests', () => {
  it('lists the quests given to the player, newer first, with their latest journal text', async () => {
    const state = new GameState();
    const main = state.quest(MAIN);
    main.objectives.set(10, { displayed: true, completed: true, failed: false, shown: 1 });
    main.objectives.set(20, { displayed: true, completed: false, failed: false, shown: 3 });
    main.log.push({ stage: 5, entry: 1 });
    main.updated = 3;
    main.active = true;
    const misc = state.quest(MISC);
    misc.objectives.set(10, { displayed: true, completed: false, failed: false, shown: 4 });
    misc.updated = 4;
    state.quest(UNSEEN).running = true;
    const runtime = {
      state,
      forms: { quest: (formId: number) => Promise.resolve(records.get(formId)) },
    } as unknown as ScriptRuntime;

    const quests = await journalQuests(runtime);
    expect(quests.map((entry) => entry.name)).toEqual(['Favors', 'Unbound']);
    const unbound = quests[1];
    expect(unbound?.description).toBe('I must escape.');
    expect(unbound?.active).toBe(true);
    expect(unbound?.objectives.map((objective) => [objective.text, objective.completed])).toEqual([
      ['Unbound: second', false],
      ['Unbound: first', true],
    ]);
  });
});
