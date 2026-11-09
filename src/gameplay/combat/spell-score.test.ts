import { describe, expect, it } from 'vitest';
import { Delivery } from '../../world/magic-records.ts';
import { shoutAttacks } from './spell-score.ts';

describe('the combat AI shouts', () => {
  it('a word that goes out from the shouter, not one on the shouter itself', () => {
    // Unrelenting Force's words are aimed; Clear Skies' (VoiceClearSkiesSelf1-3) are self spells.
    expect(shoutAttacks({ delivery: Delivery.aimed })).toBe(true);
    expect(shoutAttacks({ delivery: Delivery.targetLocation })).toBe(true);
    expect(shoutAttacks({ delivery: Delivery.self })).toBe(false);
  });
});
