import { describe, expect, it } from 'vitest';
import {
  CHANGE_FORM_FLAGS,
  ChangeNpc,
  ChangeQuest,
  ChangeRefr,
} from '../formats/ess/change-forms.ts';
import { readEss } from '../formats/ess/ess.ts';
import { EssWriter, writeSyntheticEss } from '../formats/ess/ess-test-writer.ts';
import { PapyrusType } from '../formats/ess/papyrus.ts';
import type { GameState } from '../scripting/runtime/game-state.ts';
import { ObjectHandle } from '../scripting/values.ts';
import { formIdMapper, importEss, type EssWorld } from './ess-import.ts';

const WHITERUN_WORLD = 0x1a26f;
const BREEZEHOME = 0x165a7;
const QUEST = 0x3372b;
/** Dawnguard.esm's form, and its plugin's slot in each load order. */
const DAWNGUARD_FORM = 0x000d62;

function papyrus(): Uint8Array {
  const strings = ['MyQuestScript', 'Quest', 'count', 'Int', 'target', 'Actor'];
  const w = new EssWriter().u16(4).u16(strings.length);
  for (const s of strings) w.wstring(s);
  w.u32(1).u16(0).u16(1).u32(2).u16(2).u16(3).u16(4).u16(5);
  w.u32(2);
  w.u32(0x10).u16(0).u16(0).u16(0x4d).refId(1, QUEST).u8(0);
  w.u32(0x11).u16(5).u16(0).u16(0x3e).refId(1, 0x14).u8(0);
  w.u32(0).u32(0).u32(1).u32(0);
  w.u32(0x10).u8(0).u16(0).u32(0).u32(2).u8(PapyrusType.Int).i32(3);
  w.u8(PapyrusType.Object).u16(5).u32(0x11);
  w.u32(0x11).u8(0).u16(5).u32(0).u32(0);
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
        flags: ChangeRefr.moved | ChangeRefr.inventory,
        data: new EssWriter()
          .refId(1, BREEZEHOME)
          .f32(10)
          .f32(20)
          .f32(30)
          .f32(0)
          .f32(0)
          .f32(1)
          .u32(0)
          .u32(0)
          .vsval(1)
          .refId(1, 0xf)
          .i32(50)
          .vsval(0)
          .done(),
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
        flags: CHANGE_FORM_FLAGS | ChangeQuest.flags | ChangeQuest.stages,
        data: new EssWriter().u32(0).u16(0).u16(1).vsval(1).u16(10).u8(1).done(),
      },
      {
        // A Dawnguard reference disabled (by its index in the form id array).
        refId: [0, 1],
        type: 0,
        flags: CHANGE_FORM_FLAGS | ChangeRefr.lockExtra,
        data: new EssWriter().u32(0x800).u16(0).vsval(0).done(),
      },
    ],
    formIds: [(2 << 24) | DAWNGUARD_FORM],
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
    const quest = state.quests.get(QUEST);
    expect(quest?.running).toBe(true);
    expect([...(quest?.stagesDone ?? [])]).toEqual([10]);
    expect(state.references.get(0x03000d62)?.enabled).toBe(false);
    expect(game.runtime.stats.get('Locations Discovered')).toBe(4);
    expect(game.runtime.instances).toContainEqual({
      formId: QUEST,
      alias: -1,
      script: 'MyQuestScript',
      state: '',
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
    expect(imported.skipped).toContain('REFR: lockExtra');
  });
});
