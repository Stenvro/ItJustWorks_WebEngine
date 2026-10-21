import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import { EntryFunction, EntryPoint } from '../gameplay/perk-entry-points.ts';
import { parsePerk } from './perk-records.ts';

/** A CTDA: flags, comparand, function, its first parameter. */
function ctda(flags: number, comparand: number, fn: number, param: number): Uint8Array {
  const data = new DataView(new ArrayBuffer(32));
  data.setUint8(0, flags);
  data.setFloat32(4, comparand, true);
  data.setUint16(8, fn, true);
  data.setUint32(12, param, true);
  data.setInt32(28, -1, true);
  return new Uint8Array(data.buffer);
}

const u32 = (value: number): Uint8Array => new Uint8Array(Uint32Array.of(value).buffer);
const f32 = (...values: number[]): Uint8Array => new Uint8Array(Float32Array.of(...values).buffer);

function perk(fields: [string, Uint8Array][], texts: Record<string, string> = {}) {
  return parsePerk({
    formId: 0x79343,
    editorId: 'Armsman40',
    fields: new Fields(fields.map(([type, data]) => ({ type, data }))),
    text: (type) => texts[type],
    formIdAt: (data, offset) =>
      new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset ?? 0, true),
    textAt: (data) => new TextDecoder().decode(data.subarray(0, Math.max(0, data.indexOf(0)))),
  });
}

describe('perks', () => {
  it('reads the requirements before the entries, the ranks and the next rank', () => {
    const record = perk(
      [
        ['CTDA', ctda(0x60, 40, 277, 6)], // GetBaseActorValue OneHanded >= 40
        ['DATA', Uint8Array.of(0, 0, 1, 1, 0)],
        ['NNAM', u32(0x79344)],
        ['PRKE', Uint8Array.of(2, 0, 0)],
        ['DATA', Uint8Array.of(EntryPoint.modAttackDamage, EntryFunction.multiplyValue, 3)],
        ['PRKC', Uint8Array.of(0)],
        ['CTDA', ctda(0, 0, 448, 0x79344)], // HasPerk Armsman60 == 0
        ['PRKC', Uint8Array.of(1)],
        ['CTDA', ctda(0x01, 1, 560, 0x1e711)], // HasKeyword WeapTypeSword OR
        ['CTDA', ctda(0, 1, 560, 0x1e713)], // HasKeyword WeapTypeDagger
        ['EPFT', Uint8Array.of(1)],
        ['EPFD', f32(1.6)],
        ['PRKF', new Uint8Array(0)],
      ],
      { FULL: 'Armsman', DESC: 'One-Handed weapons do 60% more damage.' },
    );
    expect(record.name).toBe('Armsman');
    expect(record.conditions).toHaveLength(1);
    expect(record.conditions[0]).toMatchObject({ function: 277, raw1: 6, comparand: 40 });
    expect(record.playable).toBe(true);
    expect(record.next).toBe(0x79344);
    expect(record.entries).toHaveLength(1);
    const entry = record.entries[0];
    expect(entry?.kind).toBe('entryPoint');
    if (entry?.kind !== 'entryPoint') return;
    expect(entry.entryPoint).toBe(EntryPoint.modAttackDamage);
    expect(entry.function).toBe(EntryFunction.multiplyValue);
    expect(entry.tabCount).toBe(3);
    expect(entry.conditions[0]?.map((c) => c.function)).toEqual([448]);
    expect(entry.conditions[1]?.map((c) => c.form)).toEqual([0x1e711, 0x1e713]);
    expect(entry.data.type).toBe('float');
    if (entry.data.type === 'float') expect(entry.data.value).toBeCloseTo(1.6);
  });

  it('reads quest stages, abilities and every function data type', () => {
    const label = new TextEncoder().encode('Feed\0');
    const record = perk([
      ['DATA', Uint8Array.of(0, 0, 1, 1, 0)],
      ['PRKE', Uint8Array.of(0, 0, 0)],
      ['DATA', Uint8Array.of(...u32(0x5f596), 50, 0, 0, 0)],
      ['PRKF', new Uint8Array(0)],
      ['PRKE', Uint8Array.of(1, 0, 3)],
      ['DATA', u32(0xaf66a)],
      ['PRKF', new Uint8Array(0)],
      // Multiply 1 + Actor Value Mult: the actor value stored as a float.
      ['PRKE', Uint8Array.of(2, 0, 20)],
      ['DATA', Uint8Array.of(EntryPoint.modAlchemyEffectiveness, 14, 1)],
      ['EPFT', Uint8Array.of(2)],
      ['EPFD', f32(145, 0.01)],
      ['PRKF', new Uint8Array(0)],
      // Add Range To Value: two floats.
      ['PRKE', Uint8Array.of(2, 0, 0)],
      ['DATA', Uint8Array.of(EntryPoint.modSkillUse, 4, 1)],
      ['EPFT', Uint8Array.of(2)],
      ['EPFD', f32(1, 3)],
      ['PRKF', new Uint8Array(0)],
      // Add Activate Choice: a spell, its button and script flags.
      ['PRKE', Uint8Array.of(2, 0, 1)],
      ['DATA', Uint8Array.of(EntryPoint.activate, 9, 2)],
      ['EPFT', Uint8Array.of(4)],
      ['EPF2', label],
      ['EPF3', Uint8Array.of(3, 0, 4, 0)],
      ['EPFD', u32(0x1234)],
      ['PRKF', new Uint8Array(0)],
      // Select Spell, Select Text.
      ['PRKE', Uint8Array.of(2, 0, 0)],
      ['DATA', Uint8Array.of(EntryPoint.applyCombatHitSpell, 10, 3)],
      ['EPFT', Uint8Array.of(5)],
      ['EPFD', u32(0xc1e99)],
      ['PRKF', new Uint8Array(0)],
      ['PRKE', Uint8Array.of(2, 0, 0)],
      ['DATA', Uint8Array.of(EntryPoint.setBooleanGraphVariable, 11, 1)],
      ['EPFT', Uint8Array.of(6)],
      ['EPFD', new TextEncoder().encode('bPerkQuickReflexes\0')],
      ['PRKF', new Uint8Array(0)],
    ]);
    const [quest, ability, alchemy, range, choice, spell, text] = record.entries;
    expect(quest).toEqual({ kind: 'quest', rank: 0, priority: 0, quest: 0x5f596, stage: 50 });
    expect(ability).toEqual({ kind: 'ability', rank: 0, priority: 3, spell: 0xaf66a });
    expect(alchemy).toMatchObject({ priority: 20, data: { type: 'actorValue', actorValue: 145 } });
    expect(range).toMatchObject({ data: { type: 'range', min: 1, max: 3 } });
    expect(choice).toMatchObject({
      data: {
        type: 'activateChoice',
        spell: 0x1234,
        label: 'Feed',
        runImmediately: true,
        replaceDefault: true,
        fragment: 4,
      },
    });
    expect(spell).toMatchObject({ data: { type: 'spell', spell: 0xc1e99 } });
    expect(text).toMatchObject({ data: { type: 'text', text: 'bPerkQuickReflexes' } });
  });
});
