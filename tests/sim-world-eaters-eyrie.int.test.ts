// Integration test: MQ303 "The World-Eater's Eyrie" on the headless simulation, played through as the
// player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { ObjectHandle } from '../src/scripting/values.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, SIM_STEP, type Sim } from './helpers/sim.ts';

const MQ301 = 0x44c56;
const MQ303 = 0x46ef0;
const MQ304 = 0x46ef1;
/** MQ303's aliases: Odahviing, the soldier at the trap's lever. */
const ODAHVIING = 1;
const GATEKEEPER = 2;
/** WhiterunDragonsreach, its door to the porch, the porch's worldspace. */
const DRAGONSREACH = 0x165a3;
const PORCH_DOOR = 0x46b84;
const DRAGONSREACH_WORLD = 0x46033;
/** Where Odahviing sets the player down (MQ303SkuldafnStartMarker). */
const SKULDAFN_START = 0x4de49;
/** The door to the temple from the mountain, its two cells, the door between them, the way out. */
const TEMPLE_DOOR = 0x27b92;
const TEMPLE_01 = 0xa0877;
const TEMPLE_02 = 0xa73f4;
const TO_LOWER_HALLS = 0xa73f7;
const TEMPLE_WAY_OUT = 0xa7465;
/** The first pillars (dunSkuldafnPuzzlePillar*), each with the state that solves it, its lever. */
const FIRST_PILLARS: readonly (readonly [number, string, string])[] = [
  [0xab229, 'dunskuldafnpuzzlepillar01script', 'position02'],
  [0xab228, 'dunskuldafnpuzzlepillar01script', 'position03'],
  [0xab223, 'dunskuldafnpuzzlepillartwostage', 'position02'],
];
const FIRST_LEVER = 0xab22b;
const FIRST_CONTROL = new ObjectHandle(FIRST_LEVER, 'dunskuldafnpuzzlecontrolscript');
/** The second (defaultPuzzlePillarNoFurn), its lever. */
const SECOND_PILLARS: readonly (readonly [number, string, string])[] = [
  [0xa7597, 'defaultpuzzlepillarnofurn', 'position02'],
  [0xa7593, 'defaultpuzzlepillarnofurn', 'position01'],
  [0xa7596, 'defaultpuzzlepillarnofurn', 'position03'],
];
const SECOND_LEVER = 0xf13b2;
const SECOND_CONTROL = new ObjectHandle(SECOND_LEVER, 'defaultpillarpuzzlelevernofurn');
/** The great door: its rings with their solved states, its keyhole; the claw's holder's alias. */
const RINGS: readonly (readonly [number, string])[] = [
  [0xab36d, 'position01'],
  [0xab36e, 'position03'],
  [0xab36f, 'position02'],
];
const KEYHOLE = 0xab36c;
const CLAW_HOLDER = 15;
/** The trigger of 180 (MQ303SetStage180), the priest's alias, the portal's seal and door. */
const TOP_TRIGGER = 0x13b63;
const PRIEST = 3;
const PORTAL_SEAL = 0xe6c68;
const PORTAL = 0xe2d48;
const SOVNGARDE = 0x2ee41;

/** The game with Odahviing told he will be set free (stage 20). */
let promised: Uint8Array | undefined;
/** The game with Odahviing ready to fly (stage 45). */
let readyToFly: Uint8Array | undefined;
/** The game at Skuldafn (stage 100). */
let atSkuldafn: Uint8Array | undefined;
/** The game in the temple's lower halls. */
let inLowerHalls: Uint8Array | undefined;
/** The game out on the mountain top (stage 160). */
let outOnTop: Uint8Array | undefined;

/** A quest alias's reference. */
function alias(sim: Sim, id: number): number {
  return sim.runtime.state.quest(MQ303).aliases.get(id) ?? 0;
}

/** An objective of MQ303 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(MQ303).objectives.get(id);
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

/** To a pillar, and it is turned until it shows what solves it. */
async function turnPillar(sim: Sim, pillar: number, script: string, solved: string): Promise<void> {
  const at = await sim.position(pillar);
  expect(at && (await walkFighting(sim, at, 90, 180))).toBe(true);
  const handle = new ObjectHandle(pillar, script);
  for (let turn = 0; turn < 4; turn++) {
    if ((await sim.runtime.vm.stateOf(handle)).toLowerCase() === solved) break;
    expect(sim.activate(pillar)).toBe(true);
    await sim.step(3);
  }
  expect((await sim.runtime.vm.stateOf(handle)).toLowerCase()).toBe(solved);
}

describe.skipIf(!hasGamedata())("MQ303 The World-Eater's Eyrie", () => {
  // MQ303's own start for a game that skips ahead: its stage 0 sets 1, which plays MQ301 to its 220
  // (played in sim-the-fallen, with Odahviing in the trap) and that is this quest's 10. The player
  // tells him they will set him free (20).
  it('has the player promise Odahviing his freedom (0-20)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MQ303, 0);
      expect(await sim.until(() => sim.stageDone(MQ303, 15), 120)).toBe(true);
      await sim.step(30);
      expect(sim.stageDone(MQ301, 220)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: false });
      await sim.openInterior(DRAGONSREACH);
      await sim.step(2);
      const door = await sim.position(PORCH_DOOR);
      expect(door && (await sim.walkPath(door, 60, 120))).toBe(true);
      expect(sim.activate(PORCH_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(2);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(DRAGONSREACH_WORLD);
      const odahviing = alias(sim, ODAHVIING);
      const at = await sim.position(odahviing);
      expect(at && (await sim.walkPath(at, 30, 500))).toBe(true);
      expect(await sim.talk(odahviing)).toContain('We need to talk.');
      await sim.choose(/We need to talk/);
      await sim.choose(/set you free if you promise/);
      sim.goodbye();
      await sim.step(1);
      expect(sim.stageDone(MQ303, 20)).toBe(true);
      promised = await sim.save('MQ303 20');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Up on the wall the soldier at the lever: "Open the trap." "Yes, I'm sure." is 30, and he works
  // it (MQ303OpenGateScene: 40). Odahviing walks out (45).
  it('has the soldier open the trap and Odahviing walk free (30-45)', async () => {
    if (!promised) return;
    const sim = await loadSim(promised);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const gatekeeper = alias(sim, GATEKEEPER);
      const at = await sim.position(gatekeeper);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      expect(await sim.talk(gatekeeper)).toContain('Open the trap.');
      await sim.choose(/Open the trap/);
      await sim.choose(/Yes, I'm sure/);
      sim.goodbye();
      expect(sim.stageDone(MQ303, 30)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ303, 40), 60)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: false });
      expect(await sim.until(() => sim.stageDone(MQ303, 45), 60)).toBe(true);
      readyToFly = await sim.save('MQ303 45');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // "I'm ready. Take me to Skuldafn." is 50, and the player mounts (55); the flight is the scene's
  // to the end of its lines (60: MoveTo with the dismount), and it sets them down at the trigger
  // of 100 on the mountainside.
  it('has Odahviing carry the player to Skuldafn (50-100)', async () => {
    if (!readyToFly) return;
    const sim = await loadSim(readyToFly);
    try {
      const odahviing = alias(sim, ODAHVIING);
      const at = await sim.position(odahviing);
      expect(at && (await sim.walkPath(at, 30, 500))).toBe(true);
      expect(await sim.talk(odahviing)).toContain("You didn't escape.");
      await sim.choose(/You didn't escape/);
      await sim.choose(/Take me to Skuldafn/);
      sim.goodbye();
      expect(sim.stageDone(MQ303, 50)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: false });
      expect(await sim.until(() => sim.stageDone(MQ303, 55), 30)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ303, 100), 60)).toBe(true);
      await sim.step(1);
      expect(sim.stageDone(MQ303, 60)).toBe(true);
      expect(sim.stageDone(MQ301, 240)).toBe(true);
      expect(await sim.distance(PLAYER_REF, SKULDAFN_START)).toBeLessThan(300);
      atSkuldafn = await sim.save('MQ303 100');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Up the mountain, through what comes at them, to the temple. In it two pillar puzzles (each pillar
  // turned to its own symbol, then the lever): the first lifts the portcullis on the way on, the
  // second puts out the bridge to the door to the lower halls.
  it("has the player solve the temple's pillars (Skuldafn01)", async () => {
    if (!atSkuldafn) return;
    const sim = await loadSim(atSkuldafn);
    try {
      const door = await sim.position(TEMPLE_DOOR);
      expect(door && (await walkFighting(sim, door, 240))).toBe(true);
      expect(sim.activate(TEMPLE_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(2);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(TEMPLE_01);
      for (const [pillar, script, solved] of FIRST_PILLARS) {
        await turnPillar(sim, pillar, script, solved);
      }
      const lever = await sim.position(FIRST_LEVER);
      expect(lever && (await walkFighting(sim, lever, 60, 180))).toBe(true);
      expect(sim.activate(FIRST_LEVER)).toBe(true);
      await sim.step(8);
      expect(await sim.runtime.vm.getVariable(FIRST_CONTROL, '::puzzleSolved_var')).toBe(true);
      for (const [pillar, script, solved] of SECOND_PILLARS) {
        await turnPillar(sim, pillar, script, solved);
      }
      const second = await sim.position(SECOND_LEVER);
      expect(second && (await walkFighting(sim, second, 60, 180))).toBe(true);
      expect(sim.activate(SECOND_LEVER)).toBe(true);
      await sim.step(8);
      expect(await sim.runtime.vm.getVariable(SECOND_CONTROL, '::puzzleSolved_var')).toBe(true);
      const on = await sim.position(TO_LOWER_HALLS);
      expect(on && (await walkFighting(sim, on, 90, 150))).toBe(true);
      expect(sim.activate(TO_LOWER_HALLS)).toBe(true);
      await sim.world.settle();
      await sim.step(2);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(TEMPLE_02);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      inLowerHalls = await sim.save('MQ303 temple 2');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The draugr lord before the great door has the Diamond Claw (the quest's DraugrWithClaw): taken
  // from his body it fits the keyhole, with the three rings turned as its palm shows. Past the door
  // the way goes out to the mountain top.
  it('has the player take the Diamond Claw and open the great door (Skuldafn02)', async () => {
    if (!inLowerHalls) return;
    const sim = await loadSim(inLowerHalls);
    try {
      const holder = alias(sim, CLAW_HOLDER);
      const claw = await sim.formId('MISC', 'dunSkuldafnDiamondClaw');
      expect(await sim.runtime.itemCount(holder, claw)).toBe(1);
      const at = await sim.position(holder);
      expect(at && (await walkFighting(sim, at, 150))).toBe(true);
      if (!(await sim.runtime.actors.isDead(holder))) await sim.kill(holder, PLAYER_REF);
      await sim.step(1);
      expect(await sim.take(holder, claw)).toBe(true);
      expect(await sim.runtime.itemCount(PLAYER_REF, claw)).toBe(1);
      for (const [ring, solved] of RINGS) {
        const handle = new ObjectHandle(ring, 'hallofstoriesdiskscript');
        for (let turn = 0; turn < 4; turn++) {
          if ((await sim.runtime.vm.stateOf(handle)).toLowerCase() === solved) break;
          expect(sim.activate(ring)).toBe(true);
          await sim.step(2);
        }
        expect((await sim.runtime.vm.stateOf(handle)).toLowerCase()).toBe(solved);
      }
      expect(sim.activate(KEYHOLE)).toBe(true);
      await sim.step(8);
      const keyhole = new ObjectHandle(KEYHOLE, 'hallofstorieskeyholescript');
      expect(await sim.runtime.vm.getVariable(keyhole, '::puzzleSolved_var')).toBe(true);
      const out = await sim.position(TEMPLE_WAY_OUT);
      expect(out && (await walkFighting(sim, out, 150, 150))).toBe(true);
      expect(sim.activate(TEMPLE_WAY_OUT)).toBe(true);
      await sim.world.settle();
      await sim.step(2);
      expect(sim.stageDone(MQ303, 160)).toBe(true);
      outOnTop = await sim.save('MQ303 160');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // On the top (160, 180) the priest goes to the portal and closes it with his staff
  // (MQ303PortalScene: 200). His staff is in his body (220, MQ303's own alias keeps it); set in its
  // place it opens the portal (240). Through it is Sovngarde, and the trigger before the door is
  // 300: MQ304 begins.
  it('has the priest close the portal, and the staff open it to Sovngarde (160-300)', async () => {
    if (!outOnTop) return;
    const sim = await loadSim(outOnTop);
    try {
      const up = await sim.position(TOP_TRIGGER);
      expect(up && (await walkFighting(sim, up, 90, 100))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ303, 180), 5)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 40)).toEqual({ displayed: true, completed: false });
      expect(await sim.until(() => sim.stageDone(MQ303, 200), 60)).toBe(true);
      await sim.step(1);
      const priest = alias(sim, PRIEST);
      const staff = await sim.formId('WEAP', 'MQ303DragonPriestStaff');
      expect(await sim.runtime.itemCount(priest, staff)).toBe(1);
      const at = await sim.position(priest);
      expect(at && (await walkFighting(sim, at, 40))).toBe(true);
      if (!(await sim.runtime.actors.isDead(priest))) await sim.kill(priest, PLAYER_REF);
      await sim.step(1);
      expect(await sim.take(priest, staff)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ303, 220), 5)).toBe(true);
      const seal = await sim.position(PORTAL_SEAL);
      expect(seal && (await walkFighting(sim, seal, 30, 150))).toBe(true);
      expect(sim.activate(PORTAL_SEAL)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ303, 240), 15)).toBe(true);
      const portal = await sim.position(PORTAL);
      expect(portal && (await walkFighting(sim, portal, 30, 150))).toBe(true);
      expect(sim.activate(PORTAL)).toBe(true);
      await sim.world.settle();
      await sim.step(2);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(SOVNGARDE);
      expect(await sim.until(() => sim.stageDone(MQ303, 300), 10)).toBe(true);
      await sim.step(1);
      expect(sim.isRunning(MQ303)).toBe(false);
      expect(sim.stageDone(MQ304, 10)).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
