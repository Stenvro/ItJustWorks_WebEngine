// Integration test: DB02 "With Friends Like These..." on the headless simulation, played through
// as the player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { WeaponState } from '../src/gameplay/combat/combat-state.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, SIM_STEP, type Sim } from './helpers/sim.ts';

const DB01 = 0x1ea50;
const DB02 = 0x1ea51;
const DB02A = 0x22f47;
const DB_ENTRANCE = 0x50f2e;
/** DB02's three captives' aliases. */
const CAPTIVES = [4, 5, 6] as const;
/** AstridRef. */
const ASTRID_REF = 0x1bde8;
/** DB02a's Nazir alias. */
const NAZIR = 4;
/** The first set of side contracts (DBSideContract01, 02 and 03). */
const SET_1 = [0x1ea5b, 0x1ea5e, 0x1ea5f] as const;
/** The Abandoned Shack's room, and its door out. */
const SHACK = 0x50f1e;
const SHACK_EXIT = 0x50f28;
/** The Sanctuary's map marker, its Black Door (the activator that asks the question), and the
 * Sanctuary inside. */
const SANCTUARY_MARKER = 0x1c3b0;
const BLACK_DOOR = 0x2b83b;
const SANCTUARY = 0xad5a1;
/** An iron dagger: what a played game has by now (TODO(M13): a played game's pack). */
const IRON_DAGGER = 0x1397e;
/** RiverwoodMapMarker. */
const RIVERWOOD_MARKER = 0x162a4;

/** The game with the player woken in the Abandoned Shack (DBEntranceQuest's sleep). */
let afterShack: Uint8Array | undefined;
/** The game with a captive killed (DB02 40). */
let afterCaptive: Uint8Array | undefined;
/** The game with the player welcomed into the Family (DB02 200). */
let afterWelcome: Uint8Array | undefined;

/** A quest alias's reference. */
function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

/** An objective of a quest as the journal shows it. */
function objective(
  sim: Sim,
  quest: number,
  id: number,
): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(quest).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

/** The player draws what is in their hands (Ready Weapon), and waits for it to be out. */
async function draw(sim: Sim): Promise<void> {
  if (sim.world.stage.combat.weaponState(PLAYER_REF) === WeaponState.drawn) return;
  sim.press('Ready Weapon', true);
  await sim.step(SIM_STEP);
  sim.press('Ready Weapon', false);
  await sim.step(1.5);
}

describe.skipIf(!hasGamedata())('DB02 With Friends Like These...', () => {
  // Innocence Lost done (DB01 200, skipped to here), the player leaves Windhelm: the Dark
  // Brotherhood's watch sets DBEntranceQuest 20 (a courier's letter, "We know", and a sleep
  // registered). They sleep; they wake in the Abandoned Shack, Astrid before them.
  it('has the player wake in the Abandoned Shack after a sleep', async () => {
    const sim = await openSim({ hour: 20 });
    try {
      await sim.fastTravel(RIVERWOOD_MARKER, false);
      // Its fragment waits a few seconds before the quest stops: the world steps meanwhile.
      void sim.runtime.quests.setStage(DB01, 200);
      expect(await sim.until(() => sim.stageDone(DB_ENTRANCE, 20), 120)).toBe(true);
      // Its fragment moves Astrid to the shack and registers for the sleep; a while on, the
      // player sleeps.
      await sim.step(10);
      await sim.rest(8, true);
      await sim.step(5);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(SHACK);
      expect((await sim.runtime.placement(ASTRID_REF))?.cell).toBe(SHACK);
      afterShack = await sim.save('DB02 shack');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Astrid talks: kill one of the three captives (10); one dies to the player's dagger (40).
  it('has Astrid set the player to kill one of the captives (10-40)', async () => {
    if (!afterShack) return;
    const sim = await loadSim(afterShack);
    try {
      const astrid = ASTRID_REF;
      // Her force greet as the player wakes, and the talk that leads to the captives.
      expect(await sim.listen(astrid, 30)).toContainEqual(expect.stringMatching(/Where am I/));
      await sim.choose(/Where am I/);
      await sim.choose(/You know about that/);
      await sim.choose(/A problem/);
      await sim.choose(/murder someone else/);
      await sim.choose(/I'll kill one of them/);
      expect(sim.stageDone(DB02, 10)).toBe(true);
      expect(objective(sim, DB02, 10).displayed).toBe(true);
      // The first captive, Fultheim, falls to the player's dagger.
      await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(IRON_DAGGER), 1, true);
      expect(await sim.equip(IRON_DAGGER)).toBe(true);
      await draw(sim);
      const captive = alias(sim, DB02, CAPTIVES[0]);
      for (let swing = 0; swing < 30 && !sim.actor(captive)?.dead; swing++) {
        const at = await sim.position(captive);
        if (at) await sim.walkPath(at, 10, 100);
        await sim.swingAt(captive, 90);
      }
      expect(sim.actor(captive)?.dead).toBe(true);
      // Restrained, he died where he knelt, in the shack.
      expect((await sim.runtime.placement(captive))?.cell).toBe(SHACK);
      expect(await sim.until(() => objective(sim, DB02, 30).displayed, 10)).toBe(true);
      expect(sim.stageDone(DB02, 30)).toBe(true);
      // "So who was it? Who had the contract?" "So... I'm free to go?": the Sanctuary, near
      // Falkreath, and its passphrase (40).
      expect(await sim.talk(astrid)).toContainEqual(expect.stringMatching(/Who had the contract/));
      await sim.choose(/Who had the contract/);
      await sim.choose(/free to go/);
      expect(sim.stageDone(DB02, 40)).toBe(true);
      expect(objective(sim, DB02, 40).displayed).toBe(true);
      afterCaptive = await sim.save('DB02 40');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Out of the shack and to the Sanctuary in Falkreath's pine forest. The Black Door asks
  // "What is the music of life?"; "Silence, my brother." opens it, and the player is welcomed
  // home (50). Astrid waits inside: the Family's newest member (200), and Nazir's contracts
  // to come (DB02a).
  it('has the Black Door take the passphrase and Astrid welcome the player (50-200)', async () => {
    if (!afterCaptive) return;
    const sim = await loadSim(afterCaptive);
    try {
      expect(sim.activate(SHACK_EXIT)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      await sim.fastTravel(SANCTUARY_MARKER, false);
      await sim.step(2);
      const door = await sim.position(BLACK_DOOR);
      expect(door && (await sim.walkPath(door, 120, 150))).toBe(true);
      // The door is a talking activator: activated, it asks its question.
      const topics = await sim.talk(BLACK_DOOR);
      expect(topics).toContainEqual(expect.stringMatching(/Silence, my brother/));
      await sim.choose(/Silence, my brother/);
      expect(await sim.until(() => sim.stageDone(DB02, 50), 20)).toBe(true);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(SANCTUARY);
      expect(objective(sim, DB02, 50).displayed).toBe(true);
      // Astrid, inside: "So what happens now?" "I am honored to be a part of your Family,
      // Astrid." (200; Sanctuary begins: speak with Nazir).
      await sim.step(2);
      const at = await sim.position(ASTRID_REF);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      expect(await sim.talk(ASTRID_REF)).toContainEqual(expect.stringMatching(/what happens now/));
      expect(await sim.choose(/what happens now/)).toContainEqual(
        expect.stringMatching(/honored to be a part/),
      );
      await sim.choose(/honored to be a part/);
      expect(await sim.until(() => sim.stageDone(DB02, 200), 10)).toBe(true);
      expect(await sim.until(() => sim.stageDone(DB02A, 10), 10)).toBe(true);
      expect(objective(sim, DB02A, 10).displayed).toBe(true);
      afterWelcome = await sim.save('DB02 200');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Sanctuary (DB02a): Nazir, in the Sanctuary, has the first set of contracts (20), and the
  // quest ends (200).
  it('has Nazir give the player the first contracts (Sanctuary 10-200)', async () => {
    if (!afterWelcome) return;
    const sim = await loadSim(afterWelcome);
    try {
      const nazir = alias(sim, DB02A, NAZIR);
      const at = await sim.position(nazir);
      expect(at && (await sim.walkPath(at, 90, 150))).toBe(true);
      expect(await sim.talk(nazir)).toContainEqual(expect.stringMatching(/pleasure to meet you/));
      await sim.choose(/pleasure to meet you/);
      await sim.choose(/some work for me/);
      expect(await sim.choose(/Sounds simple enough/)).toContainEqual(
        expect.stringMatching(/first set of contracts/),
      );
      // The first three: Beitild, Ennodius and Narfi (their side contracts begin).
      expect(await sim.choose(/first set of contracts/)).toEqual(
        expect.arrayContaining([
          'Tell me about Beitild.',
          'Tell me about Ennodius.',
          'Tell me about Narfi.',
        ]),
      );
      expect(sim.stageDone(DB02A, 20)).toBe(true);
      expect(sim.stageDone(DB02A, 200)).toBe(true);
      for (const contract of SET_1) expect(sim.isRunning(contract)).toBe(true);
      // Its fragment waits before the quest stops.
      expect(await sim.until(() => !sim.isRunning(DB02A), 20)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
