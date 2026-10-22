import { describe, expect, it } from 'vitest';
import { BipedSlot, slotBit } from '../world/actor-records.ts';
import { armorWarmth, lightWarmth, TORCH_WARMTH } from './warmth.ts';

const WARM = 1;
const COLD = 2;
const BODY_AND_HEAD = 3;
const ids = { warm: WARM, cold: COLD, bodyAndHead: BODY_AND_HEAD };

describe('armorWarmth', () => {
  it('gives each body part its warmth by the warm and cold keywords', () => {
    const body = slotBit(BipedSlot.body);
    expect(armorWarmth(body, [], ids)).toBe(27);
    expect(armorWarmth(body, [WARM], ids)).toBe(54);
    expect(armorWarmth(body, [COLD], ids)).toBe(17);
    expect(armorWarmth(slotBit(BipedSlot.head) | slotBit(BipedSlot.hair), [WARM], ids)).toBe(29);
    expect(armorWarmth(slotBit(BipedSlot.hair), [], ids)).toBe(18);
    expect(armorWarmth(slotBit(BipedSlot.hands), [COLD], ids)).toBe(7);
    expect(armorWarmth(slotBit(BipedSlot.feet), [WARM], ids)).toBe(24);
  });

  it('warms a hooded robe as body and head', () => {
    const robe = slotBit(BipedSlot.body) | slotBit(BipedSlot.hair);
    expect(armorWarmth(robe, [WARM, BODY_AND_HEAD], ids)).toBe(54 + 29);
    expect(armorWarmth(robe, [WARM], ids)).toBe(54);
  });

  it('gives shields, jewelry and circlets none', () => {
    for (const slot of [BipedSlot.shield, BipedSlot.amulet, BipedSlot.ring, BipedSlot.circlet])
      expect(armorWarmth(slotBit(slot), [WARM], ids)).toBe(0);
  });

  it('reads no keyword when Update.esm is missing', () => {
    const none = { warm: undefined, cold: undefined, bodyAndHead: undefined };
    expect(armorWarmth(slotBit(BipedSlot.body), [WARM], none)).toBe(27);
  });
});

describe('lightWarmth', () => {
  it('warms with a carried light only', () => {
    expect(lightWarmth(true)).toBe(TORCH_WARMTH);
    expect(lightWarmth(false)).toBe(0);
  });
});
