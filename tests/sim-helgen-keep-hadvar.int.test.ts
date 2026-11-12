// Integration test: MQ101 in Helgen Keep on Hadvar's route (the Imperial side), on the headless
// simulation: the player goes into the keep with Hadvar (stage 210, FactionPath 1), and the
// route's scenes (MQ101KeepIntroSceneA, KeepScene2A, 4A, 5A) lead them through the barracks, the
// storeroom, the torture room, over the bridge and through the caves, and out. The player keeps by
// Hadvar, fights where the route has a fight, and walks into the set-stage trigger a scene waits
// for. Each case goes on from the save the one before took. Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

type Vec3 = [number, number, number];

const MQ101 = 0x3372b;
const MQ102 = 0x4e50d;
/** MQ102A: Hadvar's route (the friend's part of MQ102). */
const MQ102A = 0x2bf9c;
/** HelgenKeep01. */
const KEEP = 0x5de24;
/** MQ101KeepIntroSceneA, KeepScene2A, KeepScene4A and KeepScene5A (Hadvar's route). */
const INTRO_A = 0x20167;
const KEEP_SCENE_2A = 0x26358;
const KEEP_SCENE_4A = 0xb9670;
const KEEP_SCENE_5A = 0xbf48c;
/** MQ101's Hadvar and WardenContainer aliases (the chest's OnOpen sets 257). */
const HADVAR_ALIAS = 1;
const WARDEN_CONTAINER = 62;
/** HelgenKeep01toExteriorExitREF: the cave's way out into Tamriel (an automatic door). */
const CAVE_EXIT = 0x91608;
const TAMRIEL = 0x3c;
/** MQ102FriendTravelToExit (MQ102A's Hadvar alias, MQ102 5 to 15). */
const FRIEND_TRAVEL_TO_EXIT = 0xad243;
/** The route's set-stage triggers, in the order the player passes them (as placed). */
const TRIGGERS: readonly (readonly [number, Vec3])[] = [
  [267, [1657, 5332, 536]],
  [292, [-955, 4723, 530]],
  [305, [124, 4128, 206]],
  [360, [1290, 2698, -3]],
  [350, [1133, 2682, -17]],
  [368, [824, 1362, -31]],
  [400, [-1639, 2168, -676]],
  [450, [-3875, -270, -848]],
  [460, [-2705, -2128, -1137]],
  [480, [-2894, -5278, -1094]],
  [485, [-3335, -5307, -1122]],
  [500, [-6015, -6788, -1506]],
  [550, [-6061, -8009, -1616]],
  [560, [-6697, -9619, -1659]],
  [650, [-5646, -12703, -2239]],
  [700, [-4416, -13552, -2570]],
  [720, [-3816, -16191, -2383]],
  [760, [-4510, -18097, -2684]],
  [800, [-4497, -20198, -3110]],
];

/** The player keeps by an actor (within the 100 units "wait for the player" phases ask). */
async function keepBy(sim: Sim, actor: number): Promise<void> {
  const near = await sim.distance(actor, PLAYER_REF);
  const at = await sim.position(actor);
  const me = await sim.position(PLAYER_REF);
  if (near !== undefined && near > 95 && at && me) {
    const k = 80 / near;
    await sim.moveTo([at[0] + (me[0] - at[0]) * k, at[1] + (me[1] - at[1]) * k, at[2] + 10]);
  }
}

/**
 * The player does not skip a trigger of the route. Keeping by Hadvar sets them at his side, a
 * second of his run at a time, so a trigger he led them past in that second was never walked
 * into: the next one of the route that lies between the two (nearer to each than they are to one
 * another, about their height) is walked into first.
 *
 * Found 2026-11-12: the trigger of 305 on the stairs down from the first room was skipped so,
 * and walked into only once nothing moved on, after the hall's collapse (the trigger of 310,
 * HelgenHallCollapseScript). 305 enables the three hallway Stormcloaks in the hall that is about
 * to fall in, and the collapse disables them six seconds later; the other way round they stood
 * in the rubble for good, off the navmeshes, and Hadvar fought them from the corridor instead of
 * leading on (he got to them or not as the fight went: the case passed or ran out of time).
 */
async function passTrigger(sim: Sim, actor: number): Promise<void> {
  const next = TRIGGERS.find(([stage]) => !sim.stageDone(MQ101, stage));
  const at = await sim.position(actor);
  const me = await sim.position(PLAYER_REF);
  if (!next || !at || !me) return;
  const [, trigger] = next;
  const flat = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const apart = flat(at, me);
  if (apart <= 95 || flat(me, trigger) >= apart || flat(at, trigger) >= apart) return;
  // A trigger's place is its box's middle, above the floor it stands on.
  if (Math.abs(trigger[2] - (at[2] + me[2]) / 2) > 300) return;
  await sim.moveTo(trigger);
  await sim.step(0.25);
}

/** The player kills the route's enemies (MQ101's aliases) still alive. */
async function fight(sim: Sim, aliases: readonly number[]): Promise<void> {
  for (const alias of aliases) {
    const actor = sim.runtime.state.quest(MQ101).aliases.get(alias);
    if (actor === undefined || (await sim.runtime.actors.isDead(actor))) continue;
    await sim.kill(actor, PLAYER_REF);
  }
}

/** The player fights back: whoever is in combat with them or Hadvar dies by their hand. */
async function defend(sim: Sim, friend: number): Promise<void> {
  const fighting = new Map<number, number | undefined>();
  for (const event of sim.events('combat')) {
    if (event.state !== 0) fighting.set(event.actor, event.target);
    else fighting.delete(event.actor);
  }
  for (const [actor, target] of fighting) {
    if (actor === friend || (target !== PLAYER_REF && target !== friend)) continue;
    if (!(await sim.runtime.actors.isDead(actor))) await sim.kill(actor, PLAYER_REF);
  }
}

/** A scene's phase now (−1: not playing). */
function phase(sim: Sim, scene: number): number {
  return sim.runtime.scenes.snapshot().find((playing) => playing.scene === scene)?.phase ?? -1;
}

/**
 * Plays Hadvar's route until `done` (or `seconds` have passed): the player keeps by Hadvar,
 * opens the warden's chest when he says to (stage 255), kills the route's enemies as their
 * scenes reach them, and walks into the next set-stage trigger when nothing has moved on for a
 * while (a scene waiting for the player to come on).
 */
async function playRoute(sim: Sim, done: () => boolean, seconds: number): Promise<void> {
  const quest = sim.runtime.state.quest(MQ101);
  const hadvar = quest.aliases.get(HADVAR_ALIAS) ?? 0;
  let last = '';
  let stalled = 0;
  for (let second = 0; second < seconds && !done(); second++) {
    await sim.step(1);
    await passTrigger(sim, hadvar);
    await keepBy(sim, hadvar);
    await defend(sim, hadvar);
    if (sim.stageDone(MQ101, 255) && !sim.stageDone(MQ101, 257)) {
      const chest = quest.aliases.get(WARDEN_CONTAINER) ?? 0;
      const at = await sim.position(chest);
      if (at) {
        await sim.moveTo([at[0] + 60, at[1], at[2] + 10]);
        await sim.step(0.5);
        sim.activate(chest);
      }
    }
    // The storeroom's Stormcloaks (340), the torture room's (380), the pool room's (470),
    // the spiders (630).
    if (sim.stageDone(MQ101, 320) && !sim.stageDone(MQ101, 340)) await fight(sim, [136, 137]);
    if (phase(sim, KEEP_SCENE_2A) >= 17 && !sim.stageDone(MQ101, 380)) await fight(sim, [68, 69]);
    if (phase(sim, KEEP_SCENE_4A) >= 4 && sim.stage(MQ101) < 470) {
      await fight(sim, [84, 85, 86, 87, 88]);
    }
    if (phase(sim, KEEP_SCENE_5A) >= 12 && !sim.stageDone(MQ101, 630)) {
      await fight(sim, [127, 128, 129, 130, 131]);
    }
    const scenes = sim.runtime.scenes.snapshot().map((playing) => playing.phase);
    const now = `${String(sim.stage(MQ101))} ${scenes.join(' ')}`;
    stalled = now === last ? stalled + 1 : 0;
    last = now;
    const next = TRIGGERS.find(([stage]) => !sim.stageDone(MQ101, stage));
    if (stalled >= 20 && next) {
      await sim.moveTo(next[1]);
      stalled = 0;
    }
  }
}

describe.skipIf(!hasGamedata())('MQ101 in Helgen Keep (Hadvar’s route)', () => {
  /** The game as each case left it. */
  let byTheDoor: Uint8Array | undefined;
  let overTheBridge: Uint8Array | undefined;
  let byTheExit: Uint8Array | undefined;

  // Found 2026-10-29: the warden's chest never told its scripts it opened (OnOpen: the
  // WardenContainer alias's defaultSetStageAliasScript sets 257, which the intro scene's phase
  // 11 waits for): the simulation had no container use. Its lid now opens with the menu.
  it('goes in with Hadvar, opens the warden’s chest, fights the Stormcloaks, and follows him through the door (stages 250 to 305)', async () => {
    const sim = await openSim({ opening: true });
    try {
      await sim.step(1);
      for (const playing of sim.runtime.scenes.snapshot()) sim.runtime.scenes.stop(playing.scene);
      // As MQ101SetStage210 does when the player walks in with Hadvar (not awaited: the
      // fragments of the stages it sets wait for frames).
      void sim.runtime.quests.setStage(MQ101, 210);
      await sim.step(0.5);
      await sim.openInterior(KEEP);
      // The town's scenes are over by the time the player reaches the keep.
      for (const playing of sim.runtime.scenes.snapshot()) {
        if (playing.scene !== INTRO_A) sim.runtime.scenes.stop(playing.scene);
      }
      await playRoute(sim, () => sim.stageDone(MQ101, 305), 300);
      // Hadvar's entry of 250 (FactionPath 1) started his scene; the chest (257); the gates
      // (265, 268); the Stormcloaks' fight (270, 280); the door (300) and out of the room (305).
      for (const stage of [250, 255, 257, 265, 268, 270, 280, 300, 292, 305]) {
        expect(sim.stageDone(MQ101, stage)).toBe(true);
      }
      byTheDoor = await sim.save();
    } finally {
      await sim.close();
    }
  }, 600_000);

  it('follows Hadvar through the storeroom, the torture room and over the bridge (stage 500)', async () => {
    expect(byTheDoor).toBeDefined();
    if (!byTheDoor) return;
    const sim = await loadSim(byTheDoor);
    try {
      await playRoute(sim, () => sim.stageDone(MQ101, 500), 400);
      for (const stage of [310, 340, 360, 368, 380, 400, 470, 490, 500]) {
        expect(sim.stageDone(MQ101, stage)).toBe(true);
      }
      overTheBridge = await sim.save();
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Found 2026-10-29: loaded past the bridge, Hadvar ran his patrol back to Helgen and the
  // caves' scene never played. Stage 500's first entry collapses the bridge over seconds of
  // Utility.Wait, and the route's entry, which starts MQ101KeepScene5A, ran only after it: the
  // save in between held the waiting thread but not the entries still to come. Each entry's
  // fragment is now a call of its own (src/scripting/runtime/quests.ts). And as the save loaded,
  // the low process sent Hadvar (not yet on the stage) where his package had him, while the
  // stage put him back where the save had him: the actors away leave a loaded save's actors of
  // the loaded area alone (src/shell/actors-away.ts).
  // Found 2026-10-29: at 800 Hadvar walked back to Helgen (MQ101HadvarPatrol4, GetStage >= 30)
  // instead of out of the cave (MQ102A's MQ102FriendTravelToExit): both quests are of priority
  // 80, and an alias filled later goes first (src/ai/package-data.ts, aliasPackageOrder).
  it('goes on with Hadvar through the caves past the spiders and the bear (stage 800)', async () => {
    expect(overTheBridge).toBeDefined();
    if (!overTheBridge) return;
    const sim = await loadSim(overTheBridge);
    try {
      await playRoute(sim, () => sim.stageDone(MQ101, 800), 400);
      for (const stage of [550, 560, 630, 650, 700, 800]) {
        expect(sim.stageDone(MQ101, stage)).toBe(true);
      }
      // Hadvar makes for the cave's exit (MQ102's 5 to 15), not back to Helgen.
      const hadvar = sim.runtime.state.quest(MQ101).aliases.get(HADVAR_ALIAS) ?? 0;
      await sim.step(3);
      expect(sim.package(hadvar)?.id).toBe(FRIEND_TRAVEL_TO_EXIT);
      byTheExit = await sim.save();
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Found 2026-10-29: the cave's end is an automatic door (AutoLoadDoor01: a marker without
  // collision or a crosshair prompt), which nothing took the player through. Observed in the
  // original: it watches the player's distance and, within fAutoDoorActivateDistance, fades the
  // screen and takes them through (src/shell/play-session.ts, autoDoors).
  it('walks up to the cave’s end and out into Tamriel with Hadvar (MQ102 15, MQ102A 10, MQ101 900)', async () => {
    expect(byTheExit).toBeDefined();
    if (!byTheExit) return;
    const sim = await loadSim(byTheExit);
    try {
      const hadvar = sim.runtime.state.quest(MQ101).aliases.get(HADVAR_ALIAS) ?? 0;
      await sim.step(1);
      const door = await sim.position(CAVE_EXIT);
      expect(door).toBeDefined();
      if (!door) return;
      // Along the cave towards its end: the door takes the player out on the way.
      await sim.walkPath(door, 30, 120);
      expect(await sim.until(() => sim.world.loadedCells.length > 1, 5)).toBe(true);
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(TAMRIEL);
      // Outside the exit's trigger sets MQ102 15 (MQ102A 10), which sets MQ101 900.
      for (let second = 0; second < 60 && !sim.stageDone(MQ101, 900); second++) {
        await sim.step(1);
        if ((await sim.runtime.placement(hadvar))?.world === TAMRIEL) await keepBy(sim, hadvar);
        await defend(sim, hadvar);
      }
      expect(sim.stageDone(MQ102, 15)).toBe(true);
      expect(sim.stageDone(MQ102A, 10)).toBe(true);
      expect(sim.stageDone(MQ101, 900)).toBe(true);
      expect((await sim.runtime.placement(hadvar))?.world).toBe(TAMRIEL);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
