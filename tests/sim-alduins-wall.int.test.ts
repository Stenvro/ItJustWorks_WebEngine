// Integration test: the start of MQ203 "Alduin's Wall" on the headless simulation, played through
// as the player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { ActorValue } from '../src/world/actor-values.ts';
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
type Vec3 = [number, number, number];
/** The three pillars (dunKarthspirePillarPuzzle, right at their second position: A starts at the
 * first, B at the third, C at the second) and the stage 120 trigger before them. */
const PILLAR_A = 0x8e900;
const PILLAR_B = 0x8e901;
const STAGE_120_AT: Vec3 = [133545, -1857, 2295];
const BY_PILLARS: Vec3 = [133200, -1855, 2330];
/** The middle of the retractable bridge's deck, and where the two wait before the plates
 * (MQ203EsbernKarthspireMarker3). */
const BRIDGE_DECK: Vec3 = [133185, -2498, 2340];
const BEFORE_PLATES = 0xa0887;
/** The way over the pressure plates: the plates of the room that carry no trap (no castSource,
 * TrapPressurePlateSkyhaven02), from the two's side to the chain's. */
const SAFE_PLATES_TO_TRAP: readonly (readonly [number, number])[] = [
  [132720, -3776],
  [132720, -3680],
  [132720, -3584],
];
const SAFE_PLATES_TO_CHAIN: readonly (readonly [number, number])[] = [
  [132624, -3584],
  [132528, -3584],
  [132528, -3680],
  [132432, -3680],
  [132336, -3680],
  [132336, -3584],
  [132336, -3488],
  [132336, -3392],
  [132240, -3392],
  [132144, -3392],
  [132144, -3488],
  [132144, -3584],
  [132048, -3584],
  [131952, -3584],
  [131952, -3488],
];
const PLATE_FLOOR = 2562;
/** A plate with a trap, beside the way (TrapPressurePlateSkyhaven03), and the chain that shuts the
 * traps off. */
const TRAP_PLATE: readonly [number, number] = [132816, -3584];
const PLATE_CHAIN = 0x511a4;
/** Where the player comes out on Sky Haven Temple's forecourt (the stage 140 trigger above it);
 * MQ203PuzzleScene, the blood seal's outer ring (PuzzleActivator alias) and the head door. */
const STAGE_140_AT: Vec3 = [130347, -2033, 2916];
const PUZZLE_SCENE = 0x13126;
const PUZZLE_ACTIVATOR = 56;
const BY_SEAL: Vec3 = [128620, -2264, 2945];
const SEAL_DOOR = 0x6aef2;
/**
 * The lights linked to the temple's sconces (SkyHavenSconceScript enables them): the four Delphine
 * reaches in MQ203DelphineLightTorches1to5 as the entry scene plays (the sequence's last she need
 * not reach: the package ends with the scene's phase 7, and MQ204's marker lights what is left at
 * a later load), and the wall's two, hers (MQ203DelphineLightRightSconce) and Esbern's
 * (MQ203EsbernLightLeftSconce).
 */
const ENTRY_SCONCE_LIGHTS = [0x6331d, 0x63315, 0x6331c, 0x63325];
const WALL_SCONCE_LIGHTS = [0x6d282, 0x6d285];
/** The stage 210 trigger behind the door, MQ203SkyHavenEntryScene, MQ203RemansWallScene, the
 * temple's door. */
const STAGE_210_AT: Vec3 = [127701, -2225, 3112];
const ENTRY_SCENE = 0x71c2e;
const WALL_SCENE = 0x16fa7;
const TEMPLE_DOOR = 0x13124;
const BY_TEMPLE_DOOR: Vec3 = [127100, -2150, 3190];

/** The game with Esbern and Delphine met in the Sleeping Giant (stage 30). */
let afterMeeting: Uint8Array | undefined;
/** The game with Sky Haven Temple found on Esbern's map (stage 60). */
let afterMap: Uint8Array | undefined;
/** The game with the three at Karthspire, past its entrance (stage 110). */
let afterArrival: Uint8Array | undefined;
/** The game with the bridge down and the player and the two before the plates (stage 120). */
let afterBridge: Uint8Array | undefined;
/** The game on the temple's forecourt with the seal awake (stage 150). */
let afterPlates: Uint8Array | undefined;
/** The game inside Sky Haven Temple, the seal opened (stage 210). */
let afterSeal: Uint8Array | undefined;

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

/** The player's health now. */
async function health(sim: Sim): Promise<number> {
  return (await sim.runtime.actors.value(PLAYER_REF, ActorValue.health)).current;
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
      // A Forsworn the two meet on the way, on a ledge none of them can reach, falls to the player
      // (their fight pauses the scene, combatPause).
      const said = (line: string): boolean => lines.includes(`MQ203KarthspireScene: ${line} said`);
      for (let second = 0; second < 120 && !said('#5'); second += 2) {
        await sim.step(2);
        await fendOff(sim, party);
      }
      expect(said('#5')).toBe(true);
      expect(await sim.until(() => said('#6'), 60)).toBe(true);
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

  // MQ203KarthspireScene goes on as the player goes. A chasm lies before the pillars: the bridge
  // over it is up (default2StateActivator, open), and its deck is where the way on goes.
  it('has the raised bridge hold the player back', async () => {
    if (!afterArrival) return;
    const sim = await loadSim(afterArrival);
    try {
      const before = await sim.position(BEFORE_PLATES);
      expect(before && (await sim.walkPath(before, 40, 96))).toBe(false);
      expect(sim.world.player.feet[2]).toBeLessThan(BRIDGE_DECK[2] - 200);
      expect(sim.world.player.feet[1]).toBeGreaterThan(BRIDGE_DECK[1] - 100);
    } finally {
      await sim.close();
    }
  }, 300_000);

  // The trigger before the pillars is 120: the two tell what the pillars are (scene phases 8-11)
  // and wait for one to be right (phase 12). Each activation turns a pillar a step, with its
  // animation (it takes no activation meanwhile). The third right is the puzzle's end: the bridge
  // comes down (phase 16 ends), and the player walks its deck; the two come after them, to the
  // room of plates, and tell of its trap (phases 22-25), waiting for the player to shut it off.
  it('has the player turn the pillars and cross the bridge (120)', async () => {
    if (!afterArrival) return;
    const sim = await loadSim(afterArrival);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const seen = (line: string) => (): boolean => lines.includes(`MQ203KarthspireScene: ${line}`);
      const esbern = alias(sim, MQ203, ESBERN);
      const delphine = alias(sim, MQ203, DELPHINE);
      expect(sim.stageDone(MQ203, 120)).toBe(false);
      expect(await sim.walkPath(STAGE_120_AT, 120)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ203, 120), 5)).toBe(true);
      expect(await sim.walkPath(BY_PILLARS, 60, 96)).toBe(true);
      const waiting = 'phase 12 "Wait for player to get one pillar right"';
      expect(await sim.until(seen(waiting), 120)).toBe(true);
      await sim.step(3);
      expect(seen('phase 13')()).toBe(false);
      // Pillar A is the first right: Esbern's word on it.
      expect(sim.activate(PILLAR_A)).toBe(true);
      expect(await sim.until(seen('phase 13'), 5)).toBe(true);
      expect(await sim.until(seen('#18 said'), 60)).toBe(true);
      expect(await sim.until(seen('phase 16 "Wait for bridge to be down"'), 5)).toBe(true);
      // Pillar B: third to first; then, its animation done, first to second: all three are right.
      expect(sim.activate(PILLAR_B)).toBe(true);
      await sim.step(6);
      expect(seen('phase 17')()).toBe(false);
      expect(sim.activate(PILLAR_B)).toBe(true);
      expect(await sim.until(seen('phase 17'), 15)).toBe(true);
      expect(await sim.until(seen('#20 said'), 30)).toBe(true);
      expect(await sim.walkPath(BRIDGE_DECK, 30)).toBe(true);
      // On the deck, not in the chasm under it.
      expect(sim.world.player.feet[2]).toBeGreaterThan(BRIDGE_DECK[2] - 40);
      const before = await sim.position(BEFORE_PLATES);
      expect(before && (await sim.walkPath(before, 60, 96))).toBe(true);
      expect(await sim.until(seen('#28 said'), 120)).toBe(true);
      expect(await sim.until(seen('phase 26 "Wait for player to turn off plates"'), 5)).toBe(true);
      for (const actor of [delphine, esbern]) {
        expect(await sim.distance(actor, BEFORE_PLATES)).toBeLessThan(300);
        expect(isDead(sim, actor)).toBe(false);
      }
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: false });
      afterBridge = await sim.save('MQ203 120');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The room of plates: those without a trap make the way across; the others fire at the one on
  // them. dunKarthspirePlatePuzzleSCRIPT, unlike every other plate's, casts in its Active state's
  // OnTriggerEnter, and the cell's load has put it in Inactive (TrapTriggerBase's onCellLoad, with
  // isTriggerVolume set), where the inherited OnTriggerEnter only goes on to active: by its scripts,
  // and with a volume telling one enter per reference (observed in the original), a first step
  // arms the plate and a later one fires it. TODO(M13): UESP has a wrong plate launch a fireball
  // without saying on which step; whether the original's first step fires is not known, and nothing
  // in the data or the engine's rules seen so far would make it. The chain at the far end shuts
  // them off (the master's plateSolved), and the scene's last phases send the two on ahead. The
  // trigger above the forecourt is 140: MQ203PuzzleScene starts, and at its phase 3's end Esbern
  // has told of the blood seal, which wakes (150: no longer destroyed).
  it('has the player cross the plates and reach the blood seal (140-150)', async () => {
    if (!afterBridge) return;
    const sim = await loadSim(afterBridge);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const seen = (line: string) => (): boolean => lines.includes(line);
      const esbern = alias(sim, MQ203, ESBERN);
      const delphine = alias(sim, MQ203, DELPHINE);
      const onto = ([x, y]: readonly [number, number]): Promise<boolean> =>
        sim.walkTo([x, y, PLATE_FLOOR], 6, 16);
      const unhurt = await health(sim);
      for (const plate of SAFE_PLATES_TO_TRAP) expect(await onto(plate)).toBe(true);
      expect(await health(sim)).toBe(unhurt);
      const beside = SAFE_PLATES_TO_TRAP.at(-1) ?? TRAP_PLATE;
      expect(await onto(TRAP_PLATE)).toBe(true);
      await sim.step(2);
      expect(await health(sim)).toBe(unhurt);
      expect(await onto(beside)).toBe(true);
      await sim.step(1);
      expect(await onto(TRAP_PLATE)).toBe(true);
      const hit = async (): Promise<boolean> => (await health(sim)) < unhurt;
      for (let second = 0; second < 5 && !(await hit()); second += 1) await sim.step(1);
      expect(await hit()).toBe(true);
      expect(await onto(beside)).toBe(true);
      const hurt = await health(sim);
      for (const plate of SAFE_PLATES_TO_CHAIN) expect(await onto(plate)).toBe(true);
      expect(await health(sim)).toBeGreaterThanOrEqual(hurt);
      await sim.step(1);
      expect(seen('MQ203KarthspireScene: phase 28')()).toBe(false);
      expect(sim.activate(PLATE_CHAIN)).toBe(true);
      expect(await sim.until(seen('MQ203KarthspireScene: phase 28'), 10)).toBe(true);
      expect(await sim.until(seen('MQ203KarthspireScene: #33 said'), 60)).toBe(true);
      expect(sim.stageDone(MQ203, 140)).toBe(false);
      expect(await sim.walkPath(STAGE_140_AT, 120)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ203, 140), 5)).toBe(true);
      await sim.step(1);
      expect(sim.runtime.scenes.isPlaying(KARTHSPIRE_SCENE)).toBe(false);
      expect(sim.runtime.scenes.isPlaying(PUZZLE_SCENE)).toBe(true);
      // The seal does not answer yet.
      const seal = alias(sim, MQ203, PUZZLE_ACTIVATOR);
      expect(await sim.walkPath(BY_SEAL, 30, 64)).toBe(true);
      sim.activate(seal);
      await sim.step(1);
      expect(sim.stageDone(MQ203, 180)).toBe(false);
      expect(await sim.until(() => sim.stageDone(MQ203, 150), 90)).toBe(true);
      await sim.step(1);
      for (const actor of [delphine, esbern]) {
        expect(await space(sim, actor)).toBe(KARTHSPIRE_WORLD);
        expect(isDead(sim, actor)).toBe(false);
        expect(inFaction(sim, actor, PLAYER_FOLLOWER_FACTION)).toBe(false);
      }
      expect(sim.openState(SEAL_DOOR)).not.toBe(1);
      afterPlates = await sim.save('MQ203 150');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The player gives the seal blood (the ring's activation: 180, the cut hand's idle; 185 as the
  // rings go round). MQ203PuzzleRingScript's ringFinish sets 200: the head door opens, the two get
  // torches, the objective goes on to the wall. The trigger behind the door is 210:
  // MQ203SkyHavenEntryScene takes them in ahead of the player. Delphine's package lights
  // the sconces as the player comes in (MQ203DelphineLightTorches1to5, an ActivateInSequence):
  // the first as she is set down at it with the temple's load, then on along the way.
  it('has the player open the blood seal and enter the temple (180-210)', async () => {
    if (!afterPlates) return;
    const sim = await loadSim(afterPlates);
    try {
      const esbern = alias(sim, MQ203, ESBERN);
      const delphine = alias(sim, MQ203, DELPHINE);
      for (const light of [...ENTRY_SCONCE_LIGHTS, ...WALL_SCONCE_LIGHTS]) {
        expect(await sim.enabled(light)).toBe(false);
      }
      expect(sim.stageDone(MQ203, 180)).toBe(false);
      expect(sim.openState(SEAL_DOOR)).not.toBe(1);
      expect(sim.activate(alias(sim, MQ203, PUZZLE_ACTIVATOR))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ203, 180), 2)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ203, 185), 10)).toBe(true);
      expect(sim.stageDone(MQ203, 200)).toBe(false);
      expect(await sim.until(() => sim.stageDone(MQ203, 200), 30)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 30)).toEqual({ displayed: true, completed: true });
      expect(objective(sim, 40)).toEqual({ displayed: true, completed: false });
      expect(await sim.until(() => sim.openState(SEAL_DOOR) === 1, 20)).toBe(true);
      expect(sim.stageDone(MQ203, 210)).toBe(false);
      expect(await sim.walkPath(STAGE_210_AT, 90)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ203, 210), 5)).toBe(true);
      await sim.step(1);
      expect(sim.runtime.scenes.isPlaying(ENTRY_SCENE)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(PUZZLE_SCENE)).toBe(false);
      // After them through the temple's door.
      expect(await sim.walkPath(BY_TEMPLE_DOOR, 60, 96)).toBe(true);
      expect(sim.activate(TEMPLE_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      const temple = (await sim.runtime.placement(PLAYER_REF))?.cell;
      expect(temple).toBeDefined();
      expect(await space(sim, PLAYER_REF)).not.toBe(KARTHSPIRE_WORLD);
      expect(await sim.until(() => sim.stageDone(MQ203, 230), 180)).toBe(true);
      for (const actor of [delphine, esbern]) {
        expect(await space(sim, actor)).toBe(temple);
        expect(isDead(sim, actor)).toBe(false);
      }
      for (const light of ENTRY_SCONCE_LIGHTS) expect(await sim.enabled(light)).toBe(true);
      afterSeal = await sim.save('MQ203 230');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // MQ203RemansWallScene goes on as the player comes within 1000 of Esbern. 260 comes in its talk
  // (phase 14); at phase 19 Delphine force greets the player, and the talk with her is 280; the
  // scene's last phases end it, and its end is 300, MQ203's end; MQ204 goes on from there.
  it("has the player learn the secret of Alduin's Wall (230-300)", async () => {
    if (!afterSeal) return;
    const sim = await loadSim(afterSeal);
    try {
      const lines: string[] = [];
      sim.runtime.scenes.listen((line) => lines.push(line));
      const seen = (line: string) => (): boolean => lines.includes(`MQ203RemansWallScene: ${line}`);
      const esbern = alias(sim, MQ203, ESBERN);
      const delphine = alias(sim, MQ203, DELPHINE);
      expect(sim.runtime.scenes.isPlaying(WALL_SCENE)).toBe(true);
      const atForceGreet = seen('phase 19 "Wait for GetStageDone 280 == 1"');
      for (let turn = 0; turn < 300 && !atForceGreet(); turn += 1) {
        const at = await sim.position(esbern);
        if (at) await sim.walkPath(at, 4, 300);
        await sim.step(1);
      }
      expect(atForceGreet()).toBe(true);
      for (const light of WALL_SCONCE_LIGHTS) expect(await sim.enabled(light)).toBe(true);
      expect(sim.stageDone(MQ203, 260)).toBe(true);
      expect(sim.stageDone(MQ203, 280)).toBe(false);
      const said = await sim.listen(delphine, 60);
      expect(said).toBeDefined();
      for (let turn = 0; turn < 6 && sim.topics.length > 0; turn += 1) {
        const topic = sim.topics[0];
        if (topic !== undefined) await sim.choose(topic);
      }
      expect(await sim.until(() => sim.stageDone(MQ203, 280), 10)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ203, 300), 240)).toBe(true);
      await sim.step(1);
      expect(objective(sim, 40).completed).toBe(true);
      expect(sim.isRunning(MQ203)).toBe(false);
      const mq204 = await sim.formId('QUST', 'MQ204');
      expect(sim.stageDone(mq204, 10)).toBe(true);
      expect(sim.isRunning(mq204)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
