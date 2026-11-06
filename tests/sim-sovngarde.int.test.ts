// Integration test: MQ304 "Sovngarde" on the headless simulation, played through as the player plays
// it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { ActorValue } from '../src/world/actor-values.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, SIM_STEP, type Sim } from './helpers/sim.ts';

type Vec3 = [number, number, number];

const MQ303 = 0x46ef0;
const MQ304 = 0x46ef1;
const MQ305 = 0x46ef2;
/** Sovngarde's worldspace, the grid cell the portal lets out in and the spot (MQ303's trigger). */
const SOVNGARDE = 0x2ee41;
const PORTAL_CELL: readonly [number, number] = [14, 13];
const PORTAL_SPOT: Vec3 = [58957, 56777, 11657];
/** The triggers down the valley, each with its stage (MQ304SetStage*; the first has no name). */
const VALLEY: readonly (readonly [number, number])[] = [
  [0x4e9ca, 20],
  [0x4e9c8, 30],
  [0x923fc, 60],
  [0xe9979, 75],
  [0xe997e, 85],
  [0xea302, 95],
  [0x97535, 130],
];
/** MQ304's aliases. */
const ALDUIN = 0;
const LOST_SOUL = 1;
const TSUN = 4;
const YSGRAMOR = 19;
/** The door to the Hall of Valor, the hall, and the trigger before the heroes (MQ304SetStage180). */
const HALL_DOOR = 0x4f7f7;
const HALL = 0x95c44;
const HEROES_TRIGGER = 0xec3a7;

/** The game at the bridge's end of the valley (stage 130). */
let atTheBridge: Uint8Array | undefined;
/** The game in the Hall of Valor (stage 160). */
let inTheHall: Uint8Array | undefined;

/** A quest alias's reference. */
function alias(sim: Sim, id: number): number {
  return sim.runtime.state.quest(MQ304).aliases.get(id) ?? 0;
}

/** An objective of MQ304 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(MQ304).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

/**
 * Those fighting the player fall to the player's blows (TODO(M13): the player's own blows, where
 * the fight is not what the segment tests).
 */
async function fendOff(sim: Sim): Promise<void> {
  for (const staged of sim.actors()) {
    const actor = staged.reference;
    if (actor === PLAYER_REF || staged.dead) continue;
    if (sim.world.stage.combat.targetOf(actor) === PLAYER_REF) await sim.kill(actor, PLAYER_REF);
  }
}

/** The player makes their way to a point, what comes at them falling as they go (fendOff). */
async function walkFighting(
  sim: Sim,
  target: readonly [number, number, number],
  seconds: number,
  reach = 200,
): Promise<boolean> {
  const until = sim.time + seconds;
  while (until - sim.time >= SIM_STEP / 2) {
    const started = sim.time;
    const there = await sim.walkPath(
      [target[0], target[1], target[2]],
      Math.min(5, until - sim.time),
      reach,
    );
    await fendOff(sim);
    if (there) return true;
    if (sim.time - started < SIM_STEP / 2) await sim.step(0.5);
  }
  return false;
}

describe.skipIf(!hasGamedata())('MQ304 Sovngarde', () => {
  // MQ304's own start for a game that skips ahead: its stage 0 sets 1, which plays MQ303 to 300
  // (played in sim-world-eaters-eyrie, up to the portal), whose 300 is this quest's 10. The skip
  // does not take the player through the portal: they are put where it lets out. Down the valley
  // the triggers bring Alduin over (his patrols as the stages turn); the lost soul runs ahead.
  it('has the player go down the valley to the bridge (0-130)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      void sim.runtime.quests.setStage(MQ304, 0);
      expect(await sim.until(() => sim.stageDone(MQ304, 10), 120)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ303, 300), 120)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: false });
      await sim.openExterior(SOVNGARDE, PORTAL_CELL);
      await sim.moveTo(PORTAL_SPOT);
      await sim.step(3);
      const alduin = alias(sim, ALDUIN);
      expect(await sim.enabled(alduin)).toBe(true);
      expect(await sim.enabled(alias(sim, LOST_SOUL))).toBe(true);
      for (const [trigger, stage] of VALLEY) {
        const at = await sim.position(trigger);
        expect(at && (await walkFighting(sim, at, 90, 100)), `to ${String(stage)}`).toBe(true);
        expect(await sim.until(() => sim.stageDone(MQ304, stage), 3), `stage ${String(stage)}`).toBe(
          true,
        );
      }
      await sim.step(1);
      expect(lines).toContain('MQ304LostSoulScene1: phase 0 completes');
      // He flies his rounds as the stages send him (Patrol, Orbit), never away from the valley.
      expect(sim.world.stage.flight.isFlying(alduin)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      atTheBridge = await sim.save('MQ304 130');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Tsun greets them at the whalebone bridge (135 as they ask for the hall): "Can I enter the Hall of
  // Valor?" is 140. Below half of his health (MQ304TsunScript's OnUpdate looks), he lets them by (150,
  // MQ304TsunDefeatScene). A blow of the player's lands; the rest of the fight, which a first level's
  // fists do not win, stands in as a blow of theirs. Over the bridge, the door to the Hall of Valor
  // (the trigger inside: 160).
  it('has Tsun test the player at the bridge, and let them into the hall (135-160)', async () => {
    if (!atTheBridge) return;
    const sim = await loadSim(atTheBridge);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const tsun = alias(sim, TSUN);
      const near = await sim.position(tsun);
      expect(near && (await walkFighting(sim, near, 30, 400))).toBe(true);
      expect(await sim.listen(tsun, 60)).toContain('I seek entrance to the Hall of Valor.');
      await sim.choose(/entrance to the Hall of Valor/);
      expect(sim.stageDone(MQ304, 135)).toBe(true);
      await sim.choose(/By the right of birth/);
      expect(sim.stageDone(MQ304, 140)).toBe(false);
      await sim.choose(/Can I enter the Hall of Valor/);
      sim.goodbye();
      expect(sim.stageDone(MQ304, 140)).toBe(true);
      await sim.step(2);
      const before = (await sim.runtime.actors.value(tsun, ActorValue.health)).current;
      await sim.attack(0.1);
      let landed = sim.events('hit').some((hit) => hit.target === tsun);
      for (let swing = 0; swing < 6 && !landed; swing++) {
        ({ landed } = await sim.swingAt(tsun, 80));
      }
      expect(landed).toBe(true);
      const left = (await sim.runtime.actors.value(tsun, ActorValue.health)).current;
      expect(left).toBeLessThan(before);
      expect(sim.stageDone(MQ304, 150)).toBe(false);
      await sim.runtime.actors.damage(tsun, ActorValue.health, left - before * 0.4, PLAYER_REF);
      expect(await sim.until(() => sim.stageDone(MQ304, 150), 5)).toBe(true);
      expect(await sim.until(() => lines.includes('MQ304TsunDefeatScene: #2 said'), 15)).toBe(true);
      expect(await sim.runtime.actors.isDead(tsun)).toBe(false);
      await sim.step(8);
      expect(await sim.distance(tsun, PLAYER_REF)).toBeGreaterThan(0);
      const door = await sim.position(HALL_DOOR);
      expect(door && (await walkFighting(sim, door, 60, 150))).toBe(true);
      expect(sim.activate(HALL_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(2);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(HALL);
      expect(await sim.until(() => sim.stageDone(MQ304, 160), 5)).toBe(true);
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: false });
      inTheHall = await sim.save('MQ304 160');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // In the hall Ysgramor speaks to the player as they come up (170); by the three heroes the
  // trigger is 180, and MQ304HallofValorScene has them speak and take up the cause: its end is 200,
  // MQ305's 10.
  it('has Ysgramor welcome the player, and the three heroes join them (170-200)', async () => {
    if (!inTheHall) return;
    const sim = await loadSim(inTheHall);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const ysgramor = alias(sim, YSGRAMOR);
      const at = await sim.position(ysgramor);
      expect(at && (await walkFighting(sim, at, 40, 300))).toBe(true);
      expect(await sim.listen(ysgramor, 20)).toBeDefined();
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(MQ304, 170)).toBe(true);
      const heroes = await sim.position(HEROES_TRIGGER);
      expect(heroes && (await walkFighting(sim, heroes, 40, 100))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ304, 180), 5)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ304, 200), 120)).toBe(true);
      await sim.step(1);
      expect(lines.some((line) => line.startsWith('MQ304HallofValorScene: #20 '))).toBe(true);
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: true });
      expect(sim.stage(MQ305)).toBe(10);
      expect(sim.isRunning(MQ305)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
