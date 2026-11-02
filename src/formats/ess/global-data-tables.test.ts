import { describe, expect, it } from 'vitest';
import { EssReader } from './ess-reader.ts';
import { EssWriter } from './ess-test-writer.ts';
import { refIdResolver } from './global-data.ts';
import { pathingTypeId } from './pathing-type.ts';
import {
  readActorCauses,
  readCombat,
  readDetectionManager,
  readIngredientShared,
  readInterface,
  readLocationMetaData,
  readMagicFavorites,
  readMain,
  readMenuControls,
  readMenuTopicManager,
  readPlayerControls,
  readProcessLists,
  readQuestStaticData,
  readStoryEventManager,
  readStoryTeller,
  readTempEffects,
} from './global-data-tables.ts';

const resolve = refIdResolver([0x0001a674, 0x0200f00d]);
/** A Skyrim.esm reference (raw kind 1). */
const ref = (writer: EssWriter, id: number): EssWriter => writer.refId(1, id);

describe('ESS global data, tables 2 and 3 (built from the documented layouts)', () => {
  it('reads process lists: crimes by type', () => {
    const w = new EssWriter().f32(1).f32(2).f32(3).u32(42);
    for (let type = 0; type < 7; type++) {
      if (type !== 4) {
        w.vsval(0);
        continue;
      }
      w.vsval(1).u32(7).u32(4).u8(0).u32(0).u32(41).u8(0).u32(0x0305).f32(-2.5);
      ref(w, 0x13bbf).refId(2, 0x14);
      ref(w, 0);
      ref(w, 0);
      w.vsval(2).refId(0, 1).refId(0, 2).u32(1000);
      ref(w, 0x267ea).u8(0).u16(0);
    }
    const lists = readProcessLists(w.done(), resolve);
    expect(lists.nextNum).toBe(42);
    expect(lists.crimes.map((crimes) => crimes.length)).toEqual([0, 0, 0, 0, 1, 0, 0]);
    expect(lists.crimes[4]?.[0]).toMatchObject({
      crimeType: 4,
      serialNum: 41,
      elapsedTime: -2.5,
      victim: 0x13bbf,
      criminal: 0xff000014,
      witnesses: [0x0001a674, 0x0200f00d],
      bounty: 1000,
      crimeFaction: 0x267ea,
      isCleared: 0,
    });
  });

  it('reads combat, with a search and its detail', () => {
    const w = new EssWriter().u32(5).vsval(1).u32(9).u32(4);
    // one target
    w.vsval(1);
    ref(w, 0x14).u32(1).f32(0.5).u16(2).u16(3);
    ref(w, 0x13bbf);
    for (let i = 0; i < 5; i++)
      ref(
        w
          .f32(i)
          .f32(i + 1)
          .f32(i + 2),
        0x3c,
      );
    for (let i = 0; i < 6; i++) w.f32(i);
    // one member
    w.vsval(1);
    ref(w, 0x13bbf).f32(1).f32(2);
    for (let i = 0; i < 15; i++) w.f32(i).f32(-i);
    // a search with detail
    w.u32(1);
    ref(w, 0x14).f32(1).f32(2).f32(3).f32(4).f32(5);
    ref(w.f32(1).f32(2).f32(3), 0x3c).f32(6);
    w.vsval(1);
    ref(w.f32(7).f32(8).f32(9), 0x3c).u32(1).f32(2);
    w.vsval(1);
    ref(ref(w, 0x14), 0x15).u8(1).u8(2).u8(3);
    // its line-of-sight grid map: two grids (a key; cells: a switch, its bytes, a navmesh and a
    // u32; the grid's navmesh), a u32, a path point in an exterior cell, two u32
    w.u8(1).u32(2);
    w.u32(2).u32(1).u8(5).u32(2).u8(0xaa).u8(0xbb);
    ref(w, 0x16).u32(3);
    ref(w, 0x17);
    w.u32(7).u32(0);
    ref(w, 0x17);
    w.u32(4).f32(1).f32(2).f32(3).u32(pathingTypeId('PathingCell'));
    ref(w, 0x3c).i32(0x00010002);
    ref(w, 0x19).u16(1).u8(2).u8(3).u32(4).u32(5);
    // the combat's tail
    w.f32(1).f32(2).f32(3).f32(4).f32(5).f32(6).f32(7).f32(8).u8(9);
    // the threats (a form and its combat object, written the first time: id | 1, type, data;
    // the second time: the id alone), then the tail
    w.vsval(2);
    ref(w, 0x14).u32(0x1001).u32(pathingTypeId('CombatThreat'));
    ref(ref(w, 0x15), 0x16);
    for (let i = 0; i < 3 + 6 + 2 + 3; i++) w.f32(i);
    ref(w, 0x17);
    ref(w, 0x15).u32(0x1000);
    w.f32(1).vsval(0).vsval(1);
    ref(w, 0x14).f32(2).f32(3).f32(4).f32(5).f32(6);
    const combat = readCombat(w.done(), resolve);
    expect(combat.nextNum).toBe(5);
    expect(combat.combats[0]?.targets[0]).toMatchObject({
      reference: 0x14,
      attackedMember: 0x13bbf,
    });
    expect(combat.combats[0]?.members[0]).toEqual({
      reference: 0x13bbf,
      strengthTimer: 1,
      threat: 2,
    });
    expect(combat.combats[0]?.targets[0]?.positions[4]).toEqual({
      position: [4, 5, 6],
      cell: 0x3c,
    });
    expect(combat.combats[0]?.pairs).toHaveLength(15);
    expect(combat.combats[0]?.search?.detail).toEqual({
      grids: [
        {
          key: 2,
          cells: [{ flag: 5, bits: new Uint8Array([0xaa, 0xbb]), navmesh: 0x16, value: 3 }],
          navmesh: 0x17,
        },
        { key: 7, cells: [], navmesh: 0x17 },
      ],
      values: [4, 4, 5],
    });
    expect(combat.combats[0]?.unknown1).toBe(9);
    expect(combat.threats).toEqual([0x14, 0x15]);
    expect(combat.references).toEqual([0x14]);
    expect(combat.pair1).toEqual([5, 6]);
  });

  it('reads the interface data, with and without its extra part', () => {
    const w = new EssWriter().u32(2).u32(0xec).u32(0xfa).u8(1).vsval(1);
    ref(w, 0x12eb7).vsval(0).vsval(1);
    ref(w, 0x13e09).u8(0);
    const base = readInterface(w.done(), resolve);
    expect(base).toEqual({
      shownHelpMessages: [0xec, 0xfa],
      unknown0: 1,
      lastUsedWeapons: [0x12eb7],
      lastUsedSpells: [],
      lastUsedShouts: [0x13e09],
      unknown1: 0,
    });
    w.vsval(1).wstring('a').wstring('b').u32(1).u32(2).u32(3).u32(4).vsval(1).wstring('c').u32(5);
    expect(readInterface(w.done(), resolve).extra).toEqual({
      entries: [{ name0: 'a', name1: 'b', values: [1, 2, 3, 4] }],
      names: ['c'],
      unknown: 5,
    });
  });

  it('reads actor causes, detection and location data', () => {
    const causes = new EssWriter().u32(3).vsval(1).f32(1).f32(2).f32(3).u32(2);
    expect(readActorCauses(ref(causes, 0x14).done(), resolve)).toEqual({
      nextNum: 3,
      causes: [{ position: [1, 2, 3], serialNum: 2, actor: 0x14 }],
    });
    expect(
      readDetectionManager(ref(new EssWriter().vsval(1), 0x14).u32(1).u32(2).done(), resolve),
    ).toEqual([{ reference: 0x14, unknown0: 1, unknown1: 2 }]);
    expect(
      readLocationMetaData(ref(new EssWriter().vsval(1), 0x18a56).u32(7).done(), resolve),
    ).toEqual([{ location: 0x18a56, unknown: 7 }]);
  });

  it('reads quest static data and its run data', () => {
    const w = new EssWriter().u32(1).u32(4).f32(0.5).u32(2).u32(1);
    ref(w, 0x14).u32(3).u32(99).u32(0).u32(1);
    ref(w, 0x3372b).u32(0).u32(0).vsval(1);
    ref(w, 0x3372b).vsval(1).u32(1).u32(2).u8(1);
    expect(readQuestStaticData(w.done(), resolve)).toEqual({
      runData0: [
        {
          unknown1: 4,
          unknown2: 0.5,
          values: [
            { type: 1, value: 0x14 },
            { type: 3, value: 99 },
          ],
        },
      ],
      runData1: [],
      references2: [0x3372b],
      references3: [],
      references4: [],
      quests: [{ quest: 0x3372b, values: [{ unknown0: 1, unknown1: 2 }] }],
      unknown6: 1,
    });
  });

  it('reads the small tables 108 to 114 and main', () => {
    expect(readStoryTeller(new EssWriter().u8(1).done())).toEqual({ flag: 1 });
    const favorites = new EssWriter().vsval(2);
    ref(ref(favorites, 0x12fcd), 0x13e09).vsval(1);
    expect(readMagicFavorites(ref(favorites, 0x12fcd).done(), resolve)).toEqual({
      favorites: [0x12fcd, 0x13e09],
      hotkeys: [0x12fcd],
    });
    expect(readPlayerControls(new EssWriter().u8(1).u8(2).u8(3).u16(4).u8(5).done())).toEqual({
      unknown0: 1,
      unknown1: 2,
      unknown2: 3,
      unknown3: 4,
      unknown4: 5,
    });
    // One event waiting: number 4, Script Event (SCPT), a reference, a number, another form
    // (kind 1, written by its form as a reference id) and a kind the original writes no
    // value for.
    const events = new EssWriter().u32(5).vsval(1).u32(4).u32(0x54504353).u32(4);
    ref(events.u32(0), 0x14).u32(3).u32(7);
    ref(events.u32(1), 0x12eb7).u32(9);
    expect(readStoryEventManager(events.done(), resolve)).toEqual({
      nextId: 5,
      events: [
        {
          id: 4,
          type: 'SCPT',
          parameters: [
            { kind: 0, value: 0x14 },
            { kind: 3, value: 7 },
            { kind: 1, value: 0x12eb7 },
            { kind: 9, value: 0 },
          ],
        },
      ],
    });
    const pairs = new EssWriter().u32(1);
    expect(readIngredientShared(ref(ref(pairs, 0x34cdd), 0x3ad56).done(), resolve)).toEqual([
      [0x34cdd, 0x3ad56],
    ]);
    expect(readMenuControls(new EssWriter().u8(0).u8(1).done())).toEqual({
      unknown0: 0,
      unknown1: 1,
    });
    expect(readMenuTopicManager(ref(ref(new EssWriter(), 1), 2).done(), resolve)).toEqual({
      unknown0: 1,
      unknown1: 2,
    });
    expect(readMain(new Uint8Array()).empty).toBe(true);
  });

  it('reads temp effects and stops at an undocumented type', () => {
    const w = new EssWriter().vsval(1).u8(1);
    ref(w, 0x14).u32(5);
    ref(ref(w, 0x15), 0x16);
    for (let i = 0; i < 6 + 3 + 4; i++) w.f32(i);
    w.u8(1).u8(2).u8(3).u8(4).f32(1).u8(5);
    for (let i = 0; i < 5; i++) w.f32(i);
    w.u8(6).u8(7).u32(8).u32(77);
    // list 1: a type 3, a type 8 with its four references, a type 9
    w.vsval(3).u32(3).f32(1).f32(2).u8(3).u32(4);
    w.u32(8).f32(1).f32(2).u8(3).u32(4).u8(5);
    ref(w, 0x14).u8(1);
    for (let i = 0; i < 4; i++) ref(w, 0x20 + i);
    w.u32(9).f32(1).f32(2).u8(3).u32(4).u8(5);
    ref(w, 0x14).u8(0);
    ref(w, 0x15).vsval(2).u8(0xcd).u8(0xef);
    // list 2: an undocumented type 2
    w.vsval(1).u32(2).u8(0x99);
    const effects = readTempEffects(w.done(), resolve);
    expect(effects.entries[0]).toMatchObject({
      flag: 1,
      reference0: 0x14,
      unknown0: 5,
      unknown1: 8,
    });
    expect(effects.unknown).toBe(77);
    expect(effects.effects1.map((effect) => effect.type)).toEqual([3, 8, 9]);
    const eight = effects.effects1[1];
    expect(eight?.type === 8 && eight.references).toEqual([0x20, 0x21, 0x22, 0x23]);
    const nine = effects.effects1[2];
    expect(nine?.type === 9 && nine.data).toEqual(new Uint8Array([0xcd, 0xef]));
    expect(effects.effects2).toEqual([]);
    expect(effects.unread).toEqual({ type: 2, bytes: new Uint8Array([0x99]) });
  });

  it('reads the three lists of temp effects to the end', () => {
    // As the saves read hold it: no entries, a u32, three empty lists, nothing after them.
    const reader = new EssReader(
      new EssWriter().vsval(0).u32(79).vsval(0).vsval(0).vsval(0).done(),
    );
    const effects = readTempEffects(reader, resolve);
    expect(effects.unknown).toBe(79);
    expect(effects.effects3).toEqual([]);
    expect(reader.remaining).toBe(0);
  });
});
