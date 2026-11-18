import { describe, expect, it } from 'vitest';
import { InfoFlag } from '../../world/dialogue-records.ts';
import {
  InfoMemory,
  afterInfo,
  hiddenInMenu,
  resetHours,
  saidOnWalkAway,
  saysUnasked,
} from './dialogue-rules.ts';

/** A day of game time is 1 in game days passed. */
const HOUR = 1 / 24;

const info = (flags: number, resetRaw = 0, choices: number[] = []) => ({
  formId: 0x1234,
  flags,
  resetHours: resetRaw,
  choices,
});

describe('dialogue info rules', () => {
  it('reads Reset Hours on the 65535-a-day scale', () => {
    expect(resetHours(info(0, 1365))).toBeCloseTo(0.5, 2);
    expect(resetHours(info(0, 65535))).toBeCloseTo(24, 5);
  });

  it('says a Reset Hours info again only after its hours', () => {
    const memory = new InfoMemory();
    const greeting = info(0, 1365);
    const start = 3 + 8 * HOUR;
    expect(memory.maySay(greeting, start)).toBe(true);
    memory.said(greeting, start);
    expect(memory.maySay(greeting, start + 0.25 * HOUR)).toBe(false);
    expect(memory.maySay(greeting, start + 0.5 * HOUR)).toBe(true);
  });

  it('never says a Say Once info again, Reset Hours or not; a Say Once refusal repeats', () => {
    const memory = new InfoMemory();
    const once = info(InfoFlag.sayOnce);
    memory.said(once, 1);
    expect(memory.maySay(once, 100)).toBe(false);
    // The rest ends after a day, the Say Once mark stays.
    const daily = { ...info(InfoFlag.sayOnce, 65535), formId: 0x99 };
    memory.said(daily, 1);
    expect(memory.maySay(daily, 1 + 23 * HOUR)).toBe(false);
    expect(memory.maySay(daily, 3)).toBe(false);
    const refusal = { ...info(InfoFlag.sayOnce | InfoFlag.infoRefusal), formId: 0x77 };
    memory.said(refusal, 1);
    expect(memory.maySay(refusal, 1)).toBe(true);
  });

  it('goes on past an Invisible Continue info to its choice without the menu; Goodbye closes', () => {
    expect(afterInfo(info(InfoFlag.invisibleContinue, 0, [0x50]))).toBe('continue');
    expect(afterInfo(info(InfoFlag.invisibleContinue | InfoFlag.goodbye, 0, [0x50]))).toBe(
      'continue',
    );
    // Without a choice the topics show.
    expect(afterInfo(info(InfoFlag.invisibleContinue))).toBe('topics');
    expect(afterInfo(info(InfoFlag.goodbye, 0, [0x50]))).toBe('close');
    expect(afterInfo(info(0, 0, [0x50]))).toBe('topics');
  });

  it("says the offering info's Walk Away topic as the player walks off, unlisted if invisible", () => {
    // DB02's Astrid as the player wakes (DBAstridWakeUpTopic's info 0005254A): flags Walk Away
    // and Walk Away Invisible In Menu, TWAT DB02AstridWalkAwayTopic [000CEFB8], choices
    // 00052547 and 000CEFB8.
    const WALK_AWAY = 0xcefb8;
    const OTHER = 0x52547;
    const astrid = (flags: number) => ({ flags, walkAwayTopic: WALK_AWAY });
    const both = InfoFlag.walkAway | InfoFlag.walkAwayInvisibleInMenu;
    expect(saidOnWalkAway(astrid(both), WALK_AWAY)).toBe(true);
    expect(hiddenInMenu(astrid(both), WALK_AWAY)).toBe(true);
    expect(saidOnWalkAway(astrid(both), OTHER)).toBe(false);
    expect(hiddenInMenu(astrid(both), OTHER)).toBe(false);
    // Walk Away alone: said as the player walks off, and listed.
    expect(saidOnWalkAway(astrid(InfoFlag.walkAway), WALK_AWAY)).toBe(true);
    expect(hiddenInMenu(astrid(InfoFlag.walkAway), WALK_AWAY)).toBe(false);
    // Without the flag, or with no offering info (the top-level topics), nothing is.
    expect(saidOnWalkAway(astrid(0), WALK_AWAY)).toBe(false);
    expect(hiddenInMenu(undefined, WALK_AWAY)).toBe(false);
  });

  it('keeps a Requires Player Activation info for the conversation the player starts', () => {
    expect(saysUnasked(info(InfoFlag.requiresPlayerActivation))).toBe(false);
    expect(saysUnasked(info(InfoFlag.random))).toBe(true);
  });
});
