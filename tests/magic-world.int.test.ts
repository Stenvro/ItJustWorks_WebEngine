// Integration test: what M11 added to magic, perks and harvesting on the local game data (no
// new game, no world): perks' Activate choices and their script fragments (Cannibalism), flora
// harvested by the season's chance and Green Thumb and grown again as its cell resets, Slow
// Time's clock and the player's own pace (Quick Reflexes), the rested bonus a sleep gives
// (PlayerSleepQuest), hazards' lifetimes and limits, PlayerKnows. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { parseFlora } from '../src/world/flora-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

/** Skyrim.esm. */
const CANNIBALISM = 0xee5c3;
const GREEN_THUMB = 0x105f2e;
const SLOW_TIME = 0x48ad0;
const QUICK_REFLEXES_PERK = 0xd8c33;
const QUICK_REFLEXES_SPELL = 0xd8c31;
const PLAYER_SLEEP_QUEST = 0xfc1a2;
const CLAIRVOYANCE_HAZARD = 0x2113e;

describe.skipIf(!hasGamedata())('magic, perks and harvesting on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
  const boxes: { text: string; buttons: readonly string[] }[] = [];
  const settle = async (): Promise<void> => {
    await runtime.vm.idle();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const carried = async (): Promise<number> => {
    let total = 0;
    for (const [, count] of await runtime.inventory(PLAYER_REF)) total += count;
    return total;
  };
  const byEditorId = async (type: string, editorId: string): Promise<number | undefined> => {
    for (const formId of db.formIdsOfType(type)) {
      if ((await db.get(formId))?.editorId === editorId) return formId;
    }
    return undefined;
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    runtime = new ScriptRuntime(db, library, {
      world: {
        messageBox: (text, buttons) => {
          boxes.push({ text, buttons: buttons ?? [] });
          return Promise.resolve(1);
        },
      },
    });
    await runtime.magic.prepare(PLAYER_REF);
  }, 120_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it("reads perks' script fragments and runs an Activate choice's (Cannibalism)", async () => {
    const attachments = await runtime.forms.attachments(CANNIBALISM);
    expect(attachments?.fragmentScript).toBe('PRKF_DA11Cannibalism_000EE5C3');
    expect(attachments?.fragments[0]?.function).toBe('Fragment_0');
    const record = await runtime.perks.record(CANNIBALISM);
    const entry = record?.entries.find((e) => e.kind === 'entryPoint' && e.entryPoint === 14);
    expect(entry?.kind === 'entryPoint' && entry.data.type === 'activateChoice').toBe(true);
    // The fragment feeds on the corpse (StartCannibal: it has been eaten).
    const corpse = db.formIdsOfType('ACHR')[0] ?? 0;
    await runtime.perks.runChoice(
      {
        perk: CANNIBALISM,
        label: 'Feed',
        spell: undefined,
        runImmediately: false,
        replaceDefault: false,
        fragment: 0,
      },
      PLAYER_REF,
      corpse,
    );
    await settle();
    expect(runtime.state.actors.get(corpse)?.eaten).toBe(true);
  });

  it('harvests flora by its chance and Green Thumb, and lets it grow again as its cell resets', async () => {
    // A plant whose ingredient grows in every season.
    let flora: number | undefined;
    for (const formId of db.formIdsOfType('FLOR')) {
      const record = await db.get(formId);
      const parsed = record && parseFlora(record);
      if (parsed?.production.every((chance) => chance === 100)) {
        flora = formId;
        break;
      }
    }
    expect(flora).toBeDefined();
    const plant = await runtime.placeAt(flora ?? 0, PLAYER_REF, 1);
    const before = await carried();
    const first = await runtime.harvest.harvest(PLAYER_REF, plant);
    expect(first?.count).toBe(1);
    expect(await carried()).toBeGreaterThan(before);
    expect(runtime.harvest.isHarvested(plant)).toBe(true);
    // Harvested, it gives nothing more.
    expect(await runtime.harvest.harvest(PLAYER_REF, plant)).toBeUndefined();
    // Green Thumb: two.
    await runtime.perks.add(PLAYER_REF, GREEN_THUMB);
    const second = await runtime.harvest.harvest(
      PLAYER_REF,
      await runtime.placeAt(flora ?? 0, PLAYER_REF, 1),
    );
    expect(second?.count).toBe(2);
    // Ten days on (iHoursToRespawnCell) it grows again.
    runtime.state.gameDaysPassed += 10.1;
    runtime.harvest.update(5);
    for (let i = 0; i < 20 && runtime.harvest.isHarvested(plant); i++) await settle();
    expect(runtime.harvest.isHarvested(plant)).toBe(false);
  });

  it("slows the world's clock with Slow Time while the player keeps 70 %, Quick Reflexes all", async () => {
    const slowTime = await runtime.magic.item(SLOW_TIME);
    expect(slowTime).toBeDefined();
    if (slowTime) await runtime.magic.apply(slowTime, PLAYER_REF, { caster: PLAYER_REF });
    await settle();
    expect(runtime.magic.timeMultiplier()).toBeCloseTo(0.3, 5);
    expect(await runtime.magic.playerPace()).toBeCloseTo(0.7, 5);
    await runtime.perks.add(PLAYER_REF, QUICK_REFLEXES_PERK);
    const reflexes = await runtime.magic.item(QUICK_REFLEXES_SPELL);
    if (reflexes) await runtime.magic.apply(reflexes, PLAYER_REF, { caster: PLAYER_REF });
    await settle();
    expect(runtime.magic.timeMultiplier()).toBeCloseTo(0.05, 5);
    expect(await runtime.magic.playerPace()).toBeCloseTo(1, 5);
  });

  it('gives the rested bonus as the player wakes (PlayerSleepQuest registers for sleep)', async () => {
    await runtime.quests.start(PLAYER_SLEEP_QUEST);
    await settle();
    await runtime.registeredEvent('sleep', 'OnSleepStart', [1, 1.25]);
    await runtime.registeredEvent('sleep', 'OnSleepStop', [false]);
    await settle();
    const rested = await byEditorId('SPEL', 'Rested');
    const wellRested = await byEditorId('SPEL', 'WellRested');
    const has = async (spell: number | undefined): Promise<boolean> =>
      spell !== undefined && (await runtime.actors.hasSpell(PLAYER_REF, spell));
    expect((await has(rested)) || (await has(wellRested))).toBe(true);
  });

  it('keeps a hazard its lifetime and a source to its limit', async () => {
    const hazard = await runtime.hazards.record(CLAIRVOYANCE_HAZARD);
    expect(hazard?.lifetime).toBe(10);
    expect(hazard?.limit).toBe(1);
    const first = await runtime.hazards.place(CLAIRVOYANCE_HAZARD, [0, 0, 0], PLAYER_REF);
    const second = await runtime.hazards.place(CLAIRVOYANCE_HAZARD, [64, 0, 0], PLAYER_REF);
    expect(first).toBeDefined();
    // Its limit of one: the first went.
    expect(runtime.hazards.get(first ?? 0)).toBeUndefined();
    expect(runtime.state.references.get(first ?? 0)?.deleted).toBe(true);
    runtime.hazards.update(11);
    expect(runtime.hazards.get(second ?? 0)).toBeUndefined();
  });

  it('knows what the player knows (PlayerKnows: their spells)', async () => {
    const spells = await runtime.actors.spells(PLAYER_REF);
    const spell = spells[0];
    if (spell !== undefined) expect(await runtime.playerKnows(spell)).toBe(true);
    expect(await runtime.playerKnows(CANNIBALISM)).toBe(false);
  });
});
