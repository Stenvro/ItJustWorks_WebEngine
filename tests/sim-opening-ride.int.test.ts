// Integration test: MQ101 "Unbound" played from a new game in the headless simulation, as the
// player plays it, to the keep. The cart ride: the horses walk their patrols to Helgen
// (src/ai/procedure-runs.ts), the carts follow them and carry their riders and the player
// (src/shell/actor-vehicles.ts). Riders off, the roll call and the player's turn with the race
// menu (the simulation's menus close it with the defaults), the block, Alduin's arrival; the
// player gets up (stage 160: the HUD leaves CartMode), follows Ralof into the tower and up it,
// jumps through the inn's roof, drops through its floor, follows Hadvar to the keep and goes in
// with him. Each case starts from the save the one before took. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { rideModes, rideState } from '../src/shell/hud-elements.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

type Vec3 = [number, number, number];

const MQ101 = 0x3372b;
/** MQ101DragonAttack: the town under Alduin's attack (the tower, the inn, the way to the keep). */
const DRAGON_ATTACK = 0xd0593;
/** MQ101Cart1HorseREF and the second cart's horse, the one the player rides behind. */
const HORSES = [0xb9df2, 0xbb971] as const;
/** The player's cart (pulled by the second horse). */
const PLAYER_CART = 0xbb970;
/** RalofRef and HadvarRef. */
const RALOF = 0x2bf9e;
const HADVAR = 0x2bfa2;
/** Up the tower: MQ101DASetStage25 (the stairs' foot), 35 (half way), MQ101DragonSetStage40. */
const TOWER_STAIRS: readonly Vec3[] = [
  [14777, -82934, 8426],
  [14595, -83403, 8872],
  [14798, -83426, 8999],
];
/** Where Alduin broke the tower's wall (dunCGTowerHole01REF), facing the inn. */
const TOWER_HOLE: Vec3 = [15085, -83265, 8890];
/** Over the inn's broken roof, east of the hole. */
const INN_ROOF: Vec3 = [15400, -83300, 8760];
/** The inn's upper floor (dunCGSetStage120's box), and on along it to the gap in its floor. */
const INN_UPPER_FLOOR: Vec3 = [15800, -83613, 8760];
const INN_FLOOR_GAP: readonly Vec3[] = [
  [16800, -83611, 8700],
  [17200, -83611, 8700],
];
/** The keep's door by Hadvar (dunCGObjectiveKeepDoorHadvarREF marks it), from the courtyard. */
const KEEP_DOOR_HADVAR = 0x91a00;
const BY_KEEP_DOOR: Vec3 = [14760, -79100, 8203];
/** MQ101SetStage210, inside the keep's door by Hadvar. */
const IN_KEEP_HADVAR: Vec3 = [1664, 6720, 512];

/** The player keeps by an actor: walks the way to them while farther than `reach`. */
async function follow(sim: Sim, actor: number, reach = 180): Promise<void> {
  const at = await sim.position(actor);
  const [x, y] = sim.world.player.feet;
  if (at && Math.hypot(at[0] - x, at[1] - y) > reach && (await sim.walkPath(at, 2, reach - 30)))
    return;
  await sim.step(1);
}

/** The player turns to a point and jumps towards it (Forward held through the jump). */
async function jumpTowards(sim: Sim, [x, y]: Vec3): Promise<void> {
  const feet = sim.world.player.feet;
  // Yaw 0 looks along +Y; it turns clockwise.
  sim.world.look(Math.atan2(x - feet[0], y - feet[1]));
  sim.press('Forward', true);
  sim.press('Jump', true);
  await sim.step(0.2);
  sim.press('Jump', false);
  await sim.step(1);
  sim.press('Forward', false);
}

describe.skipIf(!hasGamedata())('MQ101 from a new game (simulation)', () => {
  /** The game as each case left it. */
  let ridersOff: Uint8Array | undefined;
  let upAtTheBlock: Uint8Array | undefined;
  let inTheInn: Uint8Array | undefined;

  // Found 2026-10-28: the simulation never gave its carts up to the vehicles (the viewers do), so
  // the carts stood where they were placed, the player on one, while the horses walked off alone,
  // and turned back as they left the player's high process: MQ101 stayed at stage 15 for good.
  it('rides to Helgen’s gate behind the walking horses, then off the cart to the roll call (stage 15 to 80)', async () => {
    const sim = await openSim({ opening: true, gridRadius: 1 });
    try {
      await sim.openAtPlayer();
      expect(await sim.until(() => sim.stageDone(MQ101, 15), 20)).toBe(true);
      let gliding = 0;
      let behind = 0;
      const last = new Map<number, readonly [number, number, number]>();
      for (let second = 0; second < 300 && !sim.stageDone(MQ101, 20); second++) {
        await sim.step(1);
        for (const horse of HORSES) {
          const actor = sim.actor(horse);
          const at = actor?.position;
          const before = last.get(horse);
          if (at) last.set(horse, [at[0], at[1], at[2]]);
          // A horse that goes plays its walk (its graph's Speed), it does not glide.
          const moved = at && before ? Math.hypot(at[0] - before[0], at[1] - before[1]) : 0;
          if (moved > 40 && (actor?.placed.behavior?.variable('Speed') ?? 0) < 1) gliding++;
        }
        // The player rides their cart, behind its horse (about 200 units from the cart's origin).
        const player = sim.world.player.feet;
        const horse = sim.actor(HORSES[1])?.position;
        if (horse && Math.hypot(player[0] - horse[0], player[1] - horse[1]) > 600) behind++;
      }
      expect(sim.stageDone(MQ101, 20)).toBe(true);
      expect(sim.world.stage.vehicles.vehicleOf(PLAYER_REF)).toBe(PLAYER_CART);
      expect(gliding).toBeLessThanOrEqual(2);
      expect(behind).toBe(0);
      // Into the town square, the riders off (stage 54: the player's cart unloads), the roll call;
      // at the player's turn MQ101Scene4 sets 75, whose fragment opens the race menu (closed
      // here with the defaults), and 80 takes the player into line.
      expect(await sim.until(() => sim.stageDone(MQ101, 80), 330)).toBe(true);
      expect(sim.stageDone(MQ101, 54)).toBe(true);
      expect(sim.stageDone(MQ101, 75)).toBe(true);
      expect(sim.menus().filter((menu) => menu.menu === 'RaceSex Menu')).toHaveLength(1);
      expect(sim.world.stage.vehicles.vehicleOf(PLAYER_REF)).toBeUndefined();
      // The cart's HUD stays until the player gets up at the block.
      expect(rideModes(rideState(sim.runtime)).cart).toBe(true);
      ridersOff = await sim.save();
    } finally {
      await sim.close();
    }
  }, 1_200_000);

  it('walks to the block; Alduin comes; the player gets up, the HUD and the controls back (stage 80 to 160)', async () => {
    expect(ridersOff).toBeDefined();
    if (!ridersOff) return;
    const sim = await loadSim(ridersOff);
    try {
      expect(await sim.until(() => sim.stageDone(MQ101, 160), 300)).toBe(true);
      // The first prisoner beheaded, the player to the block (95), Alduin's arrival (100).
      for (const stage of [85, 90, 95, 100, 120, 130, 150])
        expect(sim.stageDone(MQ101, stage)).toBe(true);
      // Stage 160 (observed in the original's fragment): SetRestrained(False), the movement,
      // looking, sneaking and journal controls back (fighting, the camera switch, the menus and
      // activation stay off until the keep), SetHudCartMode(False). (Its fragment runs on as
      // the world steps.)
      const offTheCart = (): boolean => !rideModes(rideState(sim.runtime)).cart;
      expect(await sim.until(offTheCart, 2)).toBe(true);
      expect(rideModes(rideState(sim.runtime)).horse).toBeUndefined();
      expect(sim.runtime.state.actor(PLAYER_REF).restrained ?? false).toBe(false);
      const controls = sim.runtime.controls;
      expect([
        controls.movement,
        controls.looking,
        controls.sneaking,
        controls.journalTabs,
      ]).toEqual([true, true, true, true]);
      expect([controls.fighting, controls.camSwitch, controls.menu, controls.activate]).toEqual([
        false,
        false,
        false,
        false,
      ]);
      upAtTheBlock = await sim.save();
    } finally {
      await sim.close();
    }
  }, 600_000);

  it('follows Ralof into the tower and up it, and jumps through the inn’s roof (dragon attack 20 to 120)', async () => {
    expect(upAtTheBlock).toBeDefined();
    if (!upAtTheBlock) return;
    const sim = await loadSim(upAtTheBlock);
    try {
      // Ralof runs for the tower and waits by its door (MQ101DragonAttackScene1 waits for the
      // player's trigger, 20); in, he stops by Ulfric (22).
      for (let second = 0; second < 90 && !sim.stageDone(DRAGON_ATTACK, 22); second++) {
        await follow(sim, RALOF);
      }
      expect(sim.stageDone(DRAGON_ATTACK, 20)).toBe(true);
      expect(sim.stageDone(DRAGON_ATTACK, 22)).toBe(true);
      // Up the stairs (25, 35) to where the wall gives (40): Alduin breaks it (103, 105), and
      // Ralof comes up to send the player on through the inn's roof (110).
      for (const step of TOWER_STAIRS) expect(await sim.walkPath(step, 30, 40)).toBe(true);
      expect(sim.stageDone(DRAGON_ATTACK, 40)).toBe(true);
      expect(await sim.until(() => sim.stageDone(DRAGON_ATTACK, 110), 90)).toBe(true);
      expect(await sim.walkPath(TOWER_HOLE, 30, 40)).toBe(true);
      // Out through the hole, straight on (east, the way the inn lies), then along its floor.
      const out: Vec3 = [INN_ROOF[0], sim.world.player.feet[1], INN_ROOF[2]];
      await jumpTowards(sim, out);
      await sim.walkTo(out, 3, 40);
      await sim.walkTo(INN_UPPER_FLOOR, 4, 40);
      expect(await sim.until(() => sim.stageDone(DRAGON_ATTACK, 120), 5)).toBe(true);
      // In the inn, on its upper floor (not on the ground below the tower).
      expect(sim.world.player.feet[2]).toBeGreaterThan(8600);
      // The square's trigger the dragon attack enables as it begins set itself up in its
      // OnLoad (its quest's script), so it tells the quest the player passed through.
      const square = sim.problems().filter(({ text }) => text.includes('PlayerInSquare'));
      expect(square).toEqual([]);
      inTheInn = await sim.save();
    } finally {
      await sim.close();
    }
  }, 600_000);

  it('drops through the inn’s floor, follows Hadvar to the keep and goes in with him (to stage 250)', async () => {
    expect(inTheInn).toBeDefined();
    if (!inTheInn) return;
    const sim = await loadSim(inTheInn);
    try {
      for (const step of INN_FLOOR_GAP) await sim.walkTo(step, 4, 40);
      // Out of the inn (130) Hadvar takes the player along (151 ... 192); by the keep (195)
      // MQ101DragonAttackSceneDToKeep sets the objective to go in with Hadvar or Ralof.
      for (let second = 0; second < 240 && !sim.stageDone(DRAGON_ATTACK, 195); second++) {
        await follow(sim, HADVAR);
      }
      for (const stage of [130, 151, 160, 170, 195]) {
        expect(sim.stageDone(DRAGON_ATTACK, stage)).toBe(true);
      }
      expect(sim.stageDone(MQ101, 180)).toBe(true);
      expect(await sim.walkPath(BY_KEEP_DOOR, 60, 60)).toBe(true);
      expect(sim.activate(KEEP_DOOR_HADVAR)).toBe(true);
      // Through the door into the keep; its trigger sets 210 (FactionPath 1: Hadvar), which sets
      // 200 (the dragon attack over) and 250 (the keep's route).
      expect(await sim.until(() => sim.world.loadedCells.length === 1, 10)).toBe(true);
      await sim.walkPath(IN_KEEP_HADVAR, 10, 60);
      expect(await sim.until(() => sim.stageDone(MQ101, 250), 20)).toBe(true);
      expect(sim.stageDone(MQ101, 210)).toBe(true);
      expect(sim.stageDone(DRAGON_ATTACK, 200)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
