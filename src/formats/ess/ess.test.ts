import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  ChangeBase,
  ChangeCell,
  ChangeFaction,
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
  it('reads the original release layout: u16 strings and u32 handles', () => {
    const w = new EssWriter().u16(4).u16(2).wstring('A').wstring('');
    w.u32(1).u16(0).u16(1).u32(0); // a type with no members
    w.u32(1).u32(0x1000).u16(0).u16(0).u16(0x4d).refId(1, 0x14).u8(0);
    w.u32(0).u32(0).u32(1).u32(0); // no detached objects, arrays or stacks
    w.u32(0x1000).u8(0).u16(0).u32(0).u32(0); // the object's data
    w.u32(0).u32(0).u32(0).u32(0).u32(0).u32(0).u16(3); // messages, stacks, ..., version 3
    for (let i = 0; i < 3 + 2 + 1 + 4 + 2; i++) w.u32(0); // waits to sleep events
    w.u32(0).u32(0).u32(0).u32(0).u32(0).u32(0).u32(0); // no stats or filters before version 4: 06 to 0A
    const papyrus = readPapyrus(w.done(), false);
    expect(papyrus.objects[0]).toMatchObject({ handle: 0x1000, script: 'A' });
    expect(papyrus.unread).toBe(0);
  });

  it("reads types, objects, arrays, each object's variables, stacks and registrations", () => {
    const strings = ['MyQuestScript', 'Quest', 'count', 'Int', 'items', 'Form[]', 'OnUpdate', ''];
    const w = new EssWriter().u16(6).u32(strings.length);
    for (const s of strings) w.wstring(s);
    w.u32(1).u32(0).u32(1).u32(2).u32(2).u32(3).u32(4).u32(5); // the type and its members
    w.u32(1).u64(0x24100001000n).u32(0).u16(0).u16(0x4d).refId(1, 0x3372b).u8(0); // one object
    w.u32(0); // no detached objects
    w.u32(1).u64(0x2000n).u8(PapyrusType.Int).u32(2); // an int array of 2
    w.u32(7).u32(1).u32(5).u8(0); // next active script id, one stack
    w.u64(0x24100001000n)
      .u8(0)
      .u32(7)
      .u32(0)
      .u32(2)
      .u8(PapyrusType.Int)
      .i32(42)
      .u8(PapyrusType.IntArray)
      .u64(0x2000n);
    w.u64(0x2000n).u8(PapyrusType.Int).i32(1).u8(PapyrusType.Int).i32(2);
    // The stack: versions, its return value (None), flags 2, no callback, one frame.
    w.u32(5).u8(0).u8(1).u8(PapyrusType.Null).u32(0).u8(2).u8(0).u8(0).u32(1);
    w.u32(1).u8(0).u8(0).u32(0).u32(0).u32(6).u32(7).u8(3).u8(2); // the frame: names, state
    w.u32(7).u32(7).u32(0).u8(0).u16(0).u16(1).u32(2).u32(3); // the function: one local
    w.u16(2).u8(13).u8(1).u32(2).u8(3).i32(5); // assign count 5
    w.u8(26).u8(0); // return None
    w.u32(1).u8(PapyrusType.Object).u32(0).u64(0x24100001000n).u8(PapyrusType.Int).i32(5);
    w.u8(0); // the stack's trailing byte (flags bit 1)
    w.u32(0).u32(0).u32(0); // no function messages, no suspended stacks
    w.u32(0).u32(0).u32(0).u16(5); // unknowns, no queued unbinds, registration version 5
    w.u32(0).u32(0).u32(0); // no waits
    w.u32(1).u8(1).u32(1841).i32(30000).u16(0).u16(0xffff).refId(0, 0x147c); // one update
    w.u32(0).u32(1).u32(8).bytes([0x63, 0x77, 0x73, 0x63, 0x72, 0x69, 0x70, 0x74]); // a user log: cwscript
    w.u32(0).u32(0).u32(0).u32(0).u32(0); // functors, LOS events
    w.u32(0).u32(0).u32(0).u32(0); // sleep, stats, filters, unknown 06
    w.u32(1).refId(1, 0x14).u32(1).u32(5).bytes([66, 101, 103, 105, 110]).u32(0); // Begin
    w.u32(1).u16(0).u16(0xffff).refId(1, 0x14);
    w.u32(0).u32(0).u32(0).u32(0).u32(0); // unknown 08, 09 (three), 0A
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
      handle: 0x24100001000,
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
    const frame = papyrus.stackData[0]?.frames[0];
    expect(frame).toMatchObject({
      script: 'MyQuestScript',
      functionName: 'OnUpdate',
      state: '',
      instruction: 1,
      variables: [{ type: PapyrusType.Int, value: 5 }],
    });
    expect(frame?.function.code.map((code) => code.op)).toEqual(['assign', 'return']);
    expect(papyrus.stackData[0]?.tail).toBe(0);
    expect(papyrus.registrations.updates).toEqual([
      {
        single: true,
        time: 1841,
        interval: 30000,
        handle: { flags: 0, high: -1, refId: 0x147c },
      },
    ]);
    expect(papyrus.registrations.userLogs).toEqual(['cwscript']);
    expect(papyrus.registrations.animationEvents[0]?.events[0]).toMatchObject({ name: 'Begin' });
    expect(papyrus.unread).toBe(0);
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

  it('reads an interaction: its kind, the two references and a flag byte', () => {
    const data = new EssWriter().vsval(1).u8(0xa9).u32(0).refId(1, 0x14).refId(1, 0x15).u8(1);
    const form = readChangeForm(entry(0, ChangeRefr.ownershipExtra, data.done()), resolve);
    expect(form.extras).toEqual([{ type: 0xa9, name: 'Interaction', value: [0, 0x14, 0x15, 1] }]);
    expect(form.undecoded).toBe(0);
  });

  it('stops at a part whose layout is not known, and says so', () => {
    const data = new EssWriter().vsval(1).u8(0x1a).refId(2, 0x10).u32(0).done();
    const form = readChangeForm(entry(0, ChangeRefr.ownershipExtra, data), resolve);
    expect(form.stoppedAt).toBe('a trespass package the game made');
    expect(form.undecoded).toBe(4);
  });

  it('reads base objects, form lists, locations, quest nodes and scenes', () => {
    const base = (type: number, flags: number, w: EssWriter) =>
      readChangeForm(entry(type, flags, w.done()), resolve);
    expect(base(43, ChangeBase.last, new EssWriter().u32(1).refId(1, 0x99)).base).toEqual({
      formListAdded: [0x99],
    });
    const location = base(
      38,
      ChangeBase.last | ChangeBase.locationKeywordData,
      new EssWriter().u8(1).u8(0).vsval(1).refId(1, 0x5).f32(2),
    );
    expect(location.base).toEqual({
      location: { cleared: [1, 0], keywordData: [{ keyword: 5, value: 2 }] },
    });
    expect(base(36, 0, new EssWriter().u32(2).u32(7).u32(8)).base).toEqual({ questNode: [7, 8] });
    const scene = new EssWriter().u8(1).u32(5).u8(0).u8(0).u32(1).u32(2).u32(9).u8(1).u8(0);
    scene.u8(1).u8(0).u8(0).u8(0).u32(1234).u32(1).u8(1).u8(0).u8(0).u8(0).u8(0).u8(0).u8(0);
    const read = base(37, 0, scene);
    expect(read.undecoded).toBe(0);
    expect(read.base?.scene).toMatchObject({
      playing: true,
      actions: [{ type: 2, values: [9, 1, 0, 1, 0] }],
      time: 1234,
      phases: [[1, 0, 0]],
    });
    expect(
      base(13, ChangeBase.value | ChangeBase.bookRead, new EssWriter().u32(25).u8(4)).base,
    ).toEqual({ value: 25, bookFlags: 4 });
  });

  it("reads an interior cell's seen data when nothing says it is one", () => {
    const seen = new EssWriter().vsval(1).bytes(new Uint8Array(34)).refId(1, 0x7);
    const form = readChangeForm(
      entry(6, ChangeCell.seenData | ChangeCell.ownership, seen.done()),
      resolve,
    );
    expect(form).toMatchObject({ undecoded: 0, cell: { owner: 7 } });
    const exterior = readChangeForm(entry(6, ChangeCell.seenData, new Uint8Array(32)), resolve);
    expect(exterior.undecoded).toBe(0);
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

  /** An actor's data after its reference data, from its modifier sets to the end. */
  const actorTail = (w: EssWriter): EssWriter => {
    w.u32(3).f32(10).f32(0).f32(-25); // health: permanent, temporary, damage
    for (let i = 0; i < 3; i++) w.u32(3).f32(0).f32(0).f32(0);
    w.vsval(1).i32(7).f32(35); // a base value: Two-handed 35
    w.vsval(1).i32(40).f32(0).f32(5).f32(0); // a temporary modifier
    w.u32(1).refId(1, 0x12fcd); // an added spell
    w.u8(0).u32(0).u8(0).u32(0).u32(0).u32(0).refId(0, 0).u8(0);
    return w;
  };

  it('reads extra data by the layouts the original writes', () => {
    const data = new EssWriter()
      .vsval(5)
      .u8(0x5b) // faction changes: one faction at rank 2, no crime faction
      .vsval(1)
      .refId(1, 0x13794)
      .u8(2)
      .refId(0, 0)
      .u8(0)
      .u8(0x2b) // teleport: position, rotation, a flag, the door
      .f32(1)
      .f32(2)
      .f32(3)
      .f32(0)
      .f32(0)
      .f32(0)
      .u8(0)
      .refId(1, 0x1a26f)
      .u8(0x2a) // lock: level 50, flags, key, two words
      .u8(50)
      .u8(1)
      .refId(1, 0xf)
      .u32(0)
      .u32(0)
      .u8(0x0c) // a type the original writes without data
      .u8(0x99) // a name given at the enchanter
      .refId(0, 0)
      .refId(0, 0)
      .i32(-2)
      .wstring('Frostbite')
      .done();
    const form = readChangeForm(entry(0, ChangeRefr.ownershipExtra, data), resolve);
    expect(form.undecoded).toBe(0);
    expect(form.extras?.map((extra) => extra.name)).toEqual([
      'FactionChanges',
      'Teleport',
      'Lock',
      '0xc',
      'TextDisplayData',
    ]);
    expect(form.extras?.[0]?.factions).toEqual([{ faction: 0x13794, rank: 2 }]);
    expect(form.extras?.[1]?.value).toEqual([0x1a26f, 1, 2, 3, 0, 0, 0]);
    expect(form.extras?.[2]?.value).toEqual([50, 1, 0xf]);
    expect(form.extras?.[4]?.text).toBe('Frostbite');
  });

  it("reads an actor's values without an AI process", () => {
    const w = new EssWriter().u32(0xffffffff).u32(0); // no process, state flags
    w.u8(0).bytes(new Uint8Array(52)).refId(0, 0).bytes(new Uint8Array(18)).refId(0, 0);
    w.u8(1); // one magic caster
    w.u32(0).refId(0, 0).u32(0).u32(0).refId(0, 0).u32(0); // its common part
    w.u32(0).refId(0, 0).u32(0).vsval(2).u16(0); // its own, with 2 bytes of animation state
    for (let i = 0; i < 5; i++) w.refId(0, 0);
    const form = readChangeForm(entry(1, 0, actorTail(w).done(), (1 << 22) | 0x1a67c), resolve);
    expect(form.stoppedAt).toBeUndefined();
    expect(form.actor?.processLevel).toBe(-1);
    expect(form.actor?.values?.modifiers[0]).toEqual({
      av: 24,
      permanent: 10,
      temporary: 0,
      damage: -25,
    });
    expect(form.actor?.values?.base).toEqual([{ av: 7, value: 35 }]);
    expect(form.actor?.values?.others).toEqual([{ av: 40, permanent: 0, temporary: 5, damage: 0 }]);
    expect(form.actor?.addedSpells).toEqual([0x12fcd]);
  });

  it("finds an actor's values after AI process data", () => {
    const w = new EssWriter().u32(0).u32(0); // high process
    w.bytes([7, 3, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]); // process data (not decoded)
    const form = readChangeForm(entry(1, 0, actorTail(w).done(), (1 << 22) | 0x1a67c), resolve);
    expect(form.stoppedAt).toBeUndefined();
    expect(form.actor?.values?.base).toEqual([{ av: 7, value: 35 }]);
  });

  it("reads a faction's reactions and crime, a leveled list's added entries and NPC attributes", () => {
    const faction = new EssWriter()
      .vsval(1)
      .refId(1, 0x13794)
      .i32(-50)
      .u32(1) // reactions
      .u32(0x10) // flags
      .u32(2)
      .u32(1)
      .f32(0.5)
      .u32(0) // crime
      .done();
    const flags = ChangeFaction.reactions | ChangeFaction.flags | ChangeFaction.crimeCounts;
    expect(readChangeForm(entry(31, flags, faction), resolve)).toMatchObject({
      faction: { flags: 0x10, reactions: [{ faction: 0x13794, modifier: -50, reaction: 1 }] },
      undecoded: 0,
    });
    const list = new EssWriter().u8(1).refId(1, 0xf).u16(5).u16(100).done();
    expect(readChangeForm(entry(45, 0x80000000, list), resolve)).toMatchObject({
      leveledAdded: [{ form: 0xf, level: 5, count: 100 }],
      undecoded: 0,
    });
    const npc = new EssWriter().wstring('Lydia').done();
    const form = readChangeForm(entry(9, ChangeNpc.attributes | ChangeNpc.fullName, npc), resolve);
    expect(form).toMatchObject({ npc: { fullName: 'Lydia' }, undecoded: 0 });
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
