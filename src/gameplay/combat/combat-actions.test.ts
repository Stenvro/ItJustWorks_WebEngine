import { describe, expect, it } from 'vitest';
import {
  anticipatesBlow,
  forceEquips,
  handsChanged,
  releasedTogether,
  wantsReload,
  type HandForms,
} from './combat-actions.ts';

const SWORD = 0x12eb7;
const DAGGER = 0x1397e;
const SHIELD = 0x12eb6;

const hands = (changes: Partial<HandForms> = {}): HandForms => ({
  right: SWORD,
  left: undefined,
  shield: SHIELD,
  torch: false,
  rightSpell: undefined,
  leftSpell: undefined,
  ...changes,
});

describe('ActionForceEquip', () => {
  it('is performed when what a hand holds changes while the weapon is out', () => {
    expect(forceEquips(hands(), hands({ right: DAGGER }), true)).toBe(true);
    expect(forceEquips(hands(), hands({ shield: undefined, torch: true }), true)).toBe(true);
    expect(forceEquips(hands(), hands({ leftSpell: 0x12fcd, shield: undefined }), true)).toBe(true);
  });

  it('is not performed sheathed, unchanged, or at a fighter’s first reading', () => {
    expect(forceEquips(hands(), hands({ right: DAGGER }), false)).toBe(false);
    expect(forceEquips(hands(), hands(), true)).toBe(false);
    expect(forceEquips(undefined, hands(), true)).toBe(false);
    expect(handsChanged(hands(), hands())).toBe(false);
  });
});

describe('ActionReload', () => {
  const crossbow = { crossbow: true, inHand: true, attacking: false, boltOn: false };

  it('reloads a crossbow out whose bolt is not on', () => {
    expect(wantsReload(crossbow)).toBe(true);
  });

  it('does not with the bolt on, during an attack, sheathed, or with a bow', () => {
    expect(wantsReload({ ...crossbow, boltOn: true })).toBe(false);
    expect(wantsReload({ ...crossbow, attacking: true })).toBe(false);
    expect(wantsReload({ ...crossbow, inHand: false })).toBe(false);
    expect(wantsReload({ ...crossbow, crossbow: false })).toBe(false);
  });
});

describe('ActionDualRelease', () => {
  it('counts both buttons let go within the chord as let go at once', () => {
    expect(releasedTogether({ down: 0, up: 2 }, { down: 0.1, up: 2.05 }, 0.1)).toBe(true);
    expect(releasedTogether({ down: 0, up: 2 }, { down: 0.1, up: 2.5 }, 0.1)).toBe(false);
  });

  it('needs both held together', () => {
    expect(releasedTogether({ down: 0, up: 1 }, { down: 1.05, up: 1.08 }, 0.1)).toBe(false);
  });
});

describe('ActionBlockAnticipate', () => {
  it('is performed once a blow, by a blocking actor', () => {
    const blow = {};
    expect(anticipatesBlow(true, blow, undefined)).toBe(true);
    expect(anticipatesBlow(true, blow, blow)).toBe(false);
    expect(anticipatesBlow(true, {}, blow)).toBe(true);
    expect(anticipatesBlow(false, blow, undefined)).toBe(false);
    expect(anticipatesBlow(true, undefined, blow)).toBe(false);
  });
});
