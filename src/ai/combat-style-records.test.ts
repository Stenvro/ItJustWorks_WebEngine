import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  CombatStyleFlag,
  CombatStyleRecordFlag,
  parseCombatStyle,
  storedFloats,
} from './combat-style-records.ts';

const f32s = (...values: number[]): Uint8Array => new Uint8Array(Float32Array.from(values).buffer);
const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const record = (fields: [string, Uint8Array][], flags = 0) => {
  const list = new Fields(fields.map(([type, data]) => ({ type, data })));
  return { formId: 0x3be1c, editorId: list.zstring('EDID'), flags, fields: list };
};

describe('combat styles', () => {
  it('read every field of a full record', () => {
    const style = parseCombatStyle(
      record(
        [
          ['EDID', text('csHumanMelee')],
          ['CSGD', f32s(0.75, 0.25, 0.5, 2, 0, 0.5, 1.5, 0.25, 3, 0.125)],
          ['CSME', f32s(2, 1.5, 0.5, 0.25, 0.75, 1.25, 1.75, 0.375)],
          ['CSCR', f32s(0.5, 0.25, 0.75, 1.5)],
          ['CSLR', f32s(0.625)],
          ['CSFL', f32s(0.5, 0.25, 0.75, 2, 3, 0.125, 4, 0.875)],
          ['DATA', u32s(CombatStyleFlag.flanking | CombatStyleFlag.allowDualWielding)],
        ],
        CombatStyleRecordFlag.allowDualWielding,
      ),
    );
    expect(style).toEqual({
      formId: 0x3be1c,
      editorId: 'csHumanMelee',
      general: {
        offensiveMult: 0.75,
        defensiveMult: 0.25,
        groupOffensiveMult: 0.5,
        equipmentScoreMult: {
          melee: 2,
          magic: 0,
          ranged: 0.5,
          shout: 1.5,
          unarmed: 0.25,
          staff: 3,
        },
        avoidThreatChance: 0.125,
      },
      melee: {
        attackStaggeredMult: 2,
        powerAttackStaggeredMult: 1.5,
        powerAttackBlockingMult: 0.5,
        bashMult: 0.25,
        bashRecoilMult: 0.75,
        bashAttackMult: 1.25,
        bashPowerAttackMult: 1.75,
        specialAttackMult: 0.375,
      },
      closeRange: { circleMult: 0.5, fallbackMult: 0.25, flankDistance: 0.75, stalkTime: 1.5 },
      longRange: { strafeMult: 0.625 },
      flight: {
        hoverChance: 0.5,
        diveBombChance: 0.25,
        groundAttackChance: 0.75,
        hoverTime: 2,
        groundAttackTime: 3,
        perchAttackChance: 0.125,
        perchAttackTime: 4,
        flyingAttackChance: 0.875,
      },
      flags: 0x6,
      recordFlags: 0x80000,
    });
  });

  it('take the defaults for values a field leaves out, and for missing fields', () => {
    // As csDraugrMissile: CSGD 8 floats, CSME 7, CSCR 2, CSFL 3, no DATA; and no CSLR.
    const source = record([
      ['EDID', text('csShort')],
      ['CSGD', f32s(0.25, 0.75, 0.5, 2, 0, 1.5, 0, 3)],
      ['CSME', f32s(2, 2, 2, 2, 2, 2, 2)],
      ['CSCR', f32s(0.5, 0.75)],
      ['CSFL', f32s(0.25, 0.5, 0)],
    ]);
    const style = parseCombatStyle(source);
    expect(style.general).toEqual({
      offensiveMult: 0.25,
      defensiveMult: 0.75,
      groupOffensiveMult: 0.5,
      equipmentScoreMult: { melee: 2, magic: 0, ranged: 1.5, shout: 0, unarmed: 3, staff: 1 },
      avoidThreatChance: 0.2,
    });
    expect(style.melee.bashPowerAttackMult).toBe(2);
    expect(style.melee.specialAttackMult).toBe(0.1);
    expect(style.closeRange).toEqual({
      circleMult: 0.5,
      fallbackMult: 0.75,
      flankDistance: 0.2,
      stalkTime: 0.2,
    });
    expect(style.longRange.strafeMult).toBe(0.2);
    expect(style.flight).toEqual({
      hoverChance: 0.25,
      diveBombChance: 0.5,
      groundAttackChance: 0,
      hoverTime: 0.5,
      groundAttackTime: 0.5,
      perchAttackChance: 0.5,
      perchAttackTime: 0.5,
      flyingAttackChance: 0.75,
    });
    expect(style.flags).toBe(0);
    expect([storedFloats(source, 'CSGD'), storedFloats(source, 'CSLR')]).toEqual([8, 0]);
  });

  it('read a record with only the first two general values (TestCombatStyleDefensive50)', () => {
    const style = parseCombatStyle(
      record([
        ['EDID', text('TestCombatStyleDefensive50')],
        ['CSGD', f32s(0.25, 1)],
        ['CSMD', f32s(0, 0)],
      ]),
    );
    expect(style.general.offensiveMult).toBe(0.25);
    expect(style.general.defensiveMult).toBe(1);
    expect(style.general.equipmentScoreMult.melee).toBe(1);
    expect(style.melee.attackStaggeredMult).toBe(1);
    expect(style.flight.diveBombChance).toBe(1);
  });
});
