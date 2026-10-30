import { describe, expect, it } from 'vitest';
import { Layer } from '../physics/collision-layers.ts';
import { Delivery } from '../world/magic-records.ts';
import {
  AimedHands,
  CROSSHAIR_DEFAULT_REACH,
  crosshairReach,
  crosshairValid,
} from './hud-crosshair.ts';

const summon = { delivery: Delivery.targetLocation, projectile: 0x1234 };
const placed = { delivery: Delivery.targetLocation, projectile: undefined };
const aimed = { delivery: Delivery.aimed, projectile: 0x99 };

describe("the crosshair's check of a Target Location spell", () => {
  it('holds where a placed effect meets static, terrain or ground', () => {
    for (const layer of [Layer.static, Layer.terrain, Layer.ground])
      expect(crosshairValid([summon], layer)).toBe(true);
  });

  it('is Alert on any other surface, and where the aim meets nothing', () => {
    expect(crosshairValid([summon], Layer.clutter)).toBe(false);
    expect(crosshairValid([summon], Layer.biped)).toBe(false);
    expect(crosshairValid([summon], Layer.water)).toBe(false);
    expect(crosshairValid([summon], undefined)).toBe(false);
    expect(crosshairValid([], undefined)).toBe(false);
  });

  it('passes effects with another delivery or no projectile', () => {
    expect(crosshairValid([placed, aimed], Layer.clutter)).toBe(true);
    expect(crosshairValid([placed, summon], Layer.clutter)).toBe(false);
  });

  it("reaches the spell's range in feet, else 5000 units", () => {
    expect(crosshairReach(100, 22)).toBe(2200);
    expect(crosshairReach(0, 22)).toBe(CROSSHAIR_DEFAULT_REACH);
  });

  it('checks the first hand to get such a spell, and goes back to Normal as the last lets go', () => {
    const hands = new AimedHands();
    expect(
      hands.update(
        new Map([
          [0, false],
          [1, true],
        ]),
      ),
    ).toEqual({ hand: 1, emptied: false });
    expect(
      hands.update(
        new Map([
          [0, true],
          [1, true],
        ]),
      ),
    ).toEqual({ hand: 1, emptied: false });
    expect(
      hands.update(
        new Map([
          [0, true],
          [1, false],
        ]),
      ),
    ).toEqual({ hand: 0, emptied: false });
    expect(
      hands.update(
        new Map([
          [0, false],
          [1, false],
        ]),
      ),
    ).toEqual({
      hand: undefined,
      emptied: true,
    });
    expect(hands.update(new Map([[0, false]]))).toEqual({ hand: undefined, emptied: false });
  });
});
