import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { effectText, EffectFlag, parseMagicEffect } from './magic-effects.ts';

describe('magic effects', () => {
  it('read the flags, skill, archetype and actor value from DATA', () => {
    const data = new DataView(new ArrayBuffer(152));
    data.setUint32(0, EffectFlag.recover | EffectFlag.noDuration, true);
    data.setFloat32(4, 0.5, true);
    data.setInt32(12, -1, true);
    data.setUint32(64, 34, true);
    data.setInt32(68, 24, true);
    const fields = new Fields([{ type: 'DATA', data: new Uint8Array(data.buffer) }]);
    const effect = parseMagicEffect({
      formId: 1,
      editorId: 'AlchFortifyHealth',
      fields,
      text: (type) =>
        type === 'DNAM'
          ? 'Health is increased by <mag> points for <dur> seconds.'
          : 'Fortify Health',
    });
    expect(effect).toMatchObject({
      flags: 0x202,
      baseCost: 0.5,
      skill: -1,
      archetype: 34,
      actorValue: 24,
    });
    expect(effectText(effect, 24.6, 60, 0)).toBe(
      'Health is increased by 25 points for 60 seconds.',
    );
  });
});
