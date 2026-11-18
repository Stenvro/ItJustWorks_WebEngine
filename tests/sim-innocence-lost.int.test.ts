// Integration test: DB01 "Innocence Lost" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { WeaponState } from '../src/gameplay/combat/combat-state.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, SIM_STEP, type Sim } from './helpers/sim.ts';

const DB01 = 0x1ea50;
/** DB01's AventusAretinoAlias and GrelodTheKindAlias. */
const AVENTUS = 0;
const GRELOD = 1;
/** Windhelm's Palace of the Kings map marker; the Aretino Residence's door from the street,
 * the house and its door back out. */
const WINDHELM_MARKER = 0xc44b3;
const ARETINO_DOOR = 0x16966;
const ARETINO_RESIDENCE = 0x16784;
const ARETINO_EXIT = 0x1680e;
/** Riften's map marker, Honorhall Orphanage's door from the street, the orphanage and its door
 * back out. */
const RIFTEN_MARKER = 0x1c390;
const HONORHALL_DOOR = 0x4227a;
const HONORHALL = 0x16bd3;
const HONORHALL_EXIT = 0x16cee;
/** Lockpicks and an iron dagger: what a played game has by now (TODO(M13): a played game's
 * pack). */
const LOCKPICK = 0xa;
const IRON_DAGGER = 0x1397e;

/** The game with Aventus's contract taken (stage 20). */
let afterAventus: Uint8Array | undefined;
/** The game with Grelod dead (stage 30). */
let afterGrelod: Uint8Array | undefined;

/** A quest alias's reference. */
function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

/** An objective of DB01 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(DB01).objectives.get(id);
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

/** The player walks to a reference and goes through it (a load door) into a cell. */
async function through(sim: Sim, door: number, cell: number | undefined): Promise<void> {
  const at = await sim.position(door);
  expect(at && (await sim.walkPath(at, 180, 120))).toBe(true);
  expect(sim.activate(door)).toBe(true);
  await sim.world.settle();
  await sim.step(1);
  if (cell !== undefined) expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(cell);
}

describe.skipIf(!hasGamedata())('DB01 Innocence Lost', () => {
  // DB01 runs from the game's start. In Windhelm, the Aretino Residence is locked; picked, the
  // boy inside is found at his Black Sacrament, and he takes the player for the Dark Brotherhood's
  // assassin he called ("Are you all right?"): Grelod the Kind, Honorhall's headmistress, is to
  // die (20).
  it('has Aventus take the player for the assassin he called (20)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      expect(sim.isRunning(DB01)).toBe(true);
      await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(LOCKPICK), 20, true);
      await sim.fastTravel(WINDHELM_MARKER, false);
      await sim.step(2);
      const door = await sim.position(ARETINO_DOOR);
      expect(door && (await sim.walkPath(door, 180, 120))).toBe(true);
      expect(await sim.pickLock(ARETINO_DOOR)).toBe('opened');
      expect(sim.activate(ARETINO_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(ARETINO_RESIDENCE);
      const aventus = alias(sim, DB01, AVENTUS);
      const at = await sim.position(aventus);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      // "Yes, of course... The Black Sacrament...", then "Contract?": his mother dead, Grelod's
      // orphanage, the Sacrament performed.
      expect(
        await sim.converse(aventus, [/Are you all right/, /Black Sacrament/, /Contract/]),
      ).toContainEqual(expect.stringMatching(/Assassinations don't come cheap/));
      expect(sim.stageDone(DB01, 20)).toBe(true);
      expect(objective(sim, 20).displayed).toBe(true);
      afterAventus = await sim.save('DB01 20');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // To Riften and Honorhall Orphanage, where Grelod falls to the player's dagger (30: "Tell
  // Aventus Aretino that Grelod is dead").
  it('has the player kill Grelod the Kind in Honorhall (30)', async () => {
    if (!afterAventus) return;
    const sim = await loadSim(afterAventus);
    try {
      await sim.runtime.addItem(PLAYER_REF, sim.runtime.formHandle(IRON_DAGGER), 1, true);
      expect(await sim.equip(IRON_DAGGER)).toBe(true);
      await through(sim, ARETINO_EXIT, undefined);
      await sim.fastTravel(RIFTEN_MARKER, false);
      await sim.step(2);
      await through(sim, HONORHALL_DOOR, HONORHALL);
      const grelod = alias(sim, DB01, GRELOD);
      await draw(sim);
      for (let swing = 0; swing < 40 && !sim.actor(grelod)?.dead; swing++) {
        const at = await sim.position(grelod);
        if (at) await sim.walkPath(at, 10, 100);
        await sim.swingAt(grelod, 90);
      }
      expect(sim.actor(grelod)?.dead).toBe(true);
      // Her death sets 30; its fragment shows the next objective as it runs.
      expect(await sim.until(() => objective(sim, 30).displayed, 10)).toBe(true);
      expect(sim.stageDone(DB01, 30)).toBe(true);
      expect(objective(sim, 20).completed).toBe(true);
      afterGrelod = await sim.save('DB01 30');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Back to Windhelm: Aventus pays with a family heirloom (200), and the quest ends.
  it('has Aventus reward the player for Grelod (200)', async () => {
    if (!afterGrelod) return;
    const sim = await loadSim(afterGrelod);
    try {
      await through(sim, HONORHALL_EXIT, undefined);
      await sim.fastTravel(WINDHELM_MARKER, false);
      await sim.step(2);
      await through(sim, ARETINO_DOOR, ARETINO_RESIDENCE);
      const aventus = alias(sim, DB01, AVENTUS);
      const at = await sim.position(aventus);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      // His greeting ("Well? Grelod the Kind. Is she... you know?") goes on to his thanks and the
      // heirloom (the info's fragment: 200).
      const since = sim.itemsMoved().length;
      await sim.converse(aventus);
      expect(await sim.until(() => sim.stageDone(DB01, 200), 20)).toBe(true);
      expect(
        sim
          .itemsMoved()
          .slice(since)
          .some((moved) => moved.to === PLAYER_REF && moved.count === 1),
      ).toBe(true);
      expect(await sim.until(() => !sim.isRunning(DB01), 20)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
