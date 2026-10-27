import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  ChangeQuest,
  ChangeRefr,
  ChangeNpc,
  CHANGE_FORM_FLAGS,
  readChangeForm,
} from './change-forms.ts';
import { readEss, readEssHeader } from './ess.ts';
import { EssReader, RefIdKind, resolveRefId } from './ess-reader.ts';
import { EssWriter, writeSyntheticEss } from './ess-test-writer.ts';
import {
  readAnimObjects,
  readAudio,
  readCreatedObjects,
  readEffects,
  readGlobalVariables,
  readMiscStats,
  readPlayerLocation,
  readSkyCells,
  readSynchronizedAnimations,
  readTes,
  readTimer,
  readWeather,
  refIdResolver,
} from './global-data.ts';
import { PapyrusType, readPapyrus } from './papyrus.ts';

const fail = (): never => {
  throw new Error('missing');
};
const resolve = refIdResolver([0x01000d62, 0x0001a26f]);

describe('ess reader', () => {
  it('reads variable-size values of each size and reference ids of each kind', () => {
    const bytes = new EssWriter()
      .vsval(5)
      .vsval(300)
      .vsval(70000)
      .refId(0, 2)
      .refId(1, 0x14)
      .refId(2, 0x800)
      .done();
    const reader = new EssReader(bytes);
    expect([reader.vsval(), reader.vsval(), reader.vsval()]).toEqual([5, 300, 70000]);
    const formIds = [0x01000d62, 0x0001a26f];
    expect(resolveRefId(reader.refId(), formIds)).toBe(0x0001a26f);
    expect(resolveRefId(reader.refId(), formIds)).toBe(0x14);
    expect(resolveRefId(reader.refId(), formIds)).toBe(0xff000800);
    expect(resolveRefId((RefIdKind.Indexed << 22) | 0, formIds)).toBe(0);
  });
});

describe('ess frame', () => {
  const quest = new EssWriter().u32(5).u16(0).u16(0x801).done(); // form flags, then quest flags
  const file = writeSyntheticEss({
    playerName: 'Lydia',
    playerLevel: 12,
    location: 'Whiterun',
    plugins: ['Skyrim.esm', 'Update.esm'],
    lightPlugins: ['ccBGSSSE001-Fish.esm'],
    globalData1: [
      { type: 0, data: new EssWriter().u32(1).wstring('Locations Discovered').u8(0).i32(7).done() },
      { type: 3, data: new EssWriter().vsval(1).refId(1, 0x38).f32(13.5).done() },
    ],
    globalData3: [
      { type: 1002, data: new EssWriter().u32(0).done() },
      { type: 1003, data: new EssWriter().u32(1).u32(2).done() },
    ],
    changeForms: [
      { refId: [1, 0x3372b], flags: CHANGE_FORM_FLAGS | ChangeQuest.flags, type: 8, data: quest },
      {
        refId: [0, 1],
        flags: CHANGE_FORM_FLAGS,
        type: 0,
        data: new Uint8Array(),
        compressed: { bytes: deflateSync(new EssWriter().u32(0x800).u16(0).done()), length: 6 },
      },
    ],
    formIds: [0x01000d62],
    shortTable3Count: true,
  });

  it('reads the header alone', () => {
    const { header } = readEssHeader(file);
    expect(header).toMatchObject({
      version: 12,
      playerName: 'Lydia',
      playerLevel: 12,
      location: 'Whiterun',
      compression: 2,
    });
  });

  it('unpacks the LZ4 body: plugins, tables (table 3 one past its count), change forms, form ids', () => {
    const ess = readEss(file);
    expect(ess.screenshot).toHaveLength(8);
    expect(ess.formVersion).toBe(78);
    expect(ess.plugins).toEqual(['Skyrim.esm', 'Update.esm']);
    expect(ess.lightPlugins).toEqual(['ccBGSSSE001-Fish.esm']);
    expect(ess.globalData1.map((entry) => entry.type)).toEqual([0, 3]);
    expect(ess.globalData3.map((entry) => entry.type)).toEqual([1002, 1003]);
    expect(ess.changeForms).toHaveLength(2);
    expect(ess.changeForms[0]?.formId).toBe(0x3372b);
    expect(ess.changeForms[1]?.formId).toBe(0x01000d62);
    expect([...ess.formIds]).toEqual([0x01000d62]);
    const reference = readChangeForm(ess.changeForms[1] ?? fail(), refIdResolver(ess.formIds));
    expect(reference.formFlags).toBe(0x800);
    expect(
      readChangeForm(ess.changeForms[0] ?? fail(), refIdResolver(ess.formIds)).quest?.flags,
    ).toBe(0x801);
  });

  it('refuses what is not a save', () => {
    expect(() => readEss(new Uint8Array(40))).toThrow(/Not a Skyrim save/);
  });
});

describe('global data', () => {
  it('reads table 1', () => {
    expect(
      readMiscStats(new EssWriter().u32(1).wstring('Days Passed').u8(0).i32(3).done()),
    ).toEqual([{ name: 'Days Passed', category: 0, value: 3 }]);
    const location = readPlayerLocation(
      new EssWriter()
        .u32(9)
        .refId(1, 0x3c)
        .i32(-1)
        .i32(2)
        .refId(1, 0x3c)
        .f32(1)
        .f32(2)
        .f32(3)
        .u8(0)
        .done(),
      resolve,
    );
    expect(location).toEqual({
      nextObjectId: 9,
      worldspace1: 0x3c,
      coordX: -1,
      coordY: 2,
      worldspace2: 0x3c,
      position: [1, 2, 3],
    });
    expect(
      readTes(
        new EssWriter().vsval(1).refId(1, 5).u16(7).u32(1).refId(1, 6).vsval(1).refId(1, 8).done(),
        resolve,
      ),
    ).toEqual({
      unknown0: [{ formId: 5, unknown: 7 }],
      unknown1: [6],
      unknown2: [8],
    });
    expect(
      readGlobalVariables(new EssWriter().vsval(1).refId(1, 0x39).f32(2.5).done(), resolve),
    ).toEqual(new Map([[0x39, 2.5]]));
    const enchantment = new EssWriter()
      .vsval(1)
      .refId(2, 1)
      .u32(3)
      .vsval(1)
      .refId(1, 0x10)
      .f32(5)
      .u32(60)
      .u32(0)
      .f32(100);
    const created = readCreatedObjects(enchantment.vsval(0).vsval(0).vsval(0).done(), resolve);
    expect(created.weaponEnchantments[0]).toEqual({
      formId: 0xff000001,
      timesUsed: 3,
      effects: [{ effect: 0x10, magnitude: 5, duration: 60, area: 0, price: 100 }],
    });
    expect(
      readEffects(
        new EssWriter().vsval(1).f32(1).f32(2).u32(3).refId(1, 4).f32(5).f32(6).done(),
        resolve,
      ),
    ).toEqual({
      effects: [{ strength: 1, timestamp: 2, unknown: 3, effect: 4 }],
      unknown1: 5,
      unknown2: 6,
    });
    const weatherBytes = new EssWriter()
      .refId(1, 1)
      .refId(1, 0x12f89)
      .refId(1, 3)
      .refId(1, 0)
      .refId(1, 0)
      .refId(1, 0)
      .f32(8)
      .f32(7.5)
      .f32(1)
      .u32(0)
      .done();
    expect(readWeather(weatherBytes, resolve)).toMatchObject({
      climate: 1,
      weather: 0x12f89,
      previousWeather: 3,
      currentTime: 8,
      weatherPercent: 1,
    });
    expect(
      readAudio(new EssWriter().refId(1, 1).vsval(1).refId(1, 2).refId(1, 3).done(), resolve),
    ).toEqual({ unknown: 1, tracks: [2], music: 3 });
    expect(readSkyCells(new EssWriter().vsval(1).refId(1, 1).refId(1, 2).done(), resolve)).toEqual([
      { first: 1, second: 2 },
    ]);
  });

  it('reads table 3', () => {
    expect(
      readAnimObjects(new EssWriter().u32(1).refId(1, 0x14).refId(1, 0x99).u8(1).done(), resolve),
    ).toEqual([{ reference: 0x14, animObject: 0x99, unknown: 1 }]);
    expect(readTimer(new EssWriter().u32(1).u32(2).done())).toEqual({ unknown1: 1, unknown2: 2 });
    expect(
      readSynchronizedAnimations(
        new EssWriter().u32(1).u32(1).u32(2).u32(1).refId(1, 0x14).wstring('a').done(),
        resolve,
      ),
    ).toEqual([{ unknown1: 1, unknown2: 2, actors: [{ reference: 0x14, name: 'a' }] }]);
  });
});

describe('papyrus', () => {
  it("reads types, objects, arrays and each object's variables", () => {
    const strings = ['MyQuestScript', 'Quest', 'count', 'Int', 'items', 'Form[]'];
    const w = new EssWriter().u16(4).u16(strings.length);
    for (const s of strings) w.wstring(s);
    w.u32(1).u16(0).u16(1).u32(2).u16(2).u16(3).u16(4).u16(5); // the type and its members
    w.u32(1).u32(0x1000).u16(0).u16(0).u16(0x4d).refId(1, 0x3372b).u8(0); // one object
    w.u32(0); // no detached objects
    w.u32(1).u32(0x2000).u8(PapyrusType.Int).u32(2); // an int array of 2
    w.u32(7).u32(0); // next active script id, no stacks
    w.u32(0x1000)
      .u8(0)
      .u16(0)
      .u32(0)
      .u32(2)
      .u8(PapyrusType.Int)
      .i32(42)
      .u8(PapyrusType.IntArray)
      .u32(0x2000);
    w.u32(0x2000).u8(PapyrusType.Int).i32(1).u8(PapyrusType.Int).i32(2);
    w.u32(0); // the rest (function messages, ...) is not read yet
    const papyrus = readPapyrus(w.done());
    expect(papyrus.types[0]).toEqual({
      name: 'MyQuestScript',
      parent: 'Quest',
      members: [
        { name: 'count', type: 'Int' },
        { name: 'items', type: 'Form[]' },
      ],
    });
    expect(papyrus.objects[0]).toMatchObject({
      handle: 0x1000,
      script: 'MyQuestScript',
      high: 0x4d,
    });
    expect(papyrus.objectData[0]?.variables).toEqual([
      { type: PapyrusType.Int, value: 42 },
      { type: PapyrusType.IntArray, array: 0x2000 },
    ]);
    expect(papyrus.arrayData.get(0x2000)).toEqual([
      { type: PapyrusType.Int, value: 1 },
      { type: PapyrusType.Int, value: 2 },
    ]);
    expect(papyrus.unread).toBe(4);
  });
});

describe('change forms', () => {
  const entry = (type: number, flags: number, data: Uint8Array, refId = (1 << 22) | 0x14) => ({
    refId,
    formId: refId & 0x3fffff,
    changeFlags: flags,
    type,
    version: 0,
    stored: data,
    uncompressedLength: 0,
  });

  it('reads a moved, disabled reference with a count and its inventory', () => {
    const data = new EssWriter()
      .refId(1, 0x1a26f)
      .f32(10)
      .f32(20)
      .f32(30)
      .f32(0)
      .f32(0)
      .f32(1.5) // moved: cell, position, rotation
      .u32(0x800)
      .u16(0) // form flags: disabled
      .f32(2) // scale
      .vsval(1)
      .u8(0x21)
      .refId(1, 0x7) // extras: ownership
      .vsval(1)
      .refId(1, 0xf)
      .i32(100)
      .vsval(1)
      .vsval(1)
      .u8(0x24)
      .u16(100) // inventory: gold +100
      .done();
    const flags =
      CHANGE_FORM_FLAGS |
      ChangeRefr.moved |
      ChangeRefr.scale |
      ChangeRefr.ownershipExtra |
      ChangeRefr.inventory;
    const form = readChangeForm(entry(0, flags, data), resolve);
    expect(form.initial).toEqual({
      kind: 'moved',
      cell: 0x1a26f,
      position: [10, 20, 30],
      rotation: [0, 0, 1.5],
    });
    expect(form).toMatchObject({ formFlags: 0x800, scale: 2, undecoded: 0 });
    expect(form.extras).toEqual([{ type: 0x21, name: 'Ownership', value: 7 }]);
    expect(form.inventory).toEqual([
      { item: 0xf, delta: 100, extras: [[{ type: 0x24, name: 'Count', value: 100 }]] },
    ]);
  });

  it('stops at an extra whose layout is not known, and says so', () => {
    const data = new EssWriter().vsval(1).u8(0x99).u32(0).done();
    const form = readChangeForm(entry(0, ChangeRefr.ownershipExtra, data), resolve);
    expect(form.stoppedAt).toBe('extra data type 0x99');
    expect(form.undecoded).toBe(4);
  });

  it("reads a quest's stages, objectives and alias references", () => {
    const data = new EssWriter()
      .vsval(2)
      .u16(10)
      .u8(1)
      .u16(20)
      .u8(0) // stages
      .vsval(1)
      .u32(0)
      .u32(1) // objective 0 displayed
      .u8(0)
      .u32(1)
      .u32(3)
      .u8(0)
      .refId(1, 0x14)
      .u32(0)
      .u8(0) // runtime data: alias 3 = the player
      .u8(1) // already run
      .done();
    const flags =
      ChangeQuest.stages |
      ChangeQuest.objectives |
      ChangeQuest.runtimeData |
      ChangeQuest.alreadyRun;
    const form = readChangeForm(entry(8, flags, data, (1 << 22) | 0x3372b), resolve);
    expect(form.quest).toEqual({
      stages: [
        { stage: 10, done: true },
        { stage: 20, done: false },
      ],
      objectives: [{ index: 0, status: 1 }],
      aliases: [{ id: 3, reference: 0x14 }],
      alreadyRun: true,
    });
    expect(form.undecoded).toBe(0);
  });

  it("reads the player base's skills, race, name and sex", () => {
    const data = new EssWriter()
      .wstring('Dovahkiin')
      .bytes(new Uint8Array(52).fill(15))
      .refId(1, 0x13746)
      .refId(1, 0x13746)
      .u8(1)
      .done();
    const flags = ChangeNpc.fullName | ChangeNpc.skills | ChangeNpc.race | ChangeNpc.gender;
    const form = readChangeForm(entry(9, flags, data, (1 << 22) | 7), resolve);
    expect(form.npc).toMatchObject({
      fullName: 'Dovahkiin',
      race: { current: 0x13746, original: 0x13746 },
      female: true,
    });
    expect(form.npc?.skills?.[0]).toBe(15);
    expect(form.undecoded).toBe(0);
  });
});
