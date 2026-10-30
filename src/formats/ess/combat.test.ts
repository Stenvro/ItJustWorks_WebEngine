import { describe, expect, it } from 'vitest';
import { CombatUnknown, combatTypeName, readCombatController, readCombatObject } from './combat.ts';
import { EssReader } from './ess-reader.ts';
import { EssWriter } from './ess-test-writer.ts';
import { PathingStream } from './movement.ts';
import { pathingTypeId } from './pathing-type.ts';

const resolve = (raw: number): number => raw & 0x3fffff;
const stream = (data: Uint8Array): PathingStream => new PathingStream(new EssReader(data), resolve);

/** A combat target selector, written the first time (id | 1, type, data). */
function selector(writer: EssWriter, id: number): EssWriter {
  return writer
    .u32(id | 1)
    .u32(pathingTypeId('CombatTargetSelectorStandard'))
    .refId(1, 0x14)
    .u32(0)
    .u32(0)
    .f32(1)
    .f32(2);
}

describe('combat AI objects', () => {
  it('keys the combat classes by their names, templates by their arguments mixed in', () => {
    // The original's id for the cover search, as the saves hold it.
    expect(combatTypeName(0x93409b55)).toBe('CombatCoverSearch');
    const magic =
      (pathingTypeId('CombatInventoryItemMagicT') ^
        pathingTypeId('CombatInventoryItemShout') ^
        pathingTypeId('CombatMagicCasterOffensive')) >>>
      0;
    expect(combatTypeName(magic)).toBe('CombatInventoryItemMagicT<Shout, Offensive>');
  });

  it('reads an object the first time, its id alone after', () => {
    const data = selector(new EssWriter(), 0x1000).u32(0x1000).u32(0).done();
    const s = stream(data);
    readCombatObject(s);
    readCombatObject(s);
    readCombatObject(s);
    expect(s.reader.remaining).toBe(0);
  });

  it('names a combat class it has no layout for', () => {
    const data = new EssWriter().u32(0x1001).u32(0x12345678).done();
    expect(() => {
      readCombatObject(stream(data));
    }).toThrow(CombatUnknown);
  });

  it('reads a combat controller to its end', () => {
    const w = new EssWriter().refId(1, 0x1234).refId(1, 0x14).u32(7);
    w.bytes([1, 1, 0, 0, 0, 0]).f32(0).f32(0).f32(0);
    // No aim controllers (current and previous: none), no areas, one target selector, the
    // current and previous selectors (the same one, by id).
    w.vsval(0).i32(-1).i32(-1).vsval(0).i32(-1).vsval(1);
    selector(w, 0x2000).u32(0x2000).u32(0x2000);
    // The combat state.
    w.bytes(new Uint8Array(6 + 4 + 12 + 4 + 2 + 12 + 4 + 1 + 16 + 32));
    w.vsval(0)
      .vsval(1)
      .refId(1, 0x14)
      .u8(0)
      .bytes(new Uint8Array(24 + 4));
    // The inventory: its values, seven empty lists, two empty sets, four empty lists.
    w.bytes(new Uint8Array(40 + 1 + 4 + 8));
    for (let i = 0; i < 7; i++) w.vsval(0);
    for (let i = 0; i < 2; i++) w.vsval(0).bytes(new Uint8Array(20));
    w.vsval(0).vsval(0).vsval(0).vsval(0);
    // The blackboard: a timer and a time stamp.
    w.vsval(2).wstring('AcquireWeaponTimer').f32(1).f32(2).wstring('CoverSearchFailedTimeStamp');
    w.f32(3).u32(0);
    // The behaviour tree: a running tree's state (its size first), two trees, one named state.
    w.u32(0).u8(1).vsval(3).bytes([1, 2, 3]).vsval(2).u32(4).u32(5);
    w.vsval(1).wstring('Combat').u32(1).vsval(1).u32(2).vsval(1).u32(3).u32(4);
    const s = stream(w.done());
    expect(readCombatController(s)).toEqual({
      attacker: 0x1234,
      target: 0x14,
      blackboard: ['AcquireWeaponTimer', 'CoverSearchFailedTimeStamp'],
    });
    expect(s.reader.remaining).toBe(0);
  });
});
