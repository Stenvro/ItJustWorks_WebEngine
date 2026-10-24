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
import { ObjectHandle } from '../src/scripting/values.ts';
import { playerTrigger } from '../src/scripting/runtime/trigger-gates.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const MQ101 = 0x0003372b;
const MQ103 = 0x000d0800;
const PLAYER = 0x14;
/** FreeformCaravansA (Amulet of the Moon) and its amulet (FreeformCaravansANecklace). */
const CARAVANS_A = 0x000d9393;
const AMULET = 0x000d9394;
/** Riften's north gate: DialogueRiftenSS01, its RDS01Scene and RDS01TriggerRef. */
const DIALOGUE_RIFTEN_SS01 = 0x000aa0b3;
const RDS01_SCENE = 0x000aa0ba;
const RDS01_TRIGGER = 0x000aa0b9;

describe.skipIf(!hasGamedata())('the script runtime on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let runtime: ScriptRuntime;
  const warnings: string[] = [];
  const gameLogged: string[] = [];
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
      gameLog: (message) => gameLogged.push(message),
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

  it("logs no warning of ours in a new game, only the game's own faults", () => {
    // docs/scripting.md "The log": what vanilla's own data gets wrong is logged as the game's.
    expect(warnings).toEqual([]);
    expect(gameLogged.length).toBeGreaterThan(0);
    expect(
      gameLogged.every(
        (line) =>
          line.includes('cannot be initialized because the script no longer contains') ||
          line.includes('is not set in the plugin'),
      ),
    ).toBe(true);
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

  it('values GetDistance: far for one in another space, so a scene waits for the player', async () => {
    // MorthalInitialScene's first phase completes once Aslfur (in Morthal) is within 1000
    // units of the player, who is on the opening's cart near Helgen.
    const morthal = [...runtime.scenes.playing()].find((scene) => scene.scene === 0x00041500);
    expect(morthal?.phase).toBe(0);
    const distance = (form: number): Condition => ({
      function: Fn.getDistance,
      operator: 4,
      or: false,
      comparand: 1000,
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
    const aslfur = runtime.referenceHandle(0x0001aa68);
    expect(await runtime.conditionsHold([distance(PLAYER)], aslfur)).toBe(false);
    // Thonnir stands beside him.
    expect(await runtime.conditionsHold([distance(0x0001aa6b)], aslfur)).toBe(true);
  });

  it("values the killmove idles' conditions on their subject and target as the engine does", async () => {
    const tree = await (await import('../src/ai/idle-records.ts')).readIdleTree(db);
    const idle = (formId: number): readonly Condition[] => tree.idles.get(formId)?.conditions ?? [];
    const ripHeart = idle(0x0403d2ca);
    const npcRoot = idle(0x0006440b);
    const aslfur = 0x0001aa68;
    const thonnir = 0x0001aa6b;
    const asked: [number, number][] = [];
    world.attackKills = (attacker, target) => {
      asked.push([attacker, target]);
      return Promise.resolve(true);
    };
    const player = runtime.referenceHandle(PLAYER);
    try {
      // RipHeartOut: ShouldAttackKill() (its empty parameter: the target) and
      // GetIsID(DLC2Ildari) on the target: no killmove of Ildari's on Aslfur, none without a
      // target (a condition run on a missing target fails).
      expect(ripHeart.length).toBe(2);
      expect(
        await runtime.conditionsHold(ripHeart, player, undefined, {
          target: runtime.referenceHandle(aslfur),
        }),
      ).toBe(false);
      expect(asked).toEqual([[PLAYER, aslfur]]);
      expect(await runtime.conditionsHold(ripHeart, player)).toBe(false);
      // HasKeyword(ActorTypeNPC) on the target: a race's keyword.
      expect(
        await runtime.conditionsHold(npcRoot, player, undefined, {
          target: runtime.referenceHandle(aslfur),
        }),
      ).toBe(true);
      // GetRelativeAngle(, 'Z') on the subject: its facing less the target's, 0..360.
      const angle = (operator: number, comparand: number): Condition => ({
        function: Fn.getRelativeAngle,
        operator,
        or: false,
        comparand,
        form: 0,
        param2: 0x5a,
        raw1: 0,
        form2: 0,
        strings: [],
        runOn: 0,
        reference: 0,
        param3: -1,
        eventMember: '',
      });
      const [a, t] = await Promise.all([runtime.placement(aslfur), runtime.placement(thonnir)]);
      if (!a || !t) throw new Error('not placed');
      const degrees = (((((a.rotation[2] - t.rotation[2]) * 180) / Math.PI) % 360) + 360) % 360;
      const subject = runtime.referenceHandle(aslfur);
      const context = { target: runtime.referenceHandle(thonnir) };
      expect(
        await runtime.conditionsHold([angle(3, degrees - 0.5)], subject, undefined, context),
      ).toBe(true);
      expect(
        await runtime.conditionsHold([angle(5, degrees + 0.5)], subject, undefined, context),
      ).toBe(true);
    } finally {
      world.attackKills = undefined;
    }
  });

  it("relays the hub's events to the scripts that handle them (a dragon's combat)", async () => {
    // EncDragon04Fire runs dragonActorSCRIPT, which handles OnCombatStateChanged.
    const dragon = await runtime.placeAt(0x000f811b, PLAYER, 1);
    const ran: string[] = [];
    runtime.vm.handled = (script, event, target) => {
      if (target.formId === dragon) ran.push(`${script.toLowerCase()}.${event}`);
    };
    try {
      await runtime.events.emitted('combat', { actor: dragon, target: PLAYER, state: 1 });
      await runtime.vm.idle();
      expect(ran).toContain('dragonactorscript.OnCombatStateChanged');
    } finally {
      runtime.vm.handled = undefined;
    }
  });

  it('tells a translation as almost complete, then complete; one without its 3D as failed', async () => {
    const told: string[] = [];
    const stop = runtime.events.on('objectTranslation', (event) => {
      told.push(`${event.reference.toString(16)}:${String(event.result)}`);
    });
    const marker = await runtime.placeAt(0x0000003b, PLAYER, 1);
    try {
      world.loaded = () => false;
      await runtime.translate(marker, [0, 0, 0], [0, 0, 0], 100);
      world.loaded = () => true;
      const at = await runtime.placement(marker);
      const to = at?.position ?? [0, 0, 0];
      await runtime.translate(marker, [to[0] + 100, to[1], to[2]], [0, 0, 0], 100);
      for (let t = 0; t < 1.5; t += 0.05) {
        runtime.update(0.05, 0);
        await runtime.vm.idle();
      }
      const id = marker.toString(16);
      expect(told).toEqual([`${id}:0`, `${id}:2`, `${id}:1`]);
    } finally {
      delete world.loaded;
      stop();
    }
  });

  it('tells those inside a trigger volume again every fTriggerEventDelayMS', () => {
    const told: number[] = [];
    const stop = runtime.events.on('trigger', (event) => {
      if (event.trigger === 0x7f) told.push(event.reference);
    });
    try {
      runtime.triggered(0x7f, PLAYER, true);
      for (let t = 0; t < 1.2; t += 0.1) runtime.update(0.1, 0);
      runtime.triggered(0x7f, PLAYER, false);
      runtime.update(1, 0);
      // At once, after 0.5 s and after 1 s; none once out.
      expect(told).toEqual([PLAYER, PLAYER, PLAYER]);
    } finally {
      stop();
    }
  });

  it("tells the triggers that wait for the player from those that wait for another's actor", async () => {
    // Riften's north gate: RDSTriggerScript compares who entered with Game.GetPlayer.
    const gate = await playerTrigger(runtime, RDS01_TRIGGER);
    expect(gate?.names.has(DIALOGUE_RIFTEN_SS01)).toBe(true);
    // MQ101SetStage32 waits for the prisoners' cart horse (defaultSetStageTRIGSpecificActor).
    expect(await playerTrigger(runtime, 0x000f7b4d)).toBeUndefined();
  });

  it('plays a town scene that waits for the player once they walk into its trigger', async () => {
    // RDS01Scene begins with its quest (a start-game quest) and its first phase waits for the
    // quest's pGo, which stage 10's fragment sets as the player walks through the gate.
    const scene = (): number | undefined =>
      [...runtime.scenes.playing()].find((playing) => playing.scene === RDS01_SCENE)?.phase;
    const go = async (): Promise<unknown> =>
      runtime.vm.getVariable(new ObjectHandle(DIALOGUE_RIFTEN_SS01, 'quest'), '::pGo_var');
    expect(scene()).toBe(0);
    expect(await go()).toBe(0);
    runtime.triggered(RDS01_TRIGGER, PLAYER, true);
    for (let t = 0; t < 3; t += 0.1) {
      runtime.update(0.1, 0);
      await runtime.vm.idle();
    }
    runtime.triggered(RDS01_TRIGGER, PLAYER, false);
    expect(await go()).toBe(1);
    expect(runtime.state.quests.get(DIALOGUE_RIFTEN_SS01)?.stagesDone.has(10)).toBe(true);
    // Its first lines are said (silently here: Mjoll is not loaded), the phase moves on.
    expect(scene() ?? 0).toBeGreaterThan(0);
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

  it("gives a scene's quest, not one of its actions' packages", async () => {
    // MQ101Scene1's first PNAM is a package of an action; its quest is the last.
    const quest = await runtime.vm.call(new ObjectHandle(0x000becd4, 'Scene'), 'GetOwningQuest');
    expect(quest).toMatchObject({ formId: 0x0003372b, type: 'quest' });
  });
});
