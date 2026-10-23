import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import type { Field } from '../formats/esm/record.ts';
import {
  parseArmorAddon,
  parseLeveledList,
  parseNpc,
  parseOutfit,
  parseRace,
  type ArmorAddonRecord,
} from './actor-records.ts';
import {
  addonModel,
  addonsForRace,
  firstSlot,
  inFirstPerson,
  partitionVisible,
  pickLeveled,
  seededRandom,
  slotOwners,
  underSkin,
  withOverrides,
  type WornAddon,
} from './actors.ts';
import type { GameRecord } from './record-db.ts';

type Source = Pick<GameRecord, 'formId' | 'type' | 'editorId' | 'fields' | 'formIdAt'>;

/** Little-endian bytes from u8 / u16 / u32 / f32 values. */
function bytes(...parts: (['u8' | 'u16' | 'u32' | 'f32', number] | string)[]): Uint8Array {
  const out: number[] = [];
  const view = new DataView(new ArrayBuffer(4));
  for (const part of parts) {
    if (typeof part === 'string') {
      for (const char of part) out.push(char.charCodeAt(0));
      out.push(0);
      continue;
    }
    const [kind, value] = part;
    if (kind === 'u8') out.push(value);
    else if (kind === 'u16') out.push(value & 0xff, (value >> 8) & 0xff);
    else {
      if (kind === 'u32') view.setUint32(0, value, true);
      else view.setFloat32(0, value, true);
      out.push(...new Uint8Array(view.buffer));
    }
  }
  return Uint8Array.from(out);
}

function record(type: string, formId: number, fields: [string, Uint8Array][]): Source {
  const list: Field[] = fields.map(([fieldType, data]) => ({ type: fieldType, data }));
  return {
    formId,
    type,
    editorId: undefined,
    fields: new Fields(list),
    formIdAt: (data, offset) =>
      new DataView(data.buffer, data.byteOffset).getUint32(offset ?? 0, true),
  };
}

const empty = new Uint8Array(0);

describe('actor records', () => {
  it('reads an actor base: flags, template, race, outfit, head parts, colours, size', () => {
    const npc = parseNpc(
      record('NPC_', 0x100, [
        [
          'ACBS',
          bytes(
            ['u32', 0x21],
            ['u16', 0],
            ['u16', 0],
            ['u16', 9],
            ['u16', 1],
            ['u16', 0],
            ['u16', 100],
            ['u16', 35],
            ['u16', 0x101],
            ['u16', 0],
            ['u16', 0],
          ),
        ],
        ['TPLT', bytes(['u32', 0x200])],
        ['RNAM', bytes(['u32', 0x13746])],
        ['PNAM', bytes(['u32', 0x51416])],
        ['PNAM', bytes(['u32', 0xd2ebe])],
        ['HCLF', bytes(['u32', 0xa0431])],
        ['NAM6', bytes(['f32', 1.02])],
        ['NAM7', bytes(['f32', 30])],
        ['DOFT', bytes(['u32', 0xff7e9])],
        ['QNAM', bytes(['f32', 0.5], ['f32', 0.25], ['f32', 1])],
        ['CNTO', bytes(['u32', 0x13983], ['u32', 2])],
      ]),
    );
    expect(npc.flags).toBe(0x21);
    expect(npc.templateFlags).toBe(0x101);
    expect(npc.level).toBe(9);
    expect([npc.template, npc.race, npc.outfit, npc.hairColor]).toEqual([
      0x200, 0x13746, 0xff7e9, 0xa0431,
    ]);
    expect(npc.headParts).toEqual([0x51416, 0xd2ebe]);
    expect(npc.height).toBeCloseTo(1.02);
    expect(npc.weight).toBe(30);
    expect(npc.skinTone).toEqual([0.5, 0.25, 1]);
    expect(npc.items).toEqual([{ item: 0x13983, count: 2 }]);
  });

  it('reads a race: sizes, skeletons and behavior projects by sex, head parts, armor race', () => {
    const data = new Uint8Array(164);
    const dataView = new DataView(data.buffer);
    dataView.setFloat32(16, 1.03, true);
    dataView.setFloat32(20, 1.0, true);
    dataView.setUint32(32, 0x3, true);
    const race = parseRace(
      record('RACE', 0x13746, [
        ['WNAM', bytes(['u32', 0xd64])],
        ['DATA', data],
        ['MNAM', empty],
        ['ANAM', bytes('Actors\\Character\\Character Assets\\skeleton.nif')],
        ['FNAM', empty],
        ['ANAM', bytes('Actors\\Character\\Character Assets Female\\skeleton_female.nif')],
        ['HCLF', bytes(['u32', 0xa042e], ['u32', 0xa042f])],
        ['NAM1', empty],
        ['MNAM', empty],
        ['MODL', bytes('Actors\\Character\\UpperBodyHumanMale.egt')],
        ['NAM3', empty],
        ['MNAM', empty],
        ['MODL', bytes('Actors\\Character\\DefaultMale.hkx')],
        ['FNAM', empty],
        ['MODL', bytes('Actors\\Character\\DefaultFemale.hkx')],
        ['NAM0', empty],
        ['MNAM', empty],
        ['INDX', bytes(['u32', 0])],
        ['HEAD', bytes(['u32', 0x5140e])],
        ['DFTM', bytes(['u32', 0x3b521])],
        ['NAM0', empty],
        ['FNAM', empty],
        ['HEAD', bytes(['u32', 0x51176])],
        ['RNAM', bytes(['u32', 0x13740])],
      ]),
    );
    expect(race.skin).toBe(0xd64);
    expect(race.flags).toBe(0x3);
    expect(race.height[0]).toBeCloseTo(1.03);
    expect(race.skeleton).toEqual([
      'Actors\\Character\\Character Assets\\skeleton.nif',
      'Actors\\Character\\Character Assets Female\\skeleton_female.nif',
    ]);
    expect(race.behavior).toEqual([
      'Actors\\Character\\DefaultMale.hkx',
      'Actors\\Character\\DefaultFemale.hkx',
    ]);
    expect(race.hairColor).toEqual([0xa042e, 0xa042f]);
    expect(race.headParts).toEqual([[0x5140e], [0x51176]]);
    expect(race.faceTexture[0]).toBe(0x3b521);
    expect(race.armorRace).toBe(0x13740);
  });

  it('reads an armor addon: slots, races, priorities, weight slider, models, texture swaps', () => {
    const swaps = bytes(['u32', 1], ['u32', 5], 'Body', ['u32', 0x3ede8], ['u32', 2]);
    const addon = parseArmorAddon(
      record('ARMA', 0xd67, [
        ['BODT', bytes(['u32', 0x174], ['u32', 0], ['u32', 2])],
        ['RNAM', bytes(['u32', 0x19])],
        [
          'DNAM',
          bytes(
            ['u8', 3],
            ['u8', 4],
            ['u8', 2],
            ['u8', 0],
            ['u8', 0],
            ['u8', 0],
            ['u8', 0],
            ['u8', 0],
            ['f32', 0],
          ),
        ],
        ['MOD2', bytes('Actors\\Character\\Character Assets\\MaleBody_1.NIF')],
        ['MO2S', swaps],
        ['NAM0', bytes(['u32', 0x3ede8])],
        ['MODL', bytes(['u32', 0x13746])],
        ['MODL', bytes(['u32', 0x13741])],
      ]),
    );
    expect(addon.slots).toBe(0x174);
    expect([addon.race, addon.races]).toEqual([0x19, [0x13746, 0x13741]]);
    expect(addon.priority).toEqual([3, 4]);
    expect(addon.weighted).toEqual([true, false]);
    expect(addon.models[0]?.path).toBe('Actors\\Character\\Character Assets\\MaleBody_1.NIF');
    // The record's models as they are (addonModel chooses).
    expect(addon.models[1]).toBeUndefined();
    expect(addon.firstPerson).toEqual([undefined, undefined]);
    expect(addon.models[0]?.alternateTextures).toEqual([
      { shape: 'Body', textureSet: 0x3ede8, index: 2 },
    ]);
    expect(addon.skinTexture).toEqual([0x3ede8, undefined]);
  });

  it('reads outfits and leveled lists', () => {
    expect(
      parseOutfit(record('OTFT', 1, [['INAM', bytes(['u32', 0x13951], ['u32', 0x13952])]])),
    ).toEqual([0x13951, 0x13952]);
    const list = parseLeveledList(
      record('LVLN', 2, [
        ['LVLD', bytes(['u8', 25])],
        ['LVLF', bytes(['u8', 1])],
        ['LVLO', bytes(['u16', 1], ['u16', 0], ['u32', 0x300], ['u16', 1], ['u16', 0])],
        ['LVLO', bytes(['u16', 6], ['u16', 0], ['u32', 0x301], ['u16', 1], ['u16', 0])],
      ]),
    );
    expect([list.chanceNone, list.flags]).toEqual([25, 1]);
    expect(list.entries).toEqual([
      { level: 1, formId: 0x300, count: 1 },
      { level: 6, formId: 0x301, count: 1 },
    ]);
  });
});

describe('actor looks', () => {
  const list = {
    formId: 1,
    editorId: '',
    chanceNone: 0,
    chanceGlobal: undefined,
    flags: 0,
    entries: [
      { level: 1, formId: 0xa, count: 1 },
      { level: 5, formId: 0xb, count: 1 },
      { level: 5, formId: 0xc, count: 1 },
      { level: 20, formId: 0xd, count: 1 },
    ],
  };

  it('picks leveled entries of the highest eligible level, or of all with the flag', () => {
    const random = seededRandom(7);
    const picks = new Set(Array.from({ length: 50 }, () => pickLeveled(list, 10, random)));
    expect([...picks].sort()).toEqual([0xb, 0xc]);
    const all = new Set(
      Array.from({ length: 80 }, () => pickLeveled({ ...list, flags: 1 }, 10, random)),
    );
    expect([...all].sort()).toEqual([0xa, 0xb, 0xc]);
    expect(pickLeveled(list, 0, random)).toBeUndefined();
    expect(pickLeveled({ ...list, chanceNone: 100 }, 10, random)).toBeUndefined();
    // The same seed draws the same.
    expect(pickLeveled(list, 30, seededRandom(3))).toBe(pickLeveled(list, 30, seededRandom(3)));
  });

  const addon = (formId: number, race: number, races: number[]): ArmorAddonRecord => ({
    formId,
    editorId: '',
    slots: 0x4,
    race,
    races,
    priority: [0, 0],
    weighted: [false, false],
    models: [undefined, undefined],
    firstPerson: [undefined, undefined],
    skinTexture: [undefined, undefined],
    weaponAdjust: 0,
    footstepSet: undefined,
  });

  it("chooses the addons that fit the race, else the race's armor race", () => {
    const addons = [addon(1, 0x19, [0x13746]), addon(2, 0x13743, [])];
    expect(addonsForRace(addons, 0x13746, undefined).map((a) => a.formId)).toEqual([1]);
    expect(addonsForRace(addons, 0x13743, undefined).map((a) => a.formId)).toEqual([2]);
    expect(addonsForRace(addons, 0x88794, 0x13746).map((a) => a.formId)).toEqual([1]);
    expect(addonsForRace(addons, 0x88794, undefined)).toEqual([]);
  });

  const worn = (id: number, slots: number, priority = 0, skin = false): WornAddon => ({
    addon: id,
    armor: id,
    editorId: '',
    model: { path: '', alternateTextures: [] },
    firstPerson: { model: { path: '', alternateTextures: [] }, skinTexture: undefined },
    weighted: false,
    slots,
    priority,
    skinTexture: undefined,
    skin,
    weaponAdjust: 0,
    footstepSet: undefined,
  });

  it('gives each slot to one armor piece and hides the partitions others own', () => {
    // A cuirass on body, forearms and calves; gauntlets on hands and forearms; boots on calves.
    const owners = slotOwners([
      worn(1, 0x4 | 0x10 | 0x100),
      worn(2, 0x8 | 0x10),
      worn(3, 0x80 | 0x100),
      worn(9, 0xffff, 0, true),
    ]);
    expect(Object.fromEntries(owners)).toEqual({ 32: 1, 33: 2, 34: 2, 37: 3, 38: 3 });
    // The cuirass's forearm partition is hidden, its body shows; a helmet on the hair slot
    // hides the head's hair partitions (131, 141 when it owns long hair too).
    expect(partitionVisible(32, owners, 1)).toBe(true);
    expect(partitionVisible(34, owners, 1)).toBe(false);
    const helmet = slotOwners([worn(4, 0x2 | 0x1000)]);
    expect(partitionVisible(131, helmet, undefined)).toBe(false);
    expect(partitionVisible(130, helmet, undefined)).toBe(true);
    expect(partitionVisible(230, slotOwners([worn(5, 0x1)]), undefined)).toBe(false);
    expect(firstSlot(0x174)).toBe(32);
  });

  it('chooses the model an addon is worn in: first person falls back to the world model', () => {
    const model = (path: string) => ({ path, alternateTextures: [] });
    const hands: ArmorAddonRecord = {
      ...addon(1, 0x19, []),
      models: [model('MaleHands_1.nif'), model('FemaleHands_1.nif')],
      firstPerson: [model('1stPersonMaleHands_1.nif'), undefined],
      skinTexture: [0x10, 0x11],
    };
    expect(addonModel(hands, false, true)).toEqual({
      model: model('1stPersonMaleHands_1.nif'),
      skinTexture: 0x10,
    });
    // A woman without her own first-person model wears the man's, in his skin texture set.
    expect(addonModel(hands, true, true)).toEqual({
      model: model('1stPersonMaleHands_1.nif'),
      skinTexture: 0x10,
    });
    expect(addonModel(hands, true, false)).toEqual({
      model: model('FemaleHands_1.nif'),
      skinTexture: 0x11,
    });
    // Gauntlets without first-person models show their world models in first person.
    const gauntlets: ArmorAddonRecord = {
      ...addon(2, 0x19, []),
      models: [model('Gauntlets_1.nif'), model('F\\Gauntlets_1.nif')],
    };
    expect(addonModel(gauntlets, true, true)?.model).toEqual(model('F\\Gauntlets_1.nif'));
    expect(addonModel(addon(3, 0x19, []), false, true)).toBeUndefined();
  });

  it('gives a piece without a skin texture set the one the skin left in its slot', () => {
    const skinned = (id: number, slots: number, texture: number): WornAddon => ({
      ...worn(id, slots, 0, true),
      skinTexture: texture,
      firstPerson: { model: { path: '', alternateTextures: [] }, skinTexture: texture },
    });
    const skin = [skinned(10, 0x8, 0x33), skinned(11, 0x4 | 0x10, 0x32)];
    const cuirass = underSkin(worn(1, 0x4 | 0x10 | 0x100), skin);
    expect([cuirass.skinTexture, cuirass.firstPerson.skinTexture]).toEqual([0x32, 0x32]);
    expect(underSkin(worn(2, 0x8 | 0x10), skin).skinTexture).toBe(0x33);
    // Its own wins; a slot no skin covers leaves it as it is.
    expect(underSkin({ ...worn(3, 0x8), skinTexture: 0x99 }, skin).skinTexture).toBe(0x99);
    expect(underSkin(worn(4, 0x80), skin).skinTexture).toBeUndefined();
  });

  it("shows in first person the pieces owning one of the race's first-person slots", () => {
    // NordRace BOD2: body, hands, forearms, ring, shield, FX01.
    const firstPersonSlots = 0x8000025c;
    const cuirass = worn(1, 0x4 | 0x10 | 0x100, 5);
    const gauntlets = worn(2, 0x8 | 0x10, 10);
    const boots = worn(3, 0x80 | 0x100);
    const helmet = worn(4, 0x2 | 0x2000);
    const owners = slotOwners([cuirass, gauntlets, boots, helmet]);
    const look = { owners, firstPersonSlots };
    expect([cuirass, gauntlets, boots, helmet].map((piece) => inFirstPerson(piece, look))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    // The skin's hands where nothing covers them; not its feet.
    expect(inFirstPerson(worn(9, 0x8, 0, true), { owners: new Map(), firstPersonSlots })).toBe(
      true,
    );
    expect(inFirstPerson(worn(9, 0x80, 0, true), { owners: new Map(), firstPersonSlots })).toBe(
      false,
    );
  });

  it("puts a made look's traits over the record's (the player's appearance)", () => {
    const player = parseNpc(
      record('NPC_', 7, [
        ['ACBS', bytes(['u32', 0])],
        ['RNAM', bytes(['u32', 0x13746])],
        ['PNAM', bytes(['u32', 0x100])],
        ['HCLF', bytes(['u32', 0x200])],
      ]),
    );
    const made = withOverrides(player, {
      race: 0x13740,
      female: true,
      weight: 30,
      headParts: [],
      skinTone: [0.5, 0.4, 0.3],
    });
    expect(made.race).toBe(0x13740);
    expect(made.flags & 0x1).toBe(1);
    expect(made.weight).toBe(30);
    // No head parts of its own (a race's default look): the race's fill every type.
    expect(made.headParts).toEqual([]);
    // What the look leaves out stays the record's.
    expect(made.hairColor).toBe(0x200);
    expect(made.skinTone).toEqual([0.5, 0.4, 0.3]);
    expect(withOverrides(made, { female: false }).flags & 0x1).toBe(0);
  });
});
