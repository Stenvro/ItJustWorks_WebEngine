// Integration test: DLC2MQ01 "Dragonborn" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ105 = 0x242ba;
const DLC2MQ01 = 0x4017f8e;
const CULTIST_AMBUSH = 0x403546d;
/** The ambush's Cultist1, Cultist2 and Note aliases. */
const CULTIST_1 = 0;
const CULTIST_2 = 7;
const NOTE = 9;
/** DLC2MQ01's GjalundAlias. */
const GJALUND = 2;
const RIVERWOOD_MARKER = 0x162a4;
/** Where a patrol of Windhelm's docks starts (WindhelmDocksPatrolAStart). */
const WINDHELM_DOCKS = 0xa24cb;

const GOLD = 0xf;
const SOLSTHEIM = 0x4000800;
/** DLC2MQ01's WizardAlias (Neloth), DLC2TempleofMiraakMapMarker and the trigger on the
 * temple's steps (DLC2MQ01EndTriggerRef). */
const WIZARD = 5;
const TEMPLE_MARKER = 0x40143ca;
const END_TRIGGER = 0x401a548;
const DLC2MQ02 = 0x4017f8f;

/** The game with the cultists' orders read (DLC2MQ01 10). */
let ordersRead: Uint8Array | undefined;
/** The game on Raven Rock's docks (20), and with the temple on the map (30). */
let landed: Uint8Array | undefined;
let toTemple: Uint8Array | undefined;

/** A quest alias's reference. */
function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

/** An objective of DLC2MQ01 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(DLC2MQ01).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

describe.skipIf(!hasGamedata())('DLC2MQ01 Dragonborn', () => {
  // Once the Greybeards have named the player Dragonborn (MQ105 160), the next place the player
  // comes to off Solstheim has two of Miraak's cultists come for them (the Change Location event
  // starts DLC2CultistAmbush). Found 2026-11-18: their greeting has dialogue only for their voice
  // type, and a leveled actor's voice was read off the LVLN (none): they had nothing to say.
  // "Yes, I am Dragonborn": they attack (the ambush's 10), DLC2MQ01 starts at 5. One carries
  // their orders; read, they send the player to Solstheim (10).
  it('has cultists of Miraak ambush the player, and their orders send them on (5-10)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MQ105, 160);
      await sim.step(2);
      expect(sim.isRunning(CULTIST_AMBUSH)).toBe(false);
      await sim.fastTravel(RIVERWOOD_MARKER);
      await sim.step(2);
      expect(sim.isRunning(CULTIST_AMBUSH)).toBe(true);
      const one = alias(sim, CULTIST_AMBUSH, CULTIST_1);
      const two = alias(sim, CULTIST_AMBUSH, CULTIST_2);
      const note = alias(sim, CULTIST_AMBUSH, NOTE);
      const orders = (await sim.runtime.baseOf(note)) ?? 0;
      const topics = await sim.listen(undefined, 150);
      expect(topics).toEqual([
        'Yes, I am Dragonborn.',
        'The Greybeards seem to think so...',
        "I don't know what you're talking about.",
        '(Walk away)',
      ]);
      expect(sim.stage(CULTIST_AMBUSH)).toBeLessThan(10);
      await sim.choose(/I am Dragonborn/);
      sim.goodbye();
      expect(sim.stageDone(CULTIST_AMBUSH, 10)).toBe(true);
      expect(await sim.runtime.itemCount(one, orders)).toBe(1);
      expect(await sim.until(() => sim.stageDone(DLC2MQ01, 5), 5)).toBe(true);
      expect(objective(sim, 5)).toEqual({ displayed: true, completed: false });
      // They turn on the player as soon as they see them (Aggression 1, WEPlayerEnemy). Found
      // 2026-11-18: their aliases' factions (WEPlayerFriend, dunPrisonerFaction) came back as
      // soon as the stage took them out, and the cultists stayed the player's friends.
      const fighting = (): boolean =>
        [one, two].every((cultist) => sim.world.stage.combat.targetOf(cultist) === PLAYER_REF);
      expect(await sim.until(fighting, 10)).toBe(true);
      for (const cultist of [one, two]) await sim.kill(cultist, PLAYER_REF);
      await sim.step(1);
      const body = await sim.position(one);
      expect(body && (await sim.walkPath(body, 30, 120))).toBe(true);
      expect(await sim.take(one, orders)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(DLC2MQ01, 7)).toBe(true);
      expect(objective(sim, 7)).toEqual({ displayed: true, completed: false });
      expect(await sim.readFromInventory(orders)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(DLC2MQ01, 10)).toBe(true);
      expect(objective(sim, 7).completed).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: false });
      ordersRead = await sim.save('DLC2MQ01 10');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // To Windhelm's docks, where the cultists' ship lies. Gjalund will not go back ("something
  // wrong about that place") until the player pays double. Found 2026-11-18: his sailing
  // (DLC2DialogueRRQuestScript's SetSail, the line's fragment) waits for the conversation to end,
  // and the conversation waited for the fragment: neither went on. The boat ride (first person,
  // IdleDLC02BoatRide) ends on its clip's BoatRideFadeOut, which only the first-person graph
  // plays; and the script's fast travel to Solstheim was only noted headless. Off the boat on
  // Raven Rock's docks, the trigger there sets 20.
  it('has Gjalund take the player to Solstheim for double his fare (20)', async () => {
    if (!ordersRead) return;
    const sim = await loadSim(ordersRead);
    try {
      const gjalund = alias(sim, DLC2MQ01, GJALUND);
      await sim.fastTravel(WINDHELM_DOCKS);
      await sim.step(2);
      const at = await sim.position(gjalund);
      expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
      await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(GOLD), 1000, true);
      const purse = await sim.runtime.itemCount(PLAYER_REF, GOLD);
      expect(await sim.talk(gjalund)).toContain('I need passage to Solstheim.');
      await sim.choose(/passage to Solstheim/);
      await sim.choose(/captain of the Northern Maiden/);
      await sim.choose(/cultists who came here/);
      await sim.choose(/You sailed here/);
      expect(await sim.choose(/You're taking me to Solstheim/)).toContain(
        "I'll pay you double your usual rate. (Give 500 gold)",
      );
      expect(await sim.choose(/pay you double/)).toEqual([]);
      sim.goodbye();
      expect(await sim.until(() => sim.stageDone(DLC2MQ01, 20), 120)).toBe(true);
      await sim.step(1);
      expect(await sim.runtime.itemCount(PLAYER_REF, GOLD)).toBe(purse - 500);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(SOLSTHEIM);
      expect(objective(sim, 10).completed).toBe(true);
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: false });
      landed = await sim.save('DLC2MQ01 20');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Neloth has come down from Tel Mithryn to watch the townsfolk build at the Earth Stone. "I'm
  // looking for someone named Miraak." ... "What does that mean?": the temple, 30 (the Temple of
  // Miraak on the map).
  it('has Neloth send the player to the Temple of Miraak (30)', async () => {
    if (!landed) return;
    const sim = await loadSim(landed);
    try {
      const neloth = alias(sim, DLC2MQ01, WIZARD);
      const at = await sim.position(neloth);
      expect(at && (await sim.walkPath(at, 240, 150))).toBe(true);
      expect(await sim.talk(neloth)).toContain("I'm looking for someone named Miraak.");
      await sim.choose(/someone named Miraak/);
      expect(sim.stageDone(DLC2MQ01, 30)).toBe(false);
      await sim.choose(/What does that mean/);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(DLC2MQ01, 30)).toBe(true);
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: false });
      expect(sim.runtime.mapMarkerVisible(TEMPLE_MARKER)).toBe(true);
      toTemple = await sim.save('DLC2MQ01 30');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // To the temple, up its steps (DLC2MQ01EndTriggerRef): the quest is done (200), and The Temple
  // of Miraak begins (DLC2MQ02 10).
  it('has the player reach the Temple of Miraak (200)', async () => {
    if (!toTemple) return;
    const sim = await loadSim(toTemple);
    try {
      await sim.fastTravel(TEMPLE_MARKER);
      await sim.step(3);
      const steps = await sim.position(END_TRIGGER);
      expect(steps && (await sim.walkPath(steps, 120, 100))).toBe(true);
      expect(await sim.until(() => sim.stageDone(DLC2MQ01, 200), 5)).toBe(true);
      await sim.step(1);
      expect(sim.isRunning(DLC2MQ01)).toBe(false);
      expect(sim.stageDone(DLC2MQ02, 10)).toBe(true);
      expect(sim.isRunning(DLC2MQ02)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
