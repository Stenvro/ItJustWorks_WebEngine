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
/** The inn's door to the street. */
const INN_EXIT = 0x13419;
/** MQ203's KarthspireLoadDoor alias's door (an automatic one), the worldspace behind it and
 * MQ203KarthspireScene. */
const KARTHSPIRE_DOOR = 0x15e13;
const KARTHSPIRE_WORLD = 0x35699;
const KARTHSPIRE_SCENE = 0xa8d56;
const TAMRIEL = 0x3c;

/** The game with Esbern and Delphine met in the Sleeping Giant (stage 30). */
let afterMeeting: Uint8Array | undefined;
/** The game with Sky Haven Temple found on Esbern's map (stage 60). */
let afterMap: Uint8Array | undefined;
/** The game with the three at Karthspire, past its entrance (stage 110). */
let afterArrival: Uint8Array | undefined;

/**
 * Those fighting the player, or the friends with them, fall to the player's blows (TODO(M13):
 * the player's own blows; the sim has no aimed attacks yet). How many there were.
 */
async function fendOff(sim: Sim, friends: readonly number[] = []): Promise<number> {
  let fallen = 0;
  for (const staged of sim.actors()) {
    const actor = staged.reference;
    if (actor === PLAYER_REF || staged.dead || friends.includes(actor)) continue;
    const target = sim.world.stage.combat.targetOf(actor);
    if (target === PLAYER_REF || (target !== undefined && friends.includes(target))) {
      await sim.kill(actor, PLAYER_REF);
      fallen += 1;
    }
  }
  return fallen;
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
      afterMap = await sim.save('MQ203 60');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The talk's end (MQ203RiverwoodScene's 26-28) has Delphine force greet the player (29; her
  // conversation pauses the scene, dialoguePause), with the two ways to Karthspire: "Let's travel
  // there together" is a Goodbye info whose fragment sets 70 (the two are followers now; their
  // packages, MQ203*FollowPlayerToSkyHaven, have run since 60). The scene goes on: she asks Orgnar
  // to mind the inn, and it ends as the player leaves (MQ203PlayerScript: 65). On by the map:
  // Esbern coming into Karthspire's location is 80, the player's 100. The Forsworn camp outside
  // falls; the load door at the cave's end is an automatic one (it takes the player through as
  // they come near), and they arrive in KarthspireRedoubtWorld inside MQ203SetStage110, which
  // starts MQ203KarthspireScene: the two are no followers now, and go ahead of the player on the
  // scene's packages.
  it('has the three travel together and reach Karthspire (70-110)', async () => {
    if (!afterMap) return;
    const sim = await loadSim(afterMap);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const esbern = alias(sim, MQ203, ESBERN);
      const delphine = alias(sim, MQ203, DELPHINE);
      const party = [delphine, esbern];
      const followPackages = [
        await sim.formId('PACK', 'MQ203DelphineFollowPlayerToSkyHaven'),
        await sim.formId('PACK', 'MQ203EsbernFollowPlayerToSkyHaven'),
      ];
      // Her greeting: both ways offered, and her word on the road; stage 70 waits for the choice.
      const offered = await sim.listen(delphine, 90);
      expect(offered).toContain("I'll meet you at Karthspire.");
      expect(offered).toContain("Let's travel there together. Are you ready to go?");
      expect(lines).toContain('MQ203RiverwoodScene: paused');
      expect(sim.stageDone(MQ203, 70)).toBe(false);
      expect(await sim.choose(/best way/)).toEqual(offered);
      expect(sim.stageDone(MQ203, 70)).toBe(false);
      // The line's Goodbye flag ends the conversation: no topics after it.
      expect(await sim.choose(/travel there together/)).toEqual([]);
      expect(sim.stageDone(MQ203, 70)).toBe(true);
      expect(sim.stageDone(MQ203, 75)).toBe(false);
      for (const actor of party) expect(inFaction(sim, actor, PLAYER_FOLLOWER_FACTION)).toBe(true);
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: false });
      // The scene goes on with her and Orgnar; she follows once it has let her go.
      expect(await sim.until(() => lines.includes('MQ203RiverwoodScene: goes on'), 5)).toBe(true);
      const phase35 = (): boolean => lines.includes('MQ203RiverwoodScene: phase 35');
      expect(await sim.until(phase35, 120)).toBe(true);
      for (const said of ['#58', '#60', '#61', '#62']) {
        expect(lines).toContain(`MQ203RiverwoodScene: ${said} said`);
      }
      expect(sim.stageDone(MQ203, 65)).toBe(false);
      expect(sim.package(delphine)?.id).toBe(followPackages[0]);
      expect(sim.package(esbern)?.id).toBe(followPackages[1]);
      // Out of the inn, and they with the player.
      const exit = await sim.position(INN_EXIT);
      expect(exit && (await sim.walkPath(exit, 120, 100))).toBe(true);
      expect(sim.activate(INN_EXIT)).toBe(true);
      await sim.world.settle();
      await sim.step(3);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).not.toBe(SLEEPING_GIANT);
      expect(await sim.until(() => sim.stageDone(MQ203, 65), 5)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(RIVERWOOD_SCENE)).toBe(false);
      for (const actor of party) expect(await sim.distance(PLAYER_REF, actor)).toBeLessThan(600);
      // By the map, they along: Esbern's arrival is 80, the player's 100.
      expect(sim.runtime.mapMarkerVisible(KARTHSPIRE_MARKER)).toBe(true);
      await sim.fastTravel(KARTHSPIRE_MARKER);
      for (const actor of party) expect(await sim.distance(PLAYER_REF, actor)).toBeLessThan(600);
      expect(await sim.until(() => sim.stageDone(MQ203, 100), 10)).toBe(true);
      expect(sim.stageDone(MQ203, 80)).toBe(true);
      expect(sim.stageDone(MQ203, 75)).toBe(false);
      expect(sim.stageDone(MQ203, 110)).toBe(false);
      // The Forsworn of the camp come; none is left fighting, and the two are back by the player.
      let fallen = 0;
      let quiet = 0;
      for (let second = 0; second < 180 && quiet < 10; second += 2) {
        await sim.step(2);
        const now = await fendOff(sim, party);
        fallen += now;
        const fighting = sim.actors().some((staged) => {
          if (staged.dead) return false;
          return sim.world.stage.combat.targetOf(staged.reference) !== undefined;
        });
        quiet = fighting || now > 0 ? 0 : quiet + 1;
      }
      expect(quiet).toBe(10);
      expect(fallen).toBeGreaterThan(0);
      for (const actor of party) expect(isDead(sim, actor)).toBe(false);
      const door = await sim.position(KARTHSPIRE_DOOR);
      expect(door && (await sim.walkPath(door, 180, 400))).toBe(true);
      const nearby = async (reach: number): Promise<boolean> => {
        for (const actor of party) {
          const away = await sim.distance(PLAYER_REF, actor);
          if (away === undefined || away > reach) return false;
        }
        return true;
      };
      for (let second = 0; second < 90 && !(await nearby(600)); second += 1) await sim.step(1);
      expect(await nearby(600)).toBe(true);
      expect(sim.package(delphine)?.id).toBe(followPackages[0]);
      expect(sim.package(esbern)?.id).toBe(followPackages[1]);
      expect(await space(sim, PLAYER_REF)).toBe(TAMRIEL);
      expect(sim.stageDone(MQ203, 110)).toBe(false);
      // Up to the door: it takes them through, the two with them, and the arrival is 110.
      expect(door && (await sim.walkPath(door, 60, 200))).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect(await space(sim, PLAYER_REF)).toBe(KARTHSPIRE_WORLD);
      expect(await sim.until(() => sim.stageDone(MQ203, 110), 10)).toBe(true);
      await sim.step(1);
      expect(sim.runtime.scenes.isPlaying(KARTHSPIRE_SCENE)).toBe(true);
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: false });
      for (const actor of party) {
        expect(await space(sim, actor)).toBe(KARTHSPIRE_WORLD);
        expect(inFaction(sim, actor, PLAYER_FOLLOWER_FACTION)).toBe(false);
      }
      // They go ahead on the scene's packages, to their first marker, and talk there.
      expect(sim.package(delphine)?.id).toBe(
        await sim.formId('PACK', 'MQ203DelphineToKarthspireMarker1'),
      );
      expect(sim.package(esbern)?.id).toBe(
        await sim.formId('PACK', 'MQ203EsbernToKarthspireMarker1'),
      );
      expect(await sim.until(() => lines.includes('MQ203KarthspireScene: #5 said'), 120)).toBe(
        true,
      );
      expect(await sim.until(() => lines.includes('MQ203KarthspireScene: #6 said'), 60)).toBe(true);
      afterArrival = await sim.save('MQ203 110');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The save a later segment goes on from: what the arrival left loads as it was.
  it('keeps the arrival at Karthspire in its save', async () => {
    if (!afterArrival) return;
    const sim = await loadSim(afterArrival);
    try {
      expect(sim.stageDone(MQ203, 110)).toBe(true);
      expect(await space(sim, PLAYER_REF)).toBe(KARTHSPIRE_WORLD);
      expect(sim.runtime.scenes.isPlaying(KARTHSPIRE_SCENE)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 120_000);
});
