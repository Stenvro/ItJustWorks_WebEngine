import { describe, expect, it } from 'vitest';
import { EffectFlag } from '../../world/magic-effects.ts';
import { shoutAttacks } from './spell-score.ts';

const { hostile, recover, noArea, fxPersist, hideInUi, dispelWithKeywords } = EffectFlag;

describe('the combat AI shouts', () => {
  it('a word whose spell has a hostile effect, whatever its delivery', () => {
    // Unrelenting Force's words: aimed, a hostile Stagger.
    expect(shoutAttacks([{ flags: hostile | recover }])).toBe(true);
    // Alduin's Firestorm (DragonVoiceStormCall), a self spell: its hostile 600-unit Stagger
    // area, the storm's hazard on the shouter, the script effect for the AI's use of Storm Call.
    expect(
      shoutAttacks([
        { flags: hostile | recover | fxPersist },
        { flags: recover | dispelWithKeywords | noArea | fxPersist },
        { flags: hideInUi },
      ]),
    ).toBe(true);
  });

  it('not a word whose spell has none', () => {
    // Clear Skies' words (VoiceClearSkiesSelf1-3): one script effect, not hostile.
    expect(shoutAttacks([{ flags: recover | dispelWithKeywords | noArea | hideInUi }])).toBe(false);
    expect(shoutAttacks([])).toBe(false);
  });
});
