import { describe, expect, it } from 'vitest';
import {
  CHANGE_FORM_FLAGS,
  ChangeCell,
  ChangeNpc,
  ChangeQuest,
  ChangeRefr,
} from '../formats/ess/change-forms.ts';
import { readEss } from '../formats/ess/ess.ts';
import { EssWriter, writeSyntheticEss } from '../formats/ess/ess-test-writer.ts';
import { PapyrusType } from '../formats/ess/papyrus.ts';
import type { GameState } from '../scripting/runtime/game-state.ts';
import { ObjectHandle } from '../scripting/values.ts';
import { formIdMapper, importEss, procedurePath, type EssWorld } from './ess-import.ts';

const WHITERUN_WORLD = 0x1a26f;
const BREEZEHOME = 0x165a7;
const QUEST = 0x3372b;
/** Dawnguard.esm's form, and its plugin's slot in each load order. */
const DAWNGUARD_FORM = 0x000d62;
const COMPANIONS = 0x48362;
const ESSENTIAL_NPC = 0x2bfa7;

/** An actor's own data without an AI process: 25 health damage, Two-handed (7) at 35. */
function actorData(w: EssWriter): EssWriter {
  w.u8(0).bytes(new Uint8Array(52)).refId(0, 0).bytes(new Uint8Array(18)).refId(0, 0).u8(0);
  for (let i = 0; i < 5; i++) w.refId(0, 0);
  w.u32(3).f32(0).f32(0).f32(-25);
  for (let i = 0; i < 3; i++) w.u32(3).f32(0).f32(0).f32(0);
  w.vsval(1).i32(7).f32(35).vsval(0).u32(0);
  return w.u8(0).u32(0).u8(0).u32(0).u32(0).u32(0).refId(0, 0).u8(0);
}

function papyrus(): Uint8Array {
  const strings = ['MyQuestScript', 'Quest', 'count', 'Int', 'target', 'Actor', 'Waiting', ''];
  const w = new EssWriter().u16(6).u32(strings.length);
  for (const s of strings) w.wstring(s);
  w.u32(1).u32(0).u32(1).u32(2).u32(2).u32(3).u32(4).u32(5);
  w.u32(2);
  // The game handles' high words: −1 on a form (an alias script's would be its alias id).
  w.u64(0x10n).u32(0).u16(0).u16(0xffff).refId(1, QUEST).u8(0);
  w.u64(0x11n).u32(5).u16(0).u16(0xffff).refId(1, 0x14).u8(0);
  w.u32(0).u32(0).u32(1).u32(0); // no detached objects, arrays or stacks
  w.u64(0x10n).u8(0).u32(6).u32(0).u32(2).u8(PapyrusType.Int).i32(3); // in state Waiting
  w.u8(PapyrusType.Object).u32(5).u64(0x11n);
  w.u64(0x11n).u8(0).u32(7).u32(0).u32(0);
  // No messages or suspended stacks; the registrations (version 5), all empty.
  for (let i = 0; i < 6; i++) w.u32(0);
  w.u16(5);
  for (let i = 0; i < 21; i++) w.u32(0);
  return w.done();
}

function save(): Uint8Array {
  return writeSyntheticEss({
    playerName: 'Dragonborn',
    playerLevel: 9,
    location: 'Breezehome',
    plugins: ['Skyrim.esm', 'Update.esm', 'Dawnguard.esm'],
    globalData1: [
      { type: 0, data: new EssWriter().u32(1).wstring('Locations Discovered').u8(0).i32(4).done() },
      {
        type: 1,
        data: new EssWriter()
          .u32(0)
          .refId(1, WHITERUN_WORLD)
          .i32(0)
          .i32(0)
          .refId(1, WHITERUN_WORLD)
          .f32(1)
          .f32(2)
          .f32(3)
          .done(),
      },
      { type: 3, data: new EssWriter().vsval(1).refId(1, 0x39).f32(12.5).done() },
    ],
    globalData3: [{ type: 1001, data: papyrus() }],
    changeForms: [
      {
        // The player: moved into Breezehome, with 50 more gold (Skyrim.esm's 0xF).
        refId: [1, 0x14],
        type: 1,
        // In the Companions (rank 1), with 25 health damage and Two-handed raised to 35.
        flags: ChangeRefr.moved | ChangeRefr.inventory | ChangeRefr.ownershipExtra,
        data: actorData(
          new EssWriter()
            .refId(1, BREEZEHOME)
            .f32(10)
            .f32(20)
            .f32(30)
            .f32(0)
            .f32(0)
            .f32(1)
            .u32(0xffffffff) // no AI process
            .u32(0)
            .vsval(1)
            .u8(0x5b)
            .vsval(1)
            .refId(1, COMPANIONS)
            .u8(1)
            .refId(0, 0)
            .u8(0)
            .vsval(1)
            .refId(1, 0xf)
            .i32(50)
            .vsval(0),
        ).done(),
      },
      {
        refId: [1, 0x7],
        type: 9,
        flags: ChangeNpc.fullName | ChangeNpc.skills,
        data: new EssWriter().wstring('Dovahkiin').bytes(new Uint8Array(52).fill(20)).done(),
      },
      {
        refId: [1, QUEST],
        type: 8,
        flags: CHANGE_FORM_FLAGS | ChangeQuest.flags | ChangeQuest.stages | ChangeQuest.objectives,
        // Stage 10 done; objective 0 failed (and shown).
        data: new EssWriter()
          .u32(0)
          .u16(0)
          .u16(1)
          .vsval(1)
          .u16(10)
          .u8(1)
          .vsval(1)
          .u32(0)
          .u32(5)
          .done(),
      },
      {
        // A Dawnguard reference disabled (by its index in the form id array), locked at 50.
        refId: [0, 1],
        type: 0,
        flags: CHANGE_FORM_FLAGS | ChangeRefr.lockExtra,
        data: new EssWriter()
          .u32(0x800)
          .u16(0)
          .vsval(1)
          .u8(0x2a)
          .u8(50)
          .u8(1)
          .refId(0, 0)
          .u32(0)
          .u32(0)
          .done(),
      },
      {
        // An NPC a script made essential (ACBS flags 0x2).
        refId: [1, ESSENTIAL_NPC],
        type: 9,
        flags: ChangeNpc.baseData,
        data: new EssWriter().u32(0x2).bytes(new Uint8Array(20)).done(),
      },
    ],
    formIds: [(2 << 24) | DAWNGUARD_FORM],
  });
}

const HOLDER = 0x1c1a6;
const NO_ZONE = 0x1e;
const ITEM_BASE = 0x2ac62;
const SWAPPED = 0x12345;
const SWAPPED_TO = 0x23456;
const LEVELED = 0x154e6;
const LEVELED_BASE = 0x1e7a0;
const WOLF = 0x23abe;
const SWORD = 0x12eb7;
const NPC_BASE = 0x13bbd;
const FACTION = 0x5c84d;
const BREEZEHOME_CELL = 0x165a7;
const GLOBAL = 0x9cc98;

/** A save with extra data on references, actors and items, and bases' and cells' changes. */
function extrasSave(): Uint8Array {
  return writeSyntheticEss({
    playerName: 'Dragonborn',
    playerLevel: 3,
    location: 'Whiterun',
    plugins: ['Skyrim.esm'],
    globalData1: [
      {
        type: 1,
        data: new EssWriter()
          .u32(0)
          .refId(1, WHITERUN_WORLD)
          .i32(0)
          .i32(0)
          .refId(1, WHITERUN_WORLD)
          .f32(1)
          .f32(2)
          .f32(3)
          .done(),
      },
      { type: 3, data: new EssWriter().vsval(1).refId(1, 0x39).f32(2.25).done() },
    ],
    globalData2: [
      // The actor causes: serial 7 blames the holder.
      {
        type: 103,
        data: new EssWriter().u32(8).vsval(1).f32(0).f32(0).f32(0).u32(7).refId(1, HOLDER).done(),
      },
    ],
    changeForms: [
      {
        // An item the game made, in the holder's inventory, out of its zone, its activation
        // blocked, a trap's cause: itemExtraData, encounterZoneExtra, gameOnlyExtra.
        refId: [2, 0x100],
        type: 0,
        flags: ChangeRefr.itemExtraData | ChangeRefr.encounterZoneExtra | ChangeRefr.gameOnlyExtra,
        data: new EssWriter()
          .refId(1, BREEZEHOME_CELL)
          .f32(0)
          .f32(0)
          .f32(0)
          .f32(0)
          .f32(0)
          .f32(0)
          .u8(0)
          .refId(1, ITEM_BASE)
          .vsval(4)
          .u8(0x1c)
          .refId(1, HOLDER)
          .u8(0x70)
          .refId(1, NO_ZONE)
          .u8(0xa0)
          .u32(1)
          .u8(0x5d)
          .i32(7)
          .done(),
      },
      {
        // A base a script swapped in; a map marker shown and travelled to.
        refId: [1, SWAPPED],
        type: 0,
        flags: ChangeRefr.baseObject | ChangeRefr.gameOnlyExtra,
        data: new EssWriter().refId(1, SWAPPED_TO).vsval(1).u8(0x2c).u8(3).done(),
      },
      {
        // A leveled actor (its pick kept), a ghost, wielding a tempered sword (no process).
        refId: [1, LEVELED],
        type: 1,
        flags: ChangeRefr.leveledActor | ChangeRefr.gameOnlyExtra | ChangeRefr.inventory,
        data: actorData(
          new EssWriter()
            .u32(0xffffffff)
            .u32(0)
            .vsval(2)
            .u8(0x2d)
            .refId(1, LEVELED_BASE)
            .refId(1, WOLF)
            .u32(0)
            .u8(0x1f)
            .u8(1)
            .vsval(1)
            .refId(1, SWORD)
            .i32(1)
            .vsval(1)
            .vsval(2)
            .u8(0x16)
            .u8(0x25)
            .f32(1.2),
        ).done(),
      },
      {
        // An NPC_ base's factions, skills and AI data.
        refId: [1, NPC_BASE],
        type: 9,
        flags: ChangeNpc.factions | ChangeNpc.aiData | ChangeNpc.skills,
        data: new EssWriter()
          .vsval(1)
          .refId(1, FACTION)
          .u8(2)
          .bytes([1, 3, 50, 0, 0, 1, ...new Array<number>(14).fill(0)])
          .bytes(new Uint8Array(52).fill(40))
          .done(),
      },
      {
        // A cell left at hour 7, a public place, with what was seen of it.
        refId: [1, BREEZEHOME_CELL],
        type: 6,
        flags: ChangeCell.detachTime | ChangeCell.flags | ChangeCell.seenData,
        data: new EssWriter()
          .u32(7)
          .u16(0x20)
          .vsval(1)
          .u8(0)
          .u8(0)
          .bytes([1, ...new Array<number>(31).fill(0)])
          .done(),
      },
      {
        // A quest's run holding a text display global's value.
        refId: [1, QUEST],
        type: 8,
        flags: ChangeQuest.instanceData,
        data: new EssWriter()
          .u32(1)
          .vsval(1)
          .u32(1)
          .vsval(0)
          .vsval(1)
          .refId(1, GLOBAL)
          .f32(10)
          .bytes([0, 0, 0])
          .done(),
      },
    ],
    globalData3: [],
    formIds: [],
  });
}

/** Our load order: Dawnguard in slot 3 (another plugin before it). */
const world: EssWorld = {
  plugins: [
    { name: 'Skyrim.esm', modIndex: 0 },
    { name: 'Update.esm', modIndex: 1 },
    { name: 'Other.esm', modIndex: 2 },
    { name: 'Dawnguard.esm', modIndex: 3 },
  ],
  recordType: (formId) =>
    formId === WHITERUN_WORLD ? 'WRLD' : formId === BREEZEHOME ? 'CELL' : undefined,
};

describe('ess import', () => {
  it('moves form ids into our load order by plugin name', () => {
    const map = formIdMapper(
      { plugins: ['Skyrim.esm', 'Dawnguard.esm'], lightPlugins: ['a.esl'] },
      [
        { name: 'Skyrim.esm', modIndex: 0 },
        { name: 'Dawnguard.esm', modIndex: 4 },
        { name: 'A.esl', modIndex: 0xfe, lightIndex: 2 },
      ],
    );
    expect(map(0x01000d62)).toBe(0x04000d62);
    expect(map(0xfe000801)).toBe(0xfe002801);
    expect(map(0xff000123)).toBe(0xff000123);
    expect(map(0x05000001)).toBeUndefined();
  });

  it("puts a running package's procedure states as the branch it had reached", () => {
    // A Stacked branch on its second child, a Sequence on its third (a Sandbox), its place.
    const state = {
      name: 'Stacked',
      index: 1,
      child: { name: 'Sequence', index: 2, child: { name: 'Sandbox' } },
    };
    expect(procedurePath(state)).toEqual([1, 2]);
    // A Simultaneous branch: the first child that runs.
    const simultaneous = {
      name: 'Simultaneous',
      children: [{ index: 0 }, { index: 1, state: { name: 'Patrol' } }],
    };
    expect(procedurePath(simultaneous)).toEqual([1]);
    expect(procedurePath(undefined)).toEqual([]);
  });

  it('imports the player, globals, quests, references, inventories and script variables', () => {
    const imported = importEss(readEss(save()), world, { name: 'Imported 1', number: 1, now: 5 });
    const { header, save: game } = imported;
    expect(header).toMatchObject({
      name: 'Imported 1',
      playerName: 'Dovahkiin',
      playerLevel: 9,
      gameDays: 12.5,
    });
    expect(game.player).toMatchObject({
      cell: BREEZEHOME,
      position: [10, 20, 30],
      rotation: [0, 0, 1],
    });
    expect(game.inventoryDeltas).toEqual([[0x14, [[0xf, 50]]]]);
    const state = game.runtime.state as unknown as GameState;
    expect(state.gameDaysPassed).toBe(12.5);
    expect(state.actors.get(0x14)?.level).toBe(9);
    expect(state.actors.get(0x14)?.values.get(6)?.base).toBe(20);
    expect(state.actors.get(0x14)?.values.get(7)?.base).toBe(35);
    expect(state.actors.get(0x14)?.values.get(24)).toMatchObject({ modifier: 0, damage: 25 });
    expect(state.actors.get(0x14)?.factions.get(COMPANIONS)).toBe(1);
    const quest = state.quests.get(QUEST);
    expect(quest?.running).toBe(true);
    expect([...(quest?.stagesDone ?? [])]).toEqual([10]);
    expect(quest?.objectives.get(0)).toEqual({ displayed: true, completed: false, failed: true });
    expect(state.references.get(0x03000d62)?.enabled).toBe(false);
    expect(game.runtime.stats.get('Locations Discovered')).toBe(4);
    expect(game.runtime.instances).toContainEqual({
      formId: QUEST,
      alias: -1,
      script: 'MyQuestScript',
      state: 'Waiting',
      vars: [
        [
          'MyQuestScript',
          [
            ['count', 3],
            ['target', new ObjectHandle(0x14, 'Actor')],
          ],
        ],
      ],
    });
    expect(state.references.get(0x03000d62)).toMatchObject({ locked: true, lockLevel: 50 });
    expect(imported.skipped).not.toContain('REFR: lockExtra');
    expect(state.actorBases.get(ESSENTIAL_NPC)).toMatchObject({
      essential: true,
      protected: false,
    });
  });

  it("puts references' and items' extra data, bases', cells' and runs' changes in place", () => {
    const types: Record<number, string> = {
      [WHITERUN_WORLD]: 'WRLD',
      [BREEZEHOME_CELL]: 'CELL',
      [SWORD]: 'WEAP',
    };
    const imported = importEss(
      readEss(extrasSave()),
      { plugins: [{ name: 'Skyrim.esm', modIndex: 0 }], recordType: (formId) => types[formId] },
      { name: 'Extras', number: 1, now: 0 },
    );
    const { save: game } = imported;
    const state = game.runtime.state as unknown as GameState;
    // Nothing these change forms hold was left out.
    expect(imported.skipped.filter((line) => /^(REFR|ACHR|NPC_|CELL|QUST)/.test(line))).toEqual([]);
    expect(state.references.get(0xff000100)).toMatchObject({
      container: { holder: HOLDER, base: ITEM_BASE, count: 1 },
      encounterZone: NO_ZONE,
      activationBlocked: true,
      actorCause: HOLDER,
    });
    expect(state.references.get(SWAPPED)?.base).toBe(SWAPPED_TO);
    expect(game.runtime.mapMarkers).toEqual(new Map([[SWAPPED, { visible: true, travel: true }]]));
    // The leveled actor keeps its pick; its sword, tempered, in its right hand.
    expect(state.actors.get(LEVELED)).toMatchObject({ leveledBase: WOLF, ghost: true });
    expect(state.itemStacks.get(LEVELED)?.get(SWORD)).toEqual([
      { count: 1, health: 1.2, worn: true },
    ]);
    expect(game.worn).toEqual([[LEVELED, [[SWORD, 'right']]]]);
    expect(game.inventoryDeltas).toEqual([[LEVELED, [[SWORD, 1]]]]);
    const base = state.actorBases.get(NPC_BASE);
    expect(base?.factions).toEqual(new Map([[FACTION, 2]]));
    expect(base?.aiData).toEqual({
      aggression: 1,
      confidence: 3,
      energy: 50,
      morality: 0,
      mood: 0,
      assistance: 1,
    });
    expect(base?.skills?.get(6)).toBe(40);
    expect(state.cellDetached.get(BREEZEHOME_CELL)).toBe(7);
    expect(state.cells.get(BREEZEHOME_CELL)?.public).toBe(true);
    expect(state.seen.get(BREEZEHOME_CELL)?.has('0,0')).toBe(true);
    expect(state.quests.get(QUEST)?.instanceGlobals?.get(GLOBAL)).toBe(10);
  });
});
