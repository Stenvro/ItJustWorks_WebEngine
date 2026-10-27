import { describe, expect, it } from 'vitest';
import {
  heldInMenu,
  ownMenuRule,
  readCategoryRoles,
  timeSensitive,
  type CategoryRoles,
} from './category-rules.ts';

// The category tree of Skyrim.esm (SNCT PNAM) with made-up form ids, and the default objects
// that name its roles.
const MASTER = 1;
const LOAD = 2; // AudioCategoryPausedDuringMenuLoad (DOBJ PDLC)
const SFX = 3;
const UI = 4;
const FADE_IN_DIALOGUE = 5;
const FADE = 6; // AudioCategoryPausedDuringMenuFade (PDMC)
const AMBR = 7; // AudioCategoryAMBr (SMSC)
const IMMEDIATE = 8; // AudioCategoryPausedDuringMenu (PIMC)
const VOC_GENERAL = 9;
const VOC = 10;
const MUS = 11;
const KILL_MOVE = 12; // AudioCategoryNPCKillMove (TSSC)
const FOOTSTEPS = 13;

const parents = new Map<number, number>([
  [LOAD, MASTER],
  [SFX, LOAD],
  [UI, SFX],
  [FADE_IN_DIALOGUE, SFX],
  [FADE, FADE_IN_DIALOGUE],
  [AMBR, FADE],
  [IMMEDIATE, MASTER],
  [VOC_GENERAL, IMMEDIATE],
  [VOC, VOC_GENERAL],
  [MUS, MASTER],
  [KILL_MOVE, FADE_IN_DIALOGUE],
  [FOOTSTEPS, FADE_IN_DIALOGUE],
]);
const parentOf = (category: number): number | undefined => parents.get(category);

const uses = new Map<string, number>([
  ['PDMC', FADE],
  ['PIMC', IMMEDIATE],
  ['PDLC', LOAD],
  ['SMSC', AMBR],
  ['TSSC', KILL_MOVE],
]);
const roles: CategoryRoles = readCategoryRoles({ get: (use) => uses.get(use) });

describe('sound categories in menus (DOBJ PDMC, PIMC, PDLC, SMSC)', () => {
  it('holds the paused branches in a pausing menu and lets the others play on', () => {
    const table = [AMBR, VOC, UI, MUS, FOOTSTEPS, MASTER].map((category) => [
      category,
      heldInMenu(category, parentOf, roles, 'menu'),
    ]);
    expect(table).toEqual([
      [AMBR, 'fade'],
      [VOC, 'immediate'],
      [UI, undefined],
      [MUS, undefined],
      [FOOTSTEPS, undefined],
      [MASTER, undefined],
    ]);
    expect(ownMenuRule(FADE, roles, 'menu')).toBe('fade');
    expect(ownMenuRule(LOAD, roles, 'menu')).toBeUndefined();
    expect(heldInMenu(VOC, parentOf, roles, 'none')).toBeUndefined();
  });

  it('holds the loading category on the loading screen; the skills menu mutes SMSC', () => {
    expect(heldInMenu(UI, parentOf, roles, 'loading')).toBe('immediate');
    expect(heldInMenu(FOOTSTEPS, parentOf, roles, 'loading')).toBe('immediate');
    expect(heldInMenu(MUS, parentOf, roles, 'loading')).toBeUndefined();
    expect(ownMenuRule(AMBR, roles, 'stats')).toBe('immediate');
    expect(ownMenuRule(AMBR, roles, 'menu')).toBeUndefined();
    // The mute silences; the hold is the pausing menu's (AMBr is under the fading category).
    expect(heldInMenu(AMBR, parentOf, roles, 'stats')).toBe('fade');
  });
});

describe('Slow Time (DOBJ TSSC)', () => {
  it('slows the time-sensitive category and its branch only', () => {
    expect(timeSensitive(KILL_MOVE, parentOf, roles)).toBe(true);
    expect(timeSensitive(FOOTSTEPS, parentOf, roles)).toBe(false);
    expect(timeSensitive(MUS, parentOf, roles)).toBe(false);
    expect(timeSensitive(undefined, parentOf, roles)).toBe(false);
  });
});
