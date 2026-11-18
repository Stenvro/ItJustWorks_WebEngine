// Integration test: DB03 "Mourning Never Comes" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.
//
// Where it stops (2026-11-18): Alain Dufont in Raldbthar (stage 20 on). Fast travel to Raldbthar's
// map marker [00090595] puts the player at its arrival marker [00090596], 580 units under the
// land there (landscape -2752, marker -3331), and they fall through the world.
// TODO(M13): where the original puts the player whose arrival marker lies under the land.

import { describe, expect, it } from 'vitest';
import { WeaponState } from '../src/gameplay/combat/combat-state.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, SIM_STEP, type Sim } from './helpers/sim.ts';

const DB03 = 0x1ea52;
const DB02A = 0x22f47;
/** The DarkBrotherhood quest (the line's dialogue and its watch) and CiceroArrivalScene. */
const DARK_BROTHERHOOD = 0x1ea5c;
const CICERO_ARRIVAL = 0x23df3;
/** DB02a's Nazir alias; Contract: Kill Narfi, Narfi (NarfiRef), Ivarstead's map marker. */
const NAZIR = 4;
const NARFI_CONTRACT = 0x1ea5b;
const NARFI = 0x19e24;
const IVARSTEAD_MARKER = 0x17791;
/** AstridRef, and DB03's Muiri alias. */
const ASTRID = 0x1bde8;
const MUIRI = 1;
/** The Sanctuary, its door out, its map marker and its Black Door from outside. */
const SANCTUARY = 0xad5a1;
const SANCTUARY_EXIT = 0x25bff;
const SANCTUARY_MARKER = 0x1c3b0;
const SANCTUARY_DOOR = 0x25c00;
/** Markarth's palace map marker, the Hag's Cure's door from the street and the shop. */
const MARKARTH_MARKER = 0xc44af;
const HAGS_CURE_DOOR = 0x16e48;
const HAGS_CURE = 0x16df6;
/** A steel sword: what a played game has by now (TODO(M13): a played game's pack). */
const STEEL_SWORD = 0x13989;

/** The game with Narfi dead (the first contract). */
let afterNarfi: Uint8Array | undefined;
/** The game with Astrid's contract taken (stage 10). */
let afterAstrid: Uint8Array | undefined;

/** A quest alias's reference. */
function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

/** An objective of DB03 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(DB03).objectives.get(id);
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

/** The player walks to a load door and goes through it into a cell (or outside). */
async function through(sim: Sim, door: number, cell: number | undefined): Promise<void> {
  const at = await sim.position(door);
  expect(at && (await sim.walkPath(at, 180, 120))).toBe(true);
  expect(sim.activate(door)).toBe(true);
  await sim.world.settle();
  await sim.step(1);
  if (cell !== undefined) expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(cell);
}

describe.skipIf(!hasGamedata())('DB03 Mourning Never Comes', () => {
  // Sanctuary's own start for a game that skips ahead (DB02a's stage 0 sets With Friends Like
  // These done). Nazir's first contracts; the first of them, Narfi the beggar of Ivarstead, falls
  // to the player's sword (Contract: Kill Narfi 20, and the Family's first kill counted). The
  // DarkBrotherhood quest's watch then has Cicero arrive with the Night Mother.
  it('has the player kill Narfi, the first contract', async () => {
    const sim = await openSim({ interior: SANCTUARY, hour: 10 });
    try {
      void sim.runtime.quests.setStage(DB02A, 0);
      expect(await sim.until(() => sim.stageDone(DB02A, 10), 30)).toBe(true);
      const nazir = alias(sim, DB02A, NAZIR);
      const at = await sim.position(nazir);
      expect(at && (await sim.walkPath(at, 90, 150))).toBe(true);
      await sim.converse(nazir, [
        /pleasure to meet you/,
        /some work for me/,
        /Sounds simple enough/,
        /first set of contracts/,
      ]);
      expect(sim.stage(NARFI_CONTRACT)).toBe(10);
      await through(sim, SANCTUARY_EXIT, undefined);
      await sim.fastTravel(IVARSTEAD_MARKER, false);
      await sim.step(2);
      await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(STEEL_SWORD), 1, true);
      expect(await sim.equip(STEEL_SWORD)).toBe(true);
      await draw(sim);
      for (let swing = 0; swing < 30 && !sim.actor(NARFI)?.dead; swing++) {
        const there = await sim.position(NARFI);
        if (there) await sim.walkPath(there, 20, 100);
        await sim.swingAt(NARFI, 100);
      }
      expect(sim.actor(NARFI)?.dead).toBe(true);
      expect(await sim.until(() => sim.stageDone(NARFI_CONTRACT, 20), 10)).toBe(true);
      // The watch (every few seconds) sees the first kill: Cicero arrives.
      const brotherhood = sim.runtime.formHandle(DARK_BROTHERHOOD);
      expect(await sim.runtime.vm.getVariable(brotherhood, '::FirstKill_var')).toBe(1);
      await sim.step(10);
      expect(await sim.runtime.vm.getVariable(brotherhood, '::CiceroArrive_var')).toBe(1);
      afterNarfi = await sim.save('DB03 Narfi');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Back in the Sanctuary: walking in (DBCiceroArriveTrigScript's trigger) the player finds the
  // Family arguing over Cicero (CiceroArrivalScene; none of them talks to the player meanwhile).
  // Then Astrid's blocking greeting: "Do you have a contract for me?" Muiri, at the Hag's Cure in
  // Markarth (10).
  it('has Astrid give the player the contract (10)', async () => {
    if (!afterNarfi) return;
    const sim = await loadSim(afterNarfi);
    try {
      await sim.fastTravel(SANCTUARY_MARKER, false);
      await sim.step(2);
      await through(sim, SANCTUARY_DOOR, SANCTUARY);
      const at = await sim.position(ASTRID);
      expect(at && (await sim.walkPath(at, 90, 150))).toBe(true);
      expect(await sim.until(() => sim.runtime.scenes.isPlaying(CICERO_ARRIVAL), 20)).toBe(true);
      expect(await sim.until(() => !sim.runtime.scenes.isPlaying(CICERO_ARRIVAL), 300)).toBe(true);
      const near = await sim.position(ASTRID);
      expect(near && (await sim.walkPath(near, 30, 150))).toBe(true);
      expect(await sim.talk(ASTRID)).toEqual(['Do you have a contract for me?']);
      // Muiri in Markarth; "Anything else?": be professional, and keep the payment (10).
      expect(await sim.choose(/contract for me/)).toEqual(['Anything else?']);
      expect(sim.stageDone(DB03, 10)).toBe(false);
      await sim.choose(/Anything else/);
      expect(sim.stageDone(DB03, 10)).toBe(true);
      expect(objective(sim, 10).displayed).toBe(true);
      afterAstrid = await sim.save('DB03 10');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // To Markarth and the Hag's Cure: Muiri, told the Dark Brotherhood has come, names Alain
  // Dufont, holed up in Raldbthar (20).
  it('has Muiri name Alain Dufont (20)', async () => {
    if (!afterAstrid) return;
    const sim = await loadSim(afterAstrid);
    try {
      await through(sim, SANCTUARY_EXIT, undefined);
      await sim.fastTravel(MARKARTH_MARKER, false);
      await sim.step(2);
      await through(sim, HAGS_CURE_DOOR, HAGS_CURE);
      const muiri = alias(sim, DB03, MUIRI);
      const at = await sim.position(muiri);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      expect(await sim.talk(muiri)).toEqual(['The Dark Brotherhood has come, Muiri.']);
      await sim.choose(/Brotherhood has come/);
      await sim.choose(/Now tell me what you need/);
      await sim.choose(/need more to go on/);
      await sim.choose(/It will be done/);
      await sim.choose(/I'm listening/);
      expect(sim.stageDone(DB03, 20)).toBe(true);
      expect(objective(sim, 20).displayed).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
