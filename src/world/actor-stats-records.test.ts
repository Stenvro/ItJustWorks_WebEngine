import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  parseClass,
  parseFaction,
  parseLocation,
  parseNpcStats,
  parseRaceStats,
  parseRelationship,
} from './actor-stats-records.ts';

const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const record = (type: string, fields: [string, Uint8Array][], formId = 0x100) => ({
  formId,
  type,
  editorId: 'Test',
  fields: new Fields(fields.map(([field, data]) => ({ type: field, data }))),
  formIdAt: (data: Uint8Array, offset = 0) =>
    new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
});

describe('actor stats', () => {
  it('read an NPC: base stats, skills, calculated attributes, AI data, spells and perks', () => {
    const acbs = new DataView(new ArrayBuffer(24));
    acbs.setUint32(0, 0x2 | 0x80, true); // essential, PC level mult
    acbs.setInt16(4, 10, true); // magicka offset
    acbs.setInt16(6, -5, true); // stamina offset
    acbs.setUint16(8, 1500, true); // level × 1000
    acbs.setUint16(10, 6, true);
    acbs.setUint16(12, 30, true);
    acbs.setUint16(14, 100, true);
    acbs.setUint16(18, 0x2, true); // use stats
    acbs.setInt16(20, 25, true); // health offset
    const dnam = new Uint8Array(52);
    dnam[0] = 40; // one-handed
    dnam[18] = 5; // its offset
    new DataView(dnam.buffer).setUint16(36, 250, true);
    new DataView(dnam.buffer).setUint16(38, 80, true);
    new DataView(dnam.buffer).setUint16(40, 120, true);
    const aidt = new Uint8Array(20);
    aidt.set([1, 3, 50, 0, 3, 2, 1]);
    new DataView(aidt.buffer).setUint32(8, 500, true);
    const npc = parseNpcStats(
      record('NPC_', [
        ['ACBS', new Uint8Array(acbs.buffer)],
        ['SNAM', Uint8Array.from([0x10, 0, 0, 0, 2, 0, 0, 0])],
        ['SPLO', u32s(0x200)],
        ['PRKR', Uint8Array.from([0x30, 0, 0, 0, 1, 0, 0, 0])],
        ['AIDT', aidt],
        ['CNAM', u32s(0x40)],
        ['DNAM', dnam],
      ]),
    );
    expect(npc).toMatchObject({
      flags: 0x82,
      magickaOffset: 10,
      staminaOffset: -5,
      level: 1500,
      calcMinLevel: 6,
      calcMaxLevel: 30,
      templateFlags: 0x2,
      healthOffset: 25,
      health: 250,
      magicka: 80,
      stamina: 120,
      class: 0x40,
      spells: [0x200],
      perks: [0x30],
    });
    expect(npc.skills[0]).toBe(40);
    expect(npc.skillOffsets[0]).toBe(5);
    expect(npc.factions.get(0x10)).toBe(2);
    expect(npc.aiData).toMatchObject({
      aggression: 1,
      confidence: 3,
      morality: 0,
      mood: 3,
      assistance: 2,
    });
    expect(npc.aiData.aggroRadius?.[0]).toBe(500);
  });

  it('read a race: starting attributes, carry weight, regeneration and abilities', () => {
    const data = new DataView(new ArrayBuffer(128));
    for (let i = 0; i < 14; i += 2) data.setUint8(i, 0xff);
    data.setUint8(0, 15); // Sneak
    data.setInt8(1, 10);
    data.setFloat32(36, 100, true);
    data.setFloat32(40, 50, true);
    data.setFloat32(44, 75, true);
    data.setFloat32(48, 300, true);
    data.setFloat32(84, 0.7, true);
    const race = parseRaceStats(
      record('RACE', [
        ['DATA', new Uint8Array(data.buffer)],
        ['SPLO', u32s(0x500)],
      ]),
    );
    expect(race).toMatchObject({
      skillBoosts: [{ actorValue: 15, bonus: 10 }],
      startingHealth: 100,
      startingMagicka: 50,
      startingStamina: 75,
      baseCarryWeight: 300,
      spells: [0x500],
    });
    expect(race.healthRegen).toBeCloseTo(0.7, 5);
  });

  it('read relationships as GetRelationshipRank gives them (4 lover .. −4 archnemesis)', () => {
    const data = new DataView(new ArrayBuffer(16));
    data.setUint32(0, 0x13bb, true);
    data.setUint32(4, 0x14, true);
    data.setUint16(8, 3, true); // friend
    data.setUint16(10, 0x8000, true);
    expect(parseRelationship(record('RELA', [['DATA', new Uint8Array(data.buffer)]]))).toEqual({
      parent: 0x13bb,
      child: 0x14,
      rank: 1,
      secret: true,
      association: undefined,
    });
  });

  it("read a faction's reactions to others", () => {
    const xnam = new DataView(new ArrayBuffer(12));
    xnam.setUint32(0, 0x20, true);
    xnam.setInt32(4, -10, true);
    xnam.setUint32(8, 1, true);
    expect(parseFaction(record('FACT', [['XNAM', new Uint8Array(xnam.buffer)]])).reactions).toEqual(
      [{ faction: 0x20, modifier: -10, combat: 1 }],
    );
  });

  it("read a class's training: its skill and how far", () => {
    const data = new Uint8Array(36);
    data[4] = 2;
    data[5] = 50;
    expect(parseClass(record('CLAS', [['DATA', data]]))).toMatchObject({
      trainingSkill: 2,
      maxTrainingLevel: 50,
    });
    data[4] = 0xff;
    expect(parseClass(record('CLAS', [['DATA', data]])).trainingSkill).toBeUndefined();
  });

  it("read a vendor faction's list, merchant chest, hours and buying rules", () => {
    const venv = new Uint8Array(12);
    new DataView(venv.buffer).setUint16(0, 8, true);
    new DataView(venv.buffer).setUint16(2, 20, true);
    venv[9] = 1;
    const faction = parseFaction(
      record('FACT', [
        ['DATA', u32s(0x4000)],
        ['VEND', u32s(0x6cb48)],
        ['VENC', u32s(0x9caf9)],
        ['VENV', venv],
      ]),
    );
    expect(faction.vendor).toEqual({
      startHour: 8,
      endHour: 20,
      radius: 0,
      onlyStolen: false,
      notInList: true,
      list: 0x6cb48,
      chest: 0x9caf9,
      conditions: [],
    });
    expect(parseFaction(record('FACT', [['VENV', venv]])).vendor).toBeUndefined();
  });

  it("read a crime faction's jail, chests and crime values (CRVA)", () => {
    const crva = new DataView(new ArrayBuffer(20));
    crva.setUint8(0, 1); // arrest
    crva.setUint8(1, 1); // attack on sight
    crva.setUint16(2, 1000, true);
    crva.setUint16(4, 40, true);
    crva.setUint16(6, 5, true);
    crva.setUint16(8, 25, true);
    crva.setFloat32(12, 0.5, true);
    crva.setUint16(16, 100, true);
    crva.setUint16(18, 1000, true);
    const faction = parseFaction(
      record('FACT', [
        ['DATA', u32s(0x9040)],
        ['JAIL', u32s(0x267e5)],
        ['WAIT', u32s(0x267e6)],
        ['STOL', u32s(0x9dc64)],
        ['PLCN', u32s(0x267e8)],
        ['CRGR', u32s(0x26953)],
        ['JOUT', u32s(0x28b60)],
        ['CRVA', new Uint8Array(crva.buffer)],
      ]),
    );
    expect(faction.crime).toEqual({
      exteriorJailMarker: 0x267e5,
      followerWaitMarker: 0x267e6,
      stolenGoodsContainer: 0x9dc64,
      playerInventoryContainer: 0x267e8,
      sharedCrimeFactions: 0x26953,
      jailOutfit: 0x28b60,
      arrest: true,
      attackOnSight: true,
      murder: 1000,
      assault: 40,
      trespass: 5,
      pickpocket: 25,
      stealMult: 0.5,
      escape: 100,
      werewolf: 1000,
    });
    expect(parseFaction(record('FACT', [['DATA', u32s(0)]])).crime).toBeUndefined();
  });

  it("merge a location's reference lists: the master's, then added and removed ones", () => {
    const special = (type: number, reference: number): Uint8Array => u32s(type, reference, 0x3c, 0);
    const master = record('LCTN', [
      ['LCSR', new Uint8Array([...special(0x130f7, 0x500), ...special(0x130fd, 0x501)])],
      ['LCUN', u32s(0x13bb, 0x600, 0x100)],
    ]);
    const override = record('LCTN', [
      ['ACSR', special(0x130f7, 0x502)],
      ['RCSR', u32s(0x501)],
      ['PNAM', u32s(0x90)],
    ]);
    const location = parseLocation([master, override]);
    expect(location?.references.map((entry) => entry.reference)).toEqual([0x500, 0x502]);
    expect(location?.uniques.get(0x13bb)).toBe(0x600);
    expect(location?.parent).toBe(0x90);
  });
});
