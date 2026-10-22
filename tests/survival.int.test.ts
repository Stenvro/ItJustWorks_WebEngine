// Integration test: Survival Mode's warmth on the local game data (src/scripting/runtime/
// warmth-engine.ts): armor by its body part and Update.esm's keywords (an enchanted variant by its
// template's), a hooded robe, a torch, and the player's rating with what they wear and a Fortify
// Warmth; a need's quest, started by its own script, keeps the stage values the script sets
// after Start. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WARMTH_BONUS_VALUE } from '../src/gameplay/warmth.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { ObjectHandle } from '../src/scripting/values.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())("Survival Mode's warmth on the local game data", () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
  const byEditorId = new Map<string, number>();
  const form = (editorId: string): number => {
    const formId = byEditorId.get(editorId.toLowerCase());
    if (formId === undefined) throw new Error(`${editorId} not found`);
    return formId;
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    runtime = new ScriptRuntime(db, library);
    for (const type of ['ARMO', 'LIGH']) {
      for (const formId of db.formIdsOfType(type)) {
        const editorId = (await db.get(formId))?.editorId;
        if (editorId) byEditorId.set(editorId.toLowerCase(), formId);
      }
    }
  }, 120_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it("gives armor its body part's warmth by Update.esm's keywords", async () => {
    expect(await runtime.warmth.armor(form('ArmorDaedricCuirass'))).toBe(54);
    expect(await runtime.warmth.armor(form('ArmorDaedricHelmet'))).toBe(29);
    expect(await runtime.warmth.armor(form('ClothesPrisonerRags'))).toBe(17);
    expect(await runtime.warmth.armor(form('ArmorStormcloakGauntlets'))).toBe(7);
    // A hooded robe: body and head.
    expect(await runtime.warmth.armor(form('ClothesMGRobesArchmage1Hooded'))).toBe(54 + 29);
    // An enchanted variant has its template's keywords.
    expect(await runtime.warmth.armor(form('EnchArmorDaedricHelmetMagickaRate06'))).toBe(29);
    expect(await runtime.warmth.armor(form('EnchRingResistMagic06'))).toBe(0);
  });

  it('warms with a carried light', async () => {
    expect(await runtime.warmth.light(form('Torch01'))).toBe(50);
    expect(await runtime.warmth.of(form('Torch01'))).toBe(50);
  });

  it("sums the player's worn pieces and Fortify Warmth", async () => {
    const before = await runtime.warmth.actor(PLAYER_REF);
    const cuirass = form('ArmorDaedricCuirass');
    await runtime.addItem(PLAYER_REF, runtime.formHandle(cuirass), 1, true);
    await runtime.equipment.equip(PLAYER_REF, cuirass);
    runtime.actors.modify(PLAYER_REF, WARMTH_BONUS_VALUE, 25);
    // The cuirass takes the place of what was worn on the body (the player's default clothes).
    const after = await runtime.warmth.actor(PLAYER_REF);
    expect(after).toBeGreaterThan(before);
    let worn = 0;
    for (const piece of await runtime.equipment.worn(PLAYER_REF))
      worn += await runtime.warmth.armor(piece);
    expect(after).toBe(worn + 25);
    expect(worn).toBeGreaterThanOrEqual(54);
  });

  it('keeps what a need sets after starting its own quest (its stage values)', async () => {
    // Survival_NeedBase.StartNeed: Start (the quest's scripts are reset as it starts), then
    // SetNeedStageValues and the first update. Reset apart from the running script, the quest's
    // own had no stage values: every need value counted as stage 5 (frostbite, starving, their
    // image-space modifiers at once).
    let quest: number | undefined;
    for (const formId of db.formIdsOfType('QUST')) {
      if ((await db.get(formId))?.editorId === 'Survival_NeedHungerQuest') quest = formId;
    }
    expect(quest).toBeDefined();
    if (quest === undefined) return;
    const hunger = new ObjectHandle(quest, 'survival_needhunger');
    // Its first update waits on game time, which stands still here: not awaited.
    void runtime.vm.call(hunger, 'StartNeed');
    const stages = async (): Promise<unknown[]> => {
      const values: unknown[] = [];
      for (let n = 1; n <= 5; n++) {
        values.push(await runtime.vm.getVariable(hunger, `::needStage${String(n)}Value_var`));
      }
      return values;
    };
    for (let i = 0; i < 100 && (await stages())[4] !== 770; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(runtime.quests.isRunning(quest)).toBe(true);
    expect(await stages()).toEqual([80, 160, 340, 520, 770]);
  });
});
