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
  favorLevel: 0,
  walkAwayTopic: undefined,
  audioOutputOverride: undefined,
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
    expect(voiceFileName('DialogueGeneric', { editorId: 'OfferServicesTopic' }, 0x7f6bc, 1)).toBe(
      'DialogueGe_OfferServicesTo_0007F6BC_1',
    );
    // A short quest id leaves the topic's id the rest of the 25 characters.
    expect(voiceFileName('MS13', { editorId: 'MS13LucanQuestGiveBranchTopic' }, 0x3962c, 1)).toBe(
      'MS13_MS13LucanQuestGiveBra_0003962C_1',
    );
    expect(voiceFileName('MQ101', { editorId: 'MQ101SoldierBlockingTopic' }, 0x648f4, 1)).toBe(
      'MQ101_MQ101SoldierBlocking_000648F4_1',
    );
    expect(voiceFileName('MQ101', { editorId: 'MQ101Topic' }, 0x1234, 2)).toBe(
      'MQ101_MQ101Topic_00001234_2',
    );
  });
});
