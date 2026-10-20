import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  effectSound,
  EffectArchetype,
  EffectFlag,
  EffectSound,
  effectText,
  parseMagicEffect,
} from './magic-effects.ts';

const formIdAt = (data: Uint8Array, offset = 0): number =>
  new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true);

const u32s = (...values: number[]): Uint8Array => {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, i) => {
    view.setUint32(i * 4, value, true);
  });
  return new Uint8Array(view.buffer);
};

describe('magic effects', () => {
  it('read the flags, skill, archetype and actor value from DATA', () => {
    const data = new DataView(new ArrayBuffer(152));
    data.setUint32(0, EffectFlag.recover | EffectFlag.noDuration, true);
    data.setFloat32(4, 0.5, true);
    data.setInt32(12, -1, true);
    data.setInt32(16, -1, true);
    data.setUint32(64, 34, true);
    data.setInt32(68, 24, true);
    data.setInt32(88, -1, true);
    const fields = new Fields([{ type: 'DATA', data: new Uint8Array(data.buffer) }]);
    const effect = parseMagicEffect({
      formId: 1,
      editorId: 'AlchFortifyHealth',
      fields,
      formIdAt,
      text: (type) =>
        type === 'DNAM'
          ? 'Health is increased by <mag> points for <dur> seconds.'
          : 'Fortify Health',
    });
    expect(effect).toMatchObject({
      flags: 0x202,
      baseCost: 0.5,
      skill: -1,
      resistValue: -1,
      archetype: 34,
      actorValue: 24,
      secondActorValue: -1,
      associatedItem: undefined,
      scripted: false,
    });
    expect(effectText(effect, 24.6, 60, 0)).toBe(
      'Health is increased by 25 points for 60 seconds.',
    );
  });

  it('read the forms of DATA, the keywords, counter effects, sounds and conditions', () => {
    const data = new DataView(new ArrayBuffer(152));
    data.setUint32(0, EffectFlag.hostile | EffectFlag.detrimental, true);
    data.setUint32(8, 0x2b385, true); // a cloak's spell
    data.setInt32(16, 41, true); // FireResist
    data.setUint32(32, 0x1b211, true); // hit shader
    data.setFloat32(60, 0.5, true);
    data.setUint32(64, EffectArchetype.dualValueModifier, true);
    data.setInt32(68, 24, true);
    data.setInt32(88, 25, true);
    data.setUint32(96, 0x3f5d, true); // hit art
    data.setUint32(128, 0x99, true); // equip ability
    data.setUint32(132, 0x55, true); // image space
    const ctda = new DataView(new ArrayBuffer(32));
    ctda.setUint8(0, 0); // ==
    ctda.setFloat32(4, 1, true);
    ctda.setUint16(8, 715, true); // IsUndead
    const effect = parseMagicEffect({
      formId: 2,
      editorId: 'ShockDamage',
      fields: new Fields([
        { type: 'DATA', data: new Uint8Array(data.buffer) },
        { type: 'KWDA', data: u32s(0x1ea71, 0x1ceae) },
        { type: 'ESCE', data: u32s(0x77) },
        { type: 'SNDD', data: u32s(EffectSound.onHit, 0x3c7f2, EffectSound.release, 0x3c7f3) },
        { type: 'CTDA', data: new Uint8Array(ctda.buffer) },
        { type: 'VMAD', data: new Uint8Array(4) },
      ]),
      formIdAt,
      text: () => undefined,
    });
    expect(effect).toMatchObject({
      associatedItem: 0x2b385,
      resistValue: 41,
      hitShader: 0x1b211,
      secondValueWeight: 0.5,
      archetype: EffectArchetype.dualValueModifier,
      secondActorValue: 25,
      hitEffectArt: 0x3f5d,
      equipAbility: 0x99,
      imageSpaceModifier: 0x55,
      keywords: [0x1ea71, 0x1ceae],
      counterEffects: [0x77],
      scripted: true,
    });
    expect(effectSound(effect, EffectSound.onHit)).toBe(0x3c7f2);
    expect(effectSound(effect, EffectSound.charge)).toBeUndefined();
    expect(effect.conditions).toHaveLength(1);
    expect(effect.conditions[0]?.function).toBe(715);
  });
});
