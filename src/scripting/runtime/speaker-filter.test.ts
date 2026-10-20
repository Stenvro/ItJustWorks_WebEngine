import { describe, expect, it } from 'vitest';
import { ConditionRunOn, type Condition } from '../conditions.ts';
import { failsForSpeaker, type SpeakerFacts } from './speaker-filter.ts';

const condition = (fn: number, form: number, more: Partial<Condition> = {}): Condition => ({
  function: fn,
  operator: 0,
  or: false,
  comparand: 1,
  form,
  param2: 0,
  raw1: form,
  form2: 0,
  strings: [],
  runOn: ConditionRunOn.subject,
  reference: 0,
  param3: 0,
  eventMember: '',
  ...more,
});

const GET_IS_ID = 72;
const GET_IS_VOICE_TYPE = 426;
const GET_IS_ALIAS_REF = 566;
const GET_STAGE = 58;

const hulda: SpeakerFacts = {
  reference: 0x1a66e,
  base: 0x13ba3,
  voiceIs: (form) => (form === 0x13ad3 ? true : form === 0x500 ? undefined : false),
  aliasIs: (alias) => alias === 4,
};

describe('lines told apart by their speaker', () => {
  it('fails an info of another actor, not one of hers', () => {
    expect(failsForSpeaker([condition(GET_IS_ID, 0x13bb0)], hulda)).toBe(true);
    expect(failsForSpeaker([condition(GET_IS_ID, 0x13ba3)], hulda)).toBe(false);
    // Her reference counts too; "not her" fails for her.
    expect(failsForSpeaker([condition(GET_IS_ID, 0x1a66e)], hulda)).toBe(false);
    expect(failsForSpeaker([condition(GET_IS_ID, 0x13ba3, { comparand: 0 })], hulda)).toBe(true);
  });

  it('takes OR groups as the engine does', () => {
    const voices = (...forms: number[]): Condition[] =>
      forms.map((form, i) => condition(GET_IS_VOICE_TYPE, form, { or: i < forms.length - 1 }));
    expect(failsForSpeaker(voices(0x13ad1, 0x13ad2), hulda)).toBe(true);
    expect(failsForSpeaker(voices(0x13ad1, 0x13ad3), hulda)).toBe(false);
    // A list not read yet: not known, so it may hold.
    expect(failsForSpeaker(voices(0x13ad1, 0x500), hulda)).toBe(false);
    // An AND after the group still fails it.
    expect(failsForSpeaker([...voices(0x13ad1, 0x13ad3), condition(GET_IS_ID, 1)], hulda)).toBe(
      true,
    );
  });

  it('leaves what it cannot decide to the conditions', () => {
    expect(failsForSpeaker([condition(GET_STAGE, 0x100, { comparand: 10 })], hulda)).toBe(false);
    // Run on the target, against a global: valued later.
    expect(
      failsForSpeaker([condition(GET_IS_ID, 0x7, { runOn: ConditionRunOn.target })], hulda),
    ).toBe(false);
    expect(
      failsForSpeaker([condition(GET_IS_ID, 0x13bb0, { comparand: { global: 9 } })], hulda),
    ).toBe(false);
  });

  it("knows the aliases of the info's quest", () => {
    expect(failsForSpeaker([condition(GET_IS_ALIAS_REF, 4)], hulda)).toBe(false);
    expect(failsForSpeaker([condition(GET_IS_ALIAS_REF, 5)], hulda)).toBe(true);
  });
});
