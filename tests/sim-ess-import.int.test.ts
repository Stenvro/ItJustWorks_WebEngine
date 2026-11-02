// An original save (.ess) from the user's own install, read and imported into a fresh
// simulation (docs/formats/ess.md). Skips without game data or without a save in
// Documents\My Games\Skyrim Special Edition\Saves; no save is ever in the repo.

import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readChangeForm } from '../src/formats/ess/change-forms.ts';
import { globalData, readEss, readEssHeader } from '../src/formats/ess/ess.ts';
import { refIdResolver } from '../src/formats/ess/global-data.ts';
import { readGlobalData } from '../src/formats/ess/global-data-tables.ts';
import { readPapyrus } from '../src/formats/ess/papyrus.ts';
import { essWorld, importEss } from '../src/save/ess-import.ts';
import { writeSave } from '../src/save/save-codec.ts';
import type { GameState } from '../src/scripting/runtime/game-state.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF } from './helpers/sim.ts';

const SAVES = join(homedir(), 'Documents', 'My Games', 'Skyrim Special Edition', 'Saves');

function firstSave(): string | undefined {
  try {
    const name = readdirSync(SAVES).find((file) => file.toLowerCase().endsWith('.ess'));
    return name === undefined ? undefined : join(SAVES, name);
  } catch {
    return undefined;
  }
}

const path = firstSave();

/**
 * A save the maintainer made at a known point (New Game, on the cart into Helgen): its name
 * starts with Save1_; SKYRIM_ESS names another file to check the same way.
 */
function knownSave(): string | undefined {
  if (process.env.SKYRIM_ESS) return process.env.SKYRIM_ESS;
  try {
    const name = readdirSync(SAVES).find((file) => /^Save1_.*\.ess$/i.test(file));
    return name === undefined ? undefined : join(SAVES, name);
  } catch {
    return undefined;
  }
}

const known = knownSave();
const MQ101 = 0x3372b;
const TAMRIEL = 0x3c;
const HIGH_ELF_RACE = 0x13743;
const HADVAR = 0x2bfa2;
const RALOF = 0x2bf9e;
/** MQ101HelgenArcher3REF, one of the archers fighting Alduin. */
const HELGEN_ARCHER = 0xe72b9;
/** How many of the placed living actors run the package the save has them on (of 16). */
const GOING_FLOOR = 16;
/** The two Imperial mages (dunCGImperialMageC01) fighting Alduin away from the player. */
const HELGEN_MAGES = [0xf3e78, 0xf3e7a];
/** MUSCombatBossChargen, the music MQ101 adds as Alduin attacks. */
const MUS_COMBAT_BOSS_CHARGEN = 0x1094aa;
/** Alduin over Helgen (MQ101). */
const ALDUIN_HELGEN = 0x32db7;

describe.skipIf(!hasGamedata() || known === undefined)('a known original save (local)', () => {
  it('reads every section and every change form to its end', () => {
    const ess = readEss(new Uint8Array(readFileSync(known ?? '')));
    const papyrus = readPapyrus(globalData(ess, 1001) ?? new Uint8Array(), true);
    expect(papyrus.unread).toBe(0);
    const resolve = refIdResolver(ess.formIds);
    // Every global data entry reads to its last byte.
    for (const entry of [...ess.globalData1, ...ess.globalData2, ...ess.globalData3]) {
      const read = readGlobalData(entry.type, entry.data, resolve);
      expect([entry.type, read?.unread]).toEqual([entry.type, 0]);
    }
    const stops = new Set<string>();
    let actorValues = 0;
    for (const entry of ess.changeForms) {
      const form = readChangeForm(entry, resolve);
      if (form.actor?.values) actorValues++;
      if (form.stoppedAt !== undefined) stops.add(`${String(entry.type)} ${form.stoppedAt}`);
    }
    // Every actor reads to its end, its movement controller's data and the player's own data
    // included.
    expect([...stops]).toEqual([]);
    expect(actorValues).toBe(ess.changeForms.filter((entry) => entry.type === 1).length);
    // Every actor with an AI process has it read by its layout (no search for what follows):
    // the package each runs, with a custom package's procedure states.
    let processes = 0;
    let running = 0;
    for (const entry of ess.changeForms) {
      if (entry.type !== 1) continue;
      const actor = readChangeForm(entry, resolve).actor;
      if (actor?.processLevel === -1) continue;
      expect(actor?.process).toBeDefined();
      processes++;
      if (actor?.process?.package) running++;
    }
    expect(processes).toBeGreaterThan(0);
    expect(running).toBeGreaterThan(0);
    const player = ess.changeForms.find((entry) => entry.formId === PLAYER_REF);
    const data = player ? readChangeForm(player, resolve).actor?.player : undefined;
    expect(data?.skills.length).toBe(18);
    // On the cart into Helgen the player sits in the first person camera, with the camera's
    // default fields of view.
    expect(data?.camera.state).toBe(0);
    expect(data?.camera.worldFov).toBe(80);
  });

  it("restores the player's place, items, quests, actor values, experience, updates", async () => {
    const ess = readEss(new Uint8Array(readFileSync(known ?? '')));
    const resolve = refIdResolver(ess.formIds);
    const playerEntry = ess.changeForms.find((entry) => entry.formId === PLAYER_REF);
    const quest = ess.changeForms.find((entry) => entry.formId === MQ101);
    if (!playerEntry || !quest) throw new Error('the save has no player or MQ101 change form');
    const playerForm = readChangeForm(playerEntry, resolve);
    const questForm = readChangeForm(quest, resolve);
    const done = (questForm.quest?.stages ?? []).filter((stage) => stage.done);
    const lastDone = Math.max(...done.map((stage) => stage.stage));

    const probe = await openSim();
    const world = await essWorld(probe.db, ess);
    await probe.close();
    const imported = importEss(ess, world, { name: 'Imported', number: 1, now: 0 });
    // The place: the player's own change form (moved in Tamriel).
    expect(playerForm.initial?.kind).toBe('moved');
    const moved = playerForm.initial?.kind === 'moved' ? playerForm.initial : undefined;
    expect(imported.save.player.world).toBe(TAMRIEL);
    expect(imported.save.player.position).toEqual(moved?.position);

    const bytes = await writeSave({
      header: imported.header,
      thumbnail: new Uint8Array(),
      body: imported.save,
    });
    const sim = await loadSim(bytes);
    try {
      const at = await sim.position(PLAYER_REF);
      const [x, y] = moved?.position ?? [0, 0];
      expect(Math.hypot((at?.[0] ?? 0) - x, (at?.[1] ?? 0) - y)).toBeLessThan(256);
      // MQ101: every stage the save marks done, and the highest of them as the current stage.
      for (const stage of done) expect(sim.stageDone(MQ101, stage.stage)).toBe(true);
      expect(sim.stage(MQ101)).toBe(lastDone);
      // The items the player gained.
      for (const entry of playerForm.inventory ?? []) {
        if (entry.delta > 0) {
          expect(await sim.runtime.itemCount(PLAYER_REF, entry.item)).toBeGreaterThanOrEqual(
            entry.delta,
          );
        }
      }
      // The actor values the save keeps (the skills' base values).
      const values = sim.runtime.state.actors.get(PLAYER_REF)?.values;
      for (const { av, value } of playerForm.actor?.values?.base ?? []) {
        expect(values?.get(av)?.base).toBe(value);
      }
      // The experience towards the next level, each skill's and the character's, and the
      // perks the player has.
      const progress = playerForm.actor?.player;
      expect(sim.runtime.state.playerExperience).toBe(progress?.xp);
      progress?.skills.forEach((skill, i) => {
        expect(sim.runtime.state.skillExperience.get(6 + i) ?? 0).toBe(skill.xp);
      });
      const perks = sim.runtime.state.actors.get(PLAYER_REF)?.perks;
      for (const { perk } of progress?.perks ?? []) {
        if (perk !== 0) expect(perks?.get(perk)).toBe(true);
      }
      // The OnUpdate and OnUpdateGameTime registrations go on, each from the time it had left.
      const papyrus = readPapyrus(globalData(ess, 1001) ?? new Uint8Array(), true);
      const registered =
        papyrus.registrations.updates.length + papyrus.registrations.gameTimeUpdates.length;
      expect(imported.save.runtime.updates.length).toBeGreaterThan(0);
      expect(imported.save.runtime.updates.length).toBeLessThanOrEqual(registered);
      for (const update of imported.save.runtime.updates) {
        expect(update.left).toBeGreaterThanOrEqual(0);
        if (!update.gameTime) expect(update.left).toBeLessThanOrEqual(update.interval);
      }
      // The running stacks (on the cart: the rider's OnAnimationEvent and an OnUpdate, each on
      // the native call its function message queued) go on where they were; the animation
      // event, sleep, tracked stats and inventory filter registrations are kept.
      expect(imported.save.runtime.threads?.length).toBe(
        papyrus.stackData.length + papyrus.suspendedStacks.flat().length,
      );
      const resumed = sim.world.terminal.lines.filter(
        (line) => line.tag === 'save' && line.text.includes('cannot resume'),
      );
      expect(resumed).toEqual([]);
      const runtimeSave = imported.save.runtime;
      expect((runtimeSave.animationEvents as Map<number, unknown>).size).toBe(
        papyrus.registrations.animationEvents.length,
      );
      expect((runtimeSave.inventoryFilters as Map<string, unknown>).size).toBeGreaterThan(0);
      expect((runtimeSave.registrations as Map<string, unknown>).has('sleep')).toBe(true);
      // The camera as the original left it: first person, its fields of view.
      expect(imported.save.world?.player).toEqual({ pov: 'first', fov: [80, 80] });
      // The actors' running packages, where the save has them stand: those of the loaded
      // area go on with them.
      const runs = imported.save.world?.actors.filter((actor) => actor.package) ?? [];
      expect(runs.length).toBeGreaterThan(0);
      // The actors' graphs as the save has them (CHANGE_REFR_ANIMATION, by names): each placed
      // one's variables hold the save's values (a real's bits or an integer's), the player's
      // body and first person graphs kept, the objects' too.
      const graphed = (imported.save.world?.actors ?? []).filter(
        (actor) => actor.graph && 'named' in actor.graph && sim.actor(actor.reference),
      );
      expect(graphed.length).toBeGreaterThan(5);
      let words = 0;
      let same = 0;
      const bits = new DataView(new ArrayBuffer(4));
      for (const saved of graphed) {
        const behavior = sim.actor(saved.reference)?.placed.behavior;
        const named = saved.graph && 'named' in saved.graph ? saved.graph.named : undefined;
        for (const [name, word] of named?.words ?? []) {
          const value = behavior?.variable(name);
          if (value === undefined) continue;
          words++;
          bits.setUint32(0, word, true);
          if (value === (word | 0) || value === bits.getFloat32(0, true)) same++;
        }
      }
      expect(words).toBeGreaterThan(1000);
      expect(same / words).toBeGreaterThan(0.95);
      expect(imported.save.world?.playerGraphs?.firstPerson).toBeDefined();
      expect(imported.skipped.filter((line) => /(REFR|ACHR): animation/.test(line))).toEqual([]);
      await sim.step(1);
      // What the actors held, put on them again from the save (their graphs raise no load).
      const held = (actor: number): string[] =>
        sim.world.stage.animObjects.held(actor).map((object) => object.editorId);
      expect(held(HADVAR)).toEqual(expect.arrayContaining(['AnimObjectLedger', 'AnimObjectQuill']));
      // And a save made now keeps them.
      const again = sim.world.runtime.world.saveWorld?.();
      expect(again?.animObjects?.filter((object) => object.actor === HADVAR).length).toBe(2);
      const going = runs.filter(
        (saved) =>
          sim.actor(saved.reference) !== undefined &&
          sim.package(saved.reference)?.id === saved.package?.id,
      );
      expect(going.length).toBeGreaterThan(0);
    } finally {
      await sim.close();
    }
  }, 300_000);
});

describe.skipIf(path === undefined)('every original save (local)', () => {
  it('reads every change form and global data entry to its end', () => {
    let names: string[] = [];
    try {
      names = readdirSync(SAVES).filter((file) => file.toLowerCase().endsWith('.ess'));
    } catch {
      // no saves folder
    }
    for (const name of names) {
      const ess = readEss(new Uint8Array(readFileSync(join(SAVES, name))));
      const resolve = refIdResolver(ess.formIds);
      for (const entry of ess.changeForms) {
        const form = readChangeForm(entry, resolve);
        expect([name, entry.formId, form.stoppedAt]).toEqual([name, entry.formId, undefined]);
      }
      // The combat table included (with combats running, its threats are combat objects).
      for (const entry of [...ess.globalData1, ...ess.globalData2, ...ess.globalData3]) {
        const read = readGlobalData(entry.type, entry.data, resolve);
        expect([name, entry.type, read?.unread]).toEqual([name, entry.type, 0]);
      }
    }
  });
});

describe.skipIf(!hasGamedata() || path === undefined)(
  'every original save, imported (local)',
  () => {
    it("imports the quest log, the quests' story events and the waiting events", async () => {
      let names: string[] = [];
      try {
        names = readdirSync(SAVES).filter((file) => file.toLowerCase().endsWith('.ess'));
      } catch {
        // no saves folder
      }
      const probe = await openSim();
      const saves = await Promise.all(
        names.map(async (name) => {
          const ess = readEss(new Uint8Array(readFileSync(join(SAVES, name))));
          return { name, ess, world: await essWorld(probe.db, ess) };
        }),
      );
      await probe.close();
      for (const { name, ess, world } of saves) {
        const resolve = refIdResolver(ess.formIds);
        const imported = importEss(ess, world, { name: 'Imported', number: 1, now: 0 });
        const state = imported.save.runtime.state as {
          quests: Map<number, { log: { stage: number; entry: number }[]; event?: unknown }>;
        };
        const player = ess.changeForms.find((entry) => entry.formId === PLAYER_REF);
        const data = player ? readChangeForm(player, resolve).actor?.player : undefined;
        // Each quest log entry, oldest first per quest.
        for (const entry of [...(data?.questLog ?? [])].reverse()) {
          expect(state.quests.get(entry.quest)?.log).toContainEqual({
            stage: entry.stage,
            entry: entry.flags,
          });
        }
        // The quests a story event started keep its data.
        for (const entry of ess.changeForms) {
          if (entry.type !== 8) continue;
          const event = readChangeForm(entry, resolve).quest?.event;
          const quest = state.quests.get(entry.formId ?? 0);
          if (event) expect([name, quest?.event]).not.toEqual([name, undefined]);
        }
        // The factions' reactions as they stand (modifier and combat reaction to each other).
        const factions = (
          imported.save.runtime.state as {
            factions: Map<
              number,
              { reactions: Map<number, number>; reactionModifiers: Map<number, number> }
            >;
          }
        ).factions;
        for (const entry of ess.changeForms) {
          if (entry.type !== 31) continue;
          for (const { faction, modifier, reaction } of readChangeForm(entry, resolve).faction
            ?.reactions ?? []) {
            const ours = factions.get(entry.formId ?? 0);
            expect([ours?.reactions.get(faction), ours?.reactionModifiers.get(faction)]).toEqual([
              reaction,
              modifier,
            ]);
          }
        }
        // The events the story manager had not processed yet (none in the saves read).
        const sem = readGlobalData(111, globalData(ess, 111) ?? new Uint8Array(), resolve);
        const waiting = (sem?.value as { events: unknown[] } | undefined)?.events.length ?? 0;
        const pending = (imported.save.runtime.storyManager as { pending?: unknown[] } | undefined)
          ?.pending;
        expect(pending?.length ?? 0).toBe(waiting);
        // The missiles and flame sprays in flight fly on (with their graphs by names), not as
        // references of their projectiles standing still.
        const created = (imported.save.runtime.state as { created: Map<number, unknown> }).created;
        const flying = ess.changeForms.filter((entry) => entry.type === 2 || entry.type === 5);
        expect(imported.save.world.projectiles?.length ?? 0).toBe(flying.length);
        for (const entry of flying) expect(created.has(entry.formId ?? 0)).toBe(false);
        for (const projectile of imported.save.world.projectiles ?? []) {
          expect(projectile.graph?.named?.sequences.length).toBe(1);
          expect(projectile.age).toBeGreaterThan(0);
        }
        // The dead counts by actor base (global data 2): GetDeadCount answers them.
        const tes = readGlobalData(2, globalData(ess, 2) ?? new Uint8Array(), resolve);
        const deadCounts = (imported.save.runtime.state as { deadCounts: Map<number, number> })
          .deadCounts;
        for (const { base, count } of (
          tes?.value as { deadCounts: { base: number; count: number }[] } | undefined
        )?.deadCounts ?? []) {
          expect([base, deadCounts.get(base)]).toEqual([base, count]);
        }
        // The quest nodes' runs (SMQN): a run for each quest the node started, in game days
        // within the game's time so far.
        const runs = (
          imported.save.runtime.storyManager as { lastStarted?: Map<number, number> } | undefined
        )?.lastStarted;
        const nodes = ess.changeForms.filter((entry) => entry.type === 36);
        if (nodes.length > 0) expect(runs?.size ?? 0).toBeGreaterThan(0);
        for (const days of runs?.values() ?? []) {
          expect(days).toBeGreaterThan(0);
          expect(days).toBeLessThanOrEqual(imported.save.runtime.state.gameDaysPassed as number);
        }
        // Each member of a combat group knows what its group knew of its target.
        for (const actor of imported.save.world.actors) {
          if (actor.fight?.known) expect(actor.combatTarget).toBeDefined();
        }
      }
    }, 300_000);
  },
);

describe.skipIf(!hasGamedata() || path === undefined)('an original save (local)', () => {
  it('reads its header and change forms, and loads into a simulation', async () => {
    const ess = readEss(new Uint8Array(readFileSync(path ?? '')));
    expect(ess.header.version).toBe(12);
    expect(ess.changeForms.length).toBe(ess.locations.changeFormCount);

    const probe = await openSim();
    const world = await essWorld(probe.db, ess);
    await probe.close();
    const imported = importEss(ess, world, { name: 'Imported', number: 1, now: 0 });
    const bytes = await writeSave({
      header: imported.header,
      thumbnail: new Uint8Array(),
      body: imported.save,
    });
    const sim = await loadSim(bytes);
    try {
      expect(sim.runtime.state.actors.get(PLAYER_REF)?.level).toBe(ess.header.playerLevel);
      const at = await sim.position(PLAYER_REF);
      const expected = imported.save.player.position;
      expect(Math.hypot((at?.[0] ?? 0) - expected[0], (at?.[1] ?? 0) - expected[1])).toBeLessThan(
        256,
      );
    } finally {
      await sim.close();
    }
  }, 300_000);
});

/**
 * The maintainer's save played on into the opening (its player is a High Elf,
 * up to Helgen Keep); SKYRIM_ESS_OPENING names another file to check the same way.
 */
function openingSave(): string | undefined {
  if (process.env.SKYRIM_ESS_OPENING) return process.env.SKYRIM_ESS_OPENING;
  try {
    for (const name of readdirSync(SAVES)) {
      if (!name.toLowerCase().endsWith('.ess')) continue;
      const file = join(SAVES, name);
      if (readEssHeader(new Uint8Array(readFileSync(file))).header.playerRace === 'HighElfRace') {
        return file;
      }
    }
  } catch {
    // no saves folder
  }
  return undefined;
}

const opening = openingSave();

describe.skipIf(!hasGamedata() || opening === undefined)('the opening, imported (local)', () => {
  it("resumes MQ101 at its stages with its dead, its references and its actors' packages", async () => {
    const ess = readEss(new Uint8Array(readFileSync(opening ?? '')));
    const resolve = refIdResolver(ess.formIds);
    const forms = ess.changeForms.map((entry) => readChangeForm(entry, resolve));
    const probe = await openSim();
    const world = await essWorld(probe.db, ess);
    await probe.close();
    const imported = importEss(ess, world, { name: 'Imported', number: 1, now: 0 });
    // The actors the save keeps at their records' places run their packages there too.
    expect(imported.skipped.some((line) => line.includes('place is not known'))).toBe(false);
    // The sky MQ101 forces (an override), the boss music its script added as Alduin attacks.
    expect(imported.save.sky?.override).toBe(imported.save.weather);
    expect(imported.save.music).toEqual([MUS_COMBAT_BOSS_CHARGEN]);
    const bytes = await writeSave({
      header: imported.header,
      thumbnail: new Uint8Array(),
      body: imported.save,
    });
    const sim = await loadSim(bytes);
    try {
      // MQ101 at the stages the save has done.
      const quest = forms.find((form) => form.formId === MQ101)?.quest;
      const done = (quest?.stages ?? []).filter((stage) => stage.done).map((s) => s.stage);
      expect(done.length).toBeGreaterThan(0);
      for (const stage of done) expect(sim.stageDone(MQ101, stage)).toBe(true);
      // The dead (the executed prisoners, those the dragon killed) are dead; the restrained
      // restrained.
      const dead = forms.filter((form) => form.type === 1 && form.actor?.stateBits?.[4] === 2);
      expect(dead.length).toBeGreaterThan(0);
      for (const form of dead) {
        expect([form.formId, await sim.runtime.actors.isDead(form.formId)]).toEqual([
          form.formId,
          true,
        ]);
      }
      // References enabled and disabled as the save has them.
      for (const form of forms) {
        if (form.type !== 0 || form.formFlags === undefined || form.formId >>> 24 === 0xff) {
          continue;
        }
        const enabled = (form.formFlags & 0x800) === 0;
        expect([form.formId, await sim.runtime.isEnabled(form.formId)]).toEqual([
          form.formId,
          enabled,
        ]);
      }
      // The player: a High Elf with the face the race menu gave them.
      const appearance = sim.runtime.state.playerAppearance;
      expect(appearance?.race).toBe(HIGH_ELF_RACE);
      expect(appearance?.headParts.length).toBeGreaterThan(0);
      expect(appearance?.tints.length).toBeGreaterThan(0);
      // The help the player has done is not shown again; the music and the sky as saved.
      expect([...sim.runtime.state.helpDone]).toEqual(expect.arrayContaining(['look', 'forward']));
      expect(sim.runtime.world.addedMusic?.()).toEqual([MUS_COMBAT_BOSS_CHARGEN]);
      expect(sim.runtime.world.currentWeather?.()).toBe(imported.save.weather);
      // Alduin's burns: in the world's decal store, kept by a save made now (a view without
      // drawn shapes builds none, so all wait for what they lie on).
      const decals = sim.runtime.world.saveWorld?.().decals ?? [];
      expect(decals.length).toBe(imported.save.world?.decals?.length);
      expect(decals.every((decal) => decal.left !== undefined && decal.left > 0)).toBe(true);
      // What the player wears as the save has it (its inventory's Worn extra data).
      const worn = imported.save.worn?.find(([actor]) => actor === PLAYER_REF)?.[1] ?? [];
      expect(worn.length).toBeGreaterThan(0);
      for (const [item] of worn) {
        expect([item, await sim.runtime.equipment.isEquipped(PLAYER_REF, item)]).toEqual([
          item,
          true,
        ]);
      }
      // The actors placed around the player run the packages the save has them run (as
      // GetCurrentPackage answers: a fighter's combat override package, a scene's package done
      // while its action runs), a second on: the packages go on from the branch they had reached,
      // so Alduin's strafe, saved half done, ends a little later and his flight grab follows.
      await sim.step(1);
      // The dead run none.
      let placed = 0;
      const going: number[] = [];
      for (const saved of imported.save.world?.actors ?? []) {
        if (!saved.package || sim.actor(saved.reference) === undefined) continue;
        if (await sim.runtime.actors.isDead(saved.reference)) continue;
        placed++;
        if (sim.runtime.currentPackage(saved.reference) === saved.package.id) {
          going.push(saved.reference);
        }
      }
      expect(placed).toBeGreaterThan(10);
      // Hadvar on his way to the keep, Ralof at its marker and Alduin's strafe (the scenes'
      // packages), the wounded in the road, the archers and mages fighting Alduin on their combat
      // override package (DefaultHoldPositionLinkedRef128): the two mages beyond the fighters'
      // reach of the player take their fight up too, as the original keeps them fighting.
      expect(going).toEqual(
        expect.arrayContaining([HADVAR, RALOF, ALDUIN_HELGEN, HELGEN_ARCHER, ...HELGEN_MAGES]),
      );
      expect(going.length).toBeGreaterThanOrEqual(GOING_FLOOR);
    } finally {
      await sim.close();
    }
  }, 600_000);
});

/** MQ101StormcloakPrisoner01Ref, beheaded at the block; the head the body wears then. */
const BEHEADED_PRISONER = 0x654ed;
const DECAPITATED_HEAD = 0xdb5d0;
/** ElenwenREF riding MQ101ElenwenHorse beside the carts. */
const ELENWEN = 0x198bc;
const ELENWEN_HORSE = 0x527f1;
/** The Helgen soldier with three arrows stuck in it as the opening is saved. */
const STUCK = 0x32db7;
/** SteelArrow, what the opening's archers shoot. */
const STEEL_ARROW = 0x1397f;
/** AnimObjectLedger, Hadvar's as the cart comes in. */
const LEDGER = 0xeb058;
/** DecalFlameBurn01, Alduin's fire on Helgen. */
const FLAME_BURN = 0x2b95a;

describe.skipIf(!hasGamedata() || known === undefined || opening === undefined)(
  "the procedures' states and the extra data, imported (local)",
  () => {
    it('puts riders on horses and patrols on their points; keeps cut limbs, arrows, fights', async () => {
      const probe = await openSim();
      try {
        const cart = readEss(new Uint8Array(readFileSync(known ?? '')));
        const onCart = importEss(cart, await essWorld(probe.db, cart), {
          name: 'Cart',
          number: 1,
          now: 0,
        });
        const actors = onCart.save.world?.actors ?? [];
        expect(actors.find((actor) => actor.reference === ELENWEN)?.riding).toBe(ELENWEN_HORSE);
        // The patrols going on to the point each was at or going to.
        expect(actors.filter((actor) => actor.package?.goal !== undefined).length).toBeGreaterThan(
          5,
        );
        expect(onCart.skipped.filter((line) => /Interaction|procedures' own/.test(line))).toEqual(
          [],
        );

        const helgen = readEss(new Uint8Array(readFileSync(opening ?? '')));
        const imported = importEss(helgen, await essWorld(probe.db, helgen), {
          name: 'Helgen',
          number: 1,
          now: 0,
        });
        // The game state as the import made it (its live maps: gameStateData).
        const state = imported.save.runtime.state as unknown as GameState;
        // The beheaded prisoner keeps its head off, with what it wore then (the head among it).
        const limbs = state.actors.get(BEHEADED_PRISONER)?.dismembered;
        expect(limbs?.[0]?.limb).toBe(1);
        expect(limbs?.[0]?.worn).toContain(DECAPITATED_HEAD);
        // The arrows lying round Helgen: references of their ammunition.
        const arrows = [...state.created.values()].filter((made) => made.base === STEEL_ARROW);
        expect(arrows.length).toBeGreaterThanOrEqual(15);
        // The six fighting Alduin by their combat group.
        const fighting = (imported.save.world?.actors ?? []).filter(
          (actor) => actor.combatTarget === ALDUIN_HELGEN,
        );
        expect(fighting.length).toBeGreaterThanOrEqual(6);
        // The three arrows stuck in a soldier: on its bones, oldest first, for seconds now.
        const stuck = imported.save.world?.attachedArrows ?? [];
        expect(stuck.length).toBe(3);
        expect(stuck.map((arrow) => arrow.target)).toEqual([STUCK, STUCK, STUCK]);
        expect(stuck[0]?.age).toBeGreaterThan(stuck[1]?.age ?? 0);
        expect(stuck[0]?.age).toBeLessThan(60);
        expect(stuck[0]?.local.length).toBe(16);
        // What the actors on the cart hold (cuffs, Hadvar's ledger and quill, the axe), shown.
        const held = onCart.save.world?.animObjects ?? [];
        expect(held.length).toBe(9);
        expect(held).toContainEqual({ actor: HADVAR, animObject: LEDGER, shown: true });
        // Alduin's burns on Helgen, on the rubble, the roads and the land of three cells.
        const decals = imported.save.world?.decals ?? [];
        expect(decals.length).toBeGreaterThan(20);
        expect(decals.filter((decal) => decal.textureSet === FLAME_BURN).length).toBeGreaterThan(
          20,
        );
        expect(decals.filter((decal) => 'cell' in decal.on).length).toBeGreaterThanOrEqual(4);
        expect(
          imported.skipped.filter((line) =>
            /DismemberedLimbs|CannotWear|NonActorMagicTarget|AttachedArrows3D|PARW|temp effects|anim objects|global data (?:101|107|1000|1002)(?!\d)/.test(
              line,
            ),
          ),
        ).toEqual([]);
      } finally {
        await probe.close();
      }
    }, 300_000);
  },
);
