import { describe, expect, it } from 'vitest';
import type { InfoRecord } from './dialogue-records.ts';
import { orderInfos, voiceFileName } from './dialogue.ts';

const info = (formId: number, previous?: number): InfoRecord => ({
  formId,
  flags: 0,
  resetHours: 0,
  previous,
  choices: [],
  sharedInfo: undefined,
  prompt: undefined,
  speaker: undefined,
  responses: [],
  conditions: [],
});

describe('dialogue', () => {
  it("orders a topic's infos along their previous info", () => {
    const ordered = orderInfos([info(3, 2), info(1), info(2, 1), info(9, 0x999)]);
    expect(ordered.map((entry) => entry.formId)).toEqual([1, 2, 3, 9]);
  });

  it('names voice files after the quest, the topic, the info and the response', () => {
    expect(voiceFileName('DialogueGenericFriendlyFire', { editorId: '' }, 0x23c13, 1)).toBe(
      'DialogueGe__00023C13_1',
    );
    expect(
      voiceFileName('MQ101', { editorId: 'MQ101FriendPickpocketSayTopic' }, 0x0110e2d0, 2),
    ).toBe('MQ101_MQ101FriendPick_0010E2D0_2');
    expect(voiceFileName('MQ101', { editorId: 'MQ101SoldierBlocking' }, 0x648f4, 1)).toBe(
      'MQ101_MQ101SoldierBlocking_000648F4_1',
    );
  });
});
