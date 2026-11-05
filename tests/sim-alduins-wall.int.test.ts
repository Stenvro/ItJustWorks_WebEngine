// Integration test: the start of MQ203 "Alduin's Wall" on the headless simulation, played through
// as the player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ202 = 0x36191;
const MQ203 = 0x36192;
/** MQ203's Delphine, Esbern and SkyHavenBook aliases. */
const DELPHINE = 44;
const ESBERN = 52;
const SKY_HAVEN_BOOK = 55;
/** The Ratway Warrens (RiftenEsbernsVault), where MQ202 leaves the player with Esbern. */
const WARRENS = 0x3b696;
/** MQ202's FinalAmbush1 and 2 aliases. */
const FINAL_AMBUSH_1 = 73;
const FINAL_AMBUSH_2 = 74;
/** RiverwoodMapMarker, the Sleeping Giant Inn's door from the street and the inn. */
const RIVERWOOD_MARKER = 0x162a4;
const INN_DOOR = 0x13424;
const SLEEPING_GIANT = 0x133c6;
/** MQ203RiverwoodScene; Delphine's secret door (MQDelphineSecretDoor), Esbern's table
 * (MQ203EsbernTableMarker), where the book lies (MQ203SkyHavenBookMarker) and Karthspire's map
 * marker. */
const RIVERWOOD_SCENE = 0x37bdf;
const SECRET_DOOR = 0x93bcd;
const TABLE_MARKER = 0x36366;
const BOOK_MARKER = 0x36369;
const KARTHSPIRE_MARKER = 0x1626c;
const BLADES_FACTION = 0x72834;
const PLAYER_FOLLOWER_FACTION = 0x84d1b;

/** The game with Esbern and Delphine met in the Sleeping Giant (stage 30). */
let afterMeeting: Uint8Array | undefined;

/**
 * Those fighting the player fall to the player's blows (TODO(M13): the player's own blows; the
 * sim has no aimed attacks yet).
 */
async function fendOff(sim: Sim): Promise<void> {
  for (const staged of sim.actors()) {
    const actor = staged.reference;
    if (actor === PLAYER_REF || staged.dead) continue;
    if (sim.world.stage.combat.targetOf(actor) === PLAYER_REF) await sim.kill(actor, PLAYER_REF);
  }
}

/** Whether an actor is dead, on the stage or away. */
function isDead(sim: Sim, actor: number): boolean {
  return sim.actor(actor)?.dead ?? sim.runtime.state.actor(actor).dead ?? false;
}

/** A quest alias's reference. */
function alias(sim: Sim, quest: number, id: number): number {
  return sim.runtime.state.quest(quest).aliases.get(id) ?? 0;
}

/** Where a reference is: its worldspace, else its cell. */
async function space(sim: Sim, reference: number): Promise<number | undefined> {
  const placed = await sim.runtime.placement(reference);
  return placed?.world ?? placed?.cell;
}

/** Whether the scripts have put an actor in a faction (a rank of -2: taken out of it). */
function inFaction(sim: Sim, actor: number, faction: number): boolean {
  return (sim.runtime.state.actor(actor).factions.get(faction) ?? -2) >= 0;
}

/** An objective of MQ203 as the journal shows it. */
function objective(sim: Sim, id: number): { displayed: boolean; completed: boolean } {
  const state = sim.runtime.state.quest(MQ203).objectives.get(id);
  return { displayed: state?.displayed ?? false, completed: state?.completed ?? false };
}

describe.skipIf(!hasGamedata())("MQ203 Alduin's Wall", () => {
  // MQ203's own start for a game that skips ahead: its stage 0 sets 1, which plays MQ202 to 200
  // (Esbern packed, the last Thalmor sent in), and MQ202's 180 on the way begins MQ203 at 10
  // ("Escort Esbern to Riverwood"; he joins the Blades and follows the player). The player with
  // him in the Warrens (the way out is played in sim-a-cornered-rat). The last Thalmor fall to
  // the player's blows; fast travel to Riverwood, Esbern comes along. MQ203EsbernScript goes by
  // where he is: his arrival in Riverwood is 20 (no follower now: he makes for the inn himself),
  // his arrival in the inn 30, which starts MQ203RiverwoodScene and ends MQ202 (300). The scene
  // waits for the player in the inn.
  it('has the player bring Esbern to Delphine in the Sleeping Giant (10-30)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MQ203, 0);
      expect(await sim.until(() => sim.stageDone(MQ203, 10), 60)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ202, 200), 60)).toBe(true);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: false });
      const esbern = alias(sim, MQ203, ESBERN);
      const delphine = alias(sim, MQ203, DELPHINE);
      expect(inFaction(sim, esbern, BLADES_FACTION)).toBe(true);
      expect(inFaction(sim, esbern, PLAYER_FOLLOWER_FACTION)).toBe(true);
      // The player in the Warrens, by Esbern.
      await sim.openInterior(WARRENS);
      await sim.step(1);
      const at = await sim.position(esbern);
      expect(at && (await sim.walkPath(at, 120, 150))).toBe(true);
      expect(sim.package(esbern)?.procedure).toBe('Follow');
      expect(sim.runtime.state.actor(esbern).playerTeammate).toBe(true);
      const ambush = [FINAL_AMBUSH_1, FINAL_AMBUSH_2].map((id) => alias(sim, MQ202, id));
      for (let second = 0; second < 120 && !ambush.every((a) => isDead(sim, a)); second += 2) {
        await sim.step(2);
        await fendOff(sim);
      }
      expect(ambush.every((actor) => isDead(sim, actor))).toBe(true);
      expect(isDead(sim, esbern)).toBe(false);
      // On to Riverwood (fast travel: he comes along; 20: he is in Riverwood, and on his own).
      await sim.fastTravel(RIVERWOOD_MARKER);
      await sim.step(3);
      expect(await sim.distance(PLAYER_REF, esbern)).toBeLessThan(400);
      expect(await sim.until(() => sim.stageDone(MQ203, 20), 20)).toBe(true);
      expect(sim.stageDone(MQ203, 30)).toBe(false);
      // A stage counts as done as its fragment begins; the fragment takes its frames.
      await sim.step(1);
      expect(inFaction(sim, esbern, PLAYER_FOLLOWER_FACTION)).toBe(false);
      expect(sim.runtime.state.actor(esbern).playerTeammate).toBe(false);
      const door = await sim.position(INN_DOOR);
      expect(door && (await sim.walkPath(door, 120, 100))).toBe(true);
      expect(sim.activate(INN_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(3);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(SLEEPING_GIANT);
      expect(await space(sim, esbern)).toBe(SLEEPING_GIANT);
      expect(await sim.until(() => sim.stageDone(MQ203, 30), 20)).toBe(true);
      expect(sim.stageDone(MQ202, 300)).toBe(true);
      expect(sim.isRunning(MQ202)).toBe(false);
      expect(sim.runtime.scenes.isPlaying(RIVERWOOD_SCENE)).toBe(true);
      expect(await space(sim, delphine)).toBe(SLEEPING_GIANT);
      afterMeeting = await sim.save('MQ203 30');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // MQ203RiverwoodScene: with the player in the inn and Esbern there its greeting begins (40,
  // which listens for Esbern's AnimObjectUnequip). Delphine asks Orgnar to mind the bar and
  // leads them through her secret door down to the room behind the wardrobe; the player follows.
  // Esbern talks of the book, carries it to the table (his animation's AnimObjectUnequip: 48; the
  // phase done: 50, the book lies there, the player's) and shows where Sky Haven Temple is, in
  // the Karthspire (60: Karthspire on the map, Delphine and Esbern the player's followers, the
  // player one of the Blades).
  it('has Esbern show where Sky Haven Temple is (40-60)', async () => {
    if (!afterMeeting) return;
    const sim = await loadSim(afterMeeting);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const esbern = alias(sim, MQ203, ESBERN);
      const delphine = alias(sim, MQ203, DELPHINE);
      const book = alias(sim, MQ203, SKY_HAVEN_BOOK);
      expect(sim.runtime.scenes.isPlaying(RIVERWOOD_SCENE)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ203, 40), 60)).toBe(true);
      expect(await sim.enabled(book)).toBe(false);
      expect(sim.runtime.mapMarkerVisible(KARTHSPIRE_MARKER)).toBe(false);
      // Down to the secret room behind Delphine's wardrobe, after them.
      expect(await sim.until(() => sim.openState(SECRET_DOOR) === 1, 120)).toBe(true);
      const table = await sim.position(TABLE_MARKER);
      expect(table && (await sim.walkPath(table, 120, 200))).toBe(true);
      // He has walked to the table, and puts the book down on it.
      expect(await sim.until(() => sim.stageDone(MQ203, 48), 180)).toBe(true);
      expect(sim.stageDone(MQ203, 60)).toBe(false);
      expect(await sim.distance(esbern, TABLE_MARKER)).toBeLessThan(64);
      expect(await sim.until(() => sim.stageDone(MQ203, 50), 30)).toBe(true);
      await sim.step(1);
      expect(await sim.enabled(book)).toBe(true);
      expect(await sim.distance(book, BOOK_MARKER)).toBeLessThan(32);
      expect(objective(sim, 10)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: false });
      expect(await sim.until(() => sim.stageDone(MQ203, 60), 400)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 20)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: false });
      expect(sim.runtime.mapMarkerVisible(KARTHSPIRE_MARKER)).toBe(true);
      for (const actor of [delphine, esbern]) {
        expect(inFaction(sim, actor, PLAYER_FOLLOWER_FACTION)).toBe(true);
        expect(await sim.distance(actor, TABLE_MARKER)).toBeLessThan(300);
      }
      expect(inFaction(sim, PLAYER_REF, BLADES_FACTION)).toBe(true);
      // The whole talk played, none of it passed over: Orgnar's part at the bar too.
      for (let phase = 2; phase <= 25; phase += 1) {
        const started = new RegExp(`^MQ203RiverwoodScene: phase ${String(phase)}( "|$)`);
        expect(lines.some((line) => started.test(line))).toBe(true);
      }
      expect(lines).toContain('MQ203RiverwoodScene: #14 said');
      expect(lines).toContain('MQ203RiverwoodScene: #33 said');
    } finally {
      await sim.close();
    }
  }, 600_000);
});
