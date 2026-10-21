// Integration test: a new game's scripts in the script runtime, on the local game data: the
// quests that start with the game and the opening run, every native the scripts call exists,
// aliases fill as the Creation Kit describes. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { ScriptRuntime, type WorldBridge } from '../src/scripting/runtime/runtime.ts';
import { Fn } from '../src/scripting/runtime/condition-values.ts';
import { PLACEHOLDER_NATIVES } from '../src/scripting/runtime/natives/placeholders.ts';
import type { Condition } from '../src/scripting/conditions.ts';
import { QuestFlag } from '../src/world/quest-records.ts';
import { ActorValue } from '../src/world/actor-values.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const MQ101 = 0x0003372b;
const MQ103 = 0x000d0800;
const PLAYER = 0x14;
/** FreeformCaravansA (Amulet of the Moon) and its amulet (FreeformCaravansANecklace). */
const CARAVANS_A = 0x000d9393;
const AMULET = 0x000d9394;

describe.skipIf(!hasGamedata())('the script runtime on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
  const warnings: string[] = [];
  const world: WorldBridge = {};

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    const library = new ScriptLibrary(async (name) => {
      const path = `scripts\\${name}.pex`;
      return vfs.has(path) ? vfs.read(path) : undefined;
    });
    runtime = new ScriptRuntime(db, library, {
      world,
      warn: (message) => warnings.push(message),
    });
    await runtime.newGame();
    // Ten seconds of play at TimeScale 20.
    for (let t = 0; t < 10; t += 0.1) {
      runtime.update(0.1, (0.1 * 20) / 86400);
      await runtime.vm.idle();
    }
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('starts every quest that starts with the game', async () => {
    const missed: string[] = [];
    for (const formId of db.formIdsOfType('QUST')) {
      const quest = await runtime.forms.quest(formId);
      if (!quest || (quest.flags & QuestFlag.startGameEnabled) === 0) continue;
      // Some stop themselves at once (the patch and DLC set-up quests): they started.
      if ((runtime.state.quests.get(formId)?.starts ?? 0) === 0) missed.push(quest.editorId);
    }
    expect(missed).toEqual([]);
  });

  it('places the player where the world shows them, in the cell they walked into', async () => {
    // A script left the player somewhere; the player then walked through a door.
    const interior = 0x000165a7;
    world.livePlacement = (reference) =>
      reference === PLAYER
        ? { position: [1, 2, 3], rotation: [0, 0, 1], cell: interior }
        : undefined;
    try {
      expect(await runtime.placement(PLAYER)).toMatchObject({
        position: [1, 2, 3],
        rotation: [0, 0, 1],
        cell: interior,
        world: undefined,
      });
    } finally {
      delete world.livePlacement;
    }
  });

  it('runs the opening, its stages choosing their log entry (no debug fragments)', () => {
    const opening = runtime.state.quests.get(MQ101);
    expect(opening?.running).toBe(true);
    expect(opening?.aliases.size).toBeGreaterThan(100);
    // A later log entry of an early stage asks the debug question; it must not run.
    expect(runtime.state.messages.some((text) => text.includes('befriend'))).toBe(false);
  });

  it('has every native the scripts call', () => {
    expect(warnings.filter((message) => message.endsWith('is not implemented'))).toEqual([]);
  });

  it("fills a location's reference of a type from the master's and the DLCs' merged lists", () => {
    // Bleak Falls Barrow's boss: Skyrim.esm lists it; Dawnguard.esm's override adds others.
    const boss = runtime.state.quests.get(MQ103)?.aliases;
    expect(boss && [...boss.values()].length).toBeGreaterThan(0);
  });

  it("lets the game's weapon racks hold their weapons (OnCellAttach, MoveToNode)", async () => {
    // Jorrvaskr's racks (Breezehome's are part of furnishings not yet bought: disabled).
    const JORRVASKR = 0x000165b5;
    const moved = new Map<number, number>();
    const world = runtime.world;
    world.loaded = () => true;
    world.triggerCount = () => 0;
    world.nodePlacement = (_reference, node) =>
      node.toLowerCase().endsWith('pivot01')
        ? { position: [1, 2, 3], rotation: [0, 0, 0] }
        : undefined;
    world.motionTypeChanged = (reference, motion) => moved.set(reference, motion);
    const references = db.cellReferences(JORRVASKR);
    const racks: number[] = [];
    for (const reference of references) {
      const scripts = await runtime.attachedScripts(runtime.referenceHandle(reference));
      if (scripts.some((script) => script.name.toLowerCase() === 'weaponrackactivatescript')) {
        racks.push(reference);
      }
    }
    expect(racks.length).toBeGreaterThan(0);
    await runtime.cellAttached(references, () => true);
    for (let t = 0; t < 2; t += 0.1) {
      runtime.update(0.1, 0);
      await runtime.vm.idle();
    }
    const held: number[] = [];
    for (const rack of racks) {
      const weapon = await runtime.linkedReference(rack, 0);
      if (weapon !== undefined && moved.get(weapon) === 4) held.push(weapon);
    }
    // At least one starting weapon is keyframed and sits on its rack's pivot.
    expect(held.length).toBeGreaterThan(0);
    for (const weapon of held) {
      expect(runtime.state.references.get(weapon)?.position).toEqual([1, 2, 3]);
    }
  });

  it("gives the player the race's starting attributes", async () => {
    const health = await runtime.actors.value(PLAYER, ActorValue.health);
    expect(health.max).toBeGreaterThan(0);
    expect(await runtime.actors.level(PLAYER)).toBe(1);
  });

  it('holds every placeholder native to a milestone, and has each registered', () => {
    for (const [key, why] of PLACEHOLDER_NATIVES) {
      const [script = '', fn = ''] = key.split('.');
      expect(runtime.native(script, fn), key).toBeDefined();
      expect(why, key).toMatch(/^TODO\(M1[1-3]\): /);
    }
  });

  it('values the conditions on what quests made: an item in its container, its quest alias', async () => {
    // Amulet of the Moon's amulet: made at its dungeon's boss container as the quest starts, put
    // in it as Kharjo tells of it (its stage 10's AddItem with the reference: GetInContainer).
    const aliases = runtime.state.quests.get(CARAVANS_A)?.aliases;
    const container = aliases?.get(20);
    const amulet = aliases?.get(26);
    expect(container).toBeDefined();
    expect(amulet).toBeDefined();
    if (container === undefined || amulet === undefined) return;
    const inContainer = (form: number): Condition => ({
      function: Fn.getInContainer,
      operator: 0,
      or: false,
      comparand: 1,
      form,
      param2: 0,
      raw1: form,
      form2: 0,
      strings: [],
      runOn: 0,
      reference: 0,
      param3: -1,
      eventMember: '',
    });
    const item = runtime.referenceHandle(amulet);
    expect(await runtime.conditionsHold([inContainer(container)], item)).toBe(false);
    await runtime.quests.setStage(CARAVANS_A, 10);
    await runtime.vm.idle();
    expect(await runtime.conditionsHold([inContainer(container)], item)).toBe(true);
    expect(await runtime.conditionsHold([inContainer(PLAYER)], item)).toBe(false);
    // Taken by the player, it is theirs.
    await runtime.removeItem(container, runtime.formHandle(AMULET), 1, true, PLAYER);
    expect(await runtime.conditionsHold([inContainer(PLAYER)], item)).toBe(true);
  });

  // Last: the player dies.
  it('lets the player die of their health run out, not in god mode (Debug.SetGodMode)', async () => {
    const killed: number[] = [];
    runtime.world.killed = (actor) => killed.push(actor);
    try {
      runtime.godMode = true;
      const health = await runtime.actors.value(PLAYER, ActorValue.health);
      await runtime.actors.damage(PLAYER, ActorValue.health, health.max * 2, undefined);
      expect(await runtime.actors.isDead(PLAYER)).toBe(false);
      runtime.godMode = false;
      // The opening's aliases do not make the player essential.
      expect(await runtime.actors.isEssential(PLAYER)).toBe(false);
      await runtime.actors.damage(PLAYER, ActorValue.health, health.max * 2, undefined);
      await runtime.vm.idle();
      expect(await runtime.actors.isDead(PLAYER)).toBe(true);
      expect(killed).toEqual([PLAYER]);
      expect(runtime.state.actors.get(PLAYER)?.dead).toBe(true);
    } finally {
      delete runtime.world.killed;
    }
  });
});
