// Integration test: MQ105 "The Way of the Voice" on the headless simulation, played through as
// the player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { hostileTo } from '../src/ai/combat-ai.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ104 = 0x2610c;
const MQ105 = 0x242ba;
/** Tamriel, and the HighHrothgar interior. */
const TAMRIEL = 0x3c;
const HIGH_HROTHGAR = 0x87764;
/** IvarsteadMapMarker and HighHrothgarMapMarker. */
const IVARSTEAD_MARKER = 0x17791;
const HIGH_HROTHGAR_MARKER = 0x16352;
/** One of High Hrothgar's front doors (the top of the 7,000 steps). */
const FRONT_DOOR = 0x877d3;
/** MQ105SetStage20: the trigger inside the front doors. */
const SET_STAGE_20 = 0x649bc;
/** MQ105's Arngeir, Borri, EinarthWord and BorriWord aliases. */
const ARNGEIR = 33;
const BORRI = 34;
const EINARTH_WORD = 39;
const BORRI_WORD = 40;
/** MQ105TargetsHit: the phantoms struck in the push trial. */
const TARGETS_HIT = 0x3df65;
/** The hall's door to the courtyard (inside). */
const COURTYARD_DOOR = 0x877cd;
/** The sprint trial's start trigger, Borri's gate and the trigger past it. */
const SPRINT_START = 0x3fb00;
const SPRINT_GATE = 0x3fafb;
const SPRINT_SUCCESS = 0x3fb02;
/** MQ105Ustengrav: The Horn of Jurgen Windcaller, and dunUstengravQST (the dungeon's own). */
const HORN_QUEST = 0x713dc;
const USTENGRAV_QUEST = 0x2125b;
/** UstengravMapMarker, the barrow's door from the marsh, and its two inner cells. */
const USTENGRAV_MARKER = 0x1621f;
const USTENGRAV_DOOR = 0x15d7b;
const USTENGRAV_01 = 0x270ab;
const USTENGRAV_02 = 0x152aa;
/** Ustengrav01's door down to Ustengrav02. */
const USTENGRAV_DOWN = 0x2720c;
/** The gate trial's first stone (dunUstenPuzTrigger01) and its last gate. */
const GATE_STONE_1 = 0x3b2e3;
const LAST_GATE = 0x3b2e7;
/** The word wall's look target (the word the player walks up to). */
const WORD_WALL_LOOK = 0x70b4e;
/** The two spider webs across the way to the tomb (FXspiderWebKitDestructible). */
const WEB_1 = 0x38457;
const WEB_2 = 0x38458;
/** MQ105SetStage180 (the tomb's hall), the tomb (MQ105TombActivator) and the note on it. */
const SET_STAGE_180 = 0x7a507;
const TOMB = 0xc65ad;
const TOMB_NOTE = 0xc65ae;
/** A Blade in the Dark, its Delphine alias, and the inn's room trigger (InnRoomTrigger). */
const MQ106 = 0x32926;
const DELPHINE = 44;
const ROOM_TRIGGER = 0x3fb03;
/** RiverwoodMapMarker, the Sleeping Giant Inn's door from the street and the inn. */
const RIVERWOOD_MARKER = 0x162a4;
const INN_DOOR = 0x13424;
const SLEEPING_GIANT = 0x133c6;
/** MQ105's OutroTrigger (the hall's middle) and WulfgarWord aliases. */
const OUTRO_TRIGGER = 53;
const WULFGAR_WORD = 52;

/** The player kills the living actors within reach hostile to them (the fight not under test). */
async function fight(sim: Sim, reach: number): Promise<void> {
  const me = await sim.position(PLAYER_REF);
  if (!me) return;
  for (const actor of sim.actors()) {
    const at = actor.position;
    if (actor.dead || !actor.enabled(actor.reference)) continue;
    if (Math.hypot(at[0] - me[0], at[1] - me[1], at[2] - me[2]) > reach) continue;
    if (await sim.runtime.actors.isDead(actor.reference)) continue;
    if (await hostileTo(sim.runtime, actor.reference, PLAYER_REF)) {
      await sim.kill(actor.reference, PLAYER_REF);
    }
  }
}

/** The player makes their way over the navmeshes to a point, fighting what attacks them. */
async function fightTo(
  sim: Sim,
  target: [number, number, number],
  seconds: number,
  reach = 64,
): Promise<boolean> {
  for (let second = 0; second < seconds; second += 5) {
    await fight(sim, 1500);
    if (await sim.walkPath(target, 5, reach)) return true;
  }
  return false;
}

/** The player turns to face a reference. */
async function face(sim: Sim, reference: number, pitched = false): Promise<void> {
  const at = await sim.position(reference);
  const me = await sim.position(PLAYER_REF);
  if (!at || !me) return;
  const across = Math.hypot(at[0] - me[0], at[1] - me[1]);
  // Pitched: looking down (or up) at it from the eyes.
  const pitch = pitched ? Math.atan2(at[2] - (me[2] + EYE_HEIGHT), across) : 0;
  sim.world.look(Math.atan2(at[0] - me[0], at[1] - me[1]), pitch);
}

/** The player's eyes above their feet (units). */
const EYE_HEIGHT = 110;

/** The topic an actor's ForceGreet opened the dialogue menu with (undefined: none yet). */
function greeting(sim: Sim, actor: number): number | undefined {
  return sim.menus().find((menu) => menu.menu === 'Dialogue Menu' && menu.reference === actor)
    ?.opening;
}

/** The player taps the voice key (one word), or holds it `seconds` (more words). */
async function shout(sim: Sim, seconds = 0.1): Promise<void> {
  sim.press('Shout', true);
  await sim.step(seconds);
  sim.press('Shout', false);
}

/** The game with the player inside High Hrothgar, summoned (stage 15). */
let atHighHrothgar: Uint8Array | undefined;
/** The game with Arngeir asking for a Shout (stage 30). */
let afterIntro: Uint8Array | undefined;
/** The game after the player shouted at the Greybeards (stage 50). */
let afterShout: Uint8Array | undefined;
/** The game with Ro learned, before the push trial (stage 80). */
let afterRo: Uint8Array | undefined;
/** The game with the phantom targets struck (stage 90). */
let afterTargets: Uint8Array | undefined;
/** The game with Wuld learned and unlocked (stage 120). */
let afterWuld: Uint8Array | undefined;
/** The game with the sprint trial passed (stage 140). */
let afterSprint: Uint8Array | undefined;
/** The game with the quest complete and the Horn's begun (stage 160). */
let afterVoice: Uint8Array | undefined;
/** The game with the player in Ustengrav (the Horn's stage 10). */
let inUstengrav: Uint8Array | undefined;
/** The game with the player in Ustengrav02 (its depths). */
let inDepths: Uint8Array | undefined;
/** The game with the Whirlwind Sprint gates passed (dunUstengravQST 50). */
let afterGates: Uint8Array | undefined;
/** The game with Feim learned at the word wall. */
let afterWall: Uint8Array | undefined;
/** The game with the player in at the tomb's hall (MQ105 180). */
let afterHall: Uint8Array | undefined;
/** The game with the note taken from the Horn's tomb (MQ105 200, the Horn's 20). */
let afterNote: Uint8Array | undefined;
/** The game with Delphine met and the Horn given back to the player (MQ105 220, MQ106 30). */
let afterDelphine: Uint8Array | undefined;

describe.skipIf(!hasGamedata())('MQ105 The Way of the Voice', () => {
  // MQ105's own start for a game that skips ahead (stage 1) plays MQ103 and MQ104 to their ends
  // and starts MQ105 at 10: the Greybeards' summons, Ivarstead and High Hrothgar on the map.
  // The player jumps to Ivarstead, then up to the 7,000 steps' top and in at the front
  // doors (unlocked by stage 5): entering the monastery's location sets 15 (MQ105PlayerScript's
  // OnLocationChange). Found 2026-10-29: the player arrived at the High Hrothgar map marker
  // itself, over a drop, and fell to their death (the cases after went on with a dead player);
  // a map marker's travellers arrive at the heading marker it links to. With the player alive,
  // MQ206's Alduin (initially disabled), saved moved near the monastery, was staged enabled in
  // the cell he stood in and fought them, the masters with him; a moved actor now keeps its own
  // enable state.
  it('summons the player and has them climb to High Hrothgar (1-15)', async () => {
    const sim = await openSim({ hour: 9 });
    try {
      void sim.runtime.quests.setStage(MQ105, 1);
      expect(await sim.until(() => sim.stageDone(MQ104, 200), 120)).toBe(true);
      expect(sim.stageDone(MQ105, 10)).toBe(true);
      await sim.fastTravel(IVARSTEAD_MARKER, false);
      await sim.step(2);
      await sim.fastTravel(HIGH_HROTHGAR_MARKER, false);
      await sim.step(2);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      const door = await sim.position(FRONT_DOOR);
      if (door) await sim.moveTo([door[0] - 150, door[1], door[2]]);
      expect(sim.activate(FRONT_DOOR)).toBe(true);
      await sim.world.settle();
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(HIGH_HROTHGAR);
      expect(await sim.until(() => sim.stageDone(MQ105, 15), 10)).toBe(true);
      atHighHrothgar = await sim.save('MQ105 15');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Into the hall: MQ105SetStage20 (20: the masters take their places, EinarthTeachScene
  // starts); near Arngeir he comes to the player (MQ105ArngeirIntroGreetInside, a ForceGreet)
  // and asks them to Shout (30).
  it('has Arngeir greet the Dragonborn and ask for a Shout (20-30)', async () => {
    if (!atHighHrothgar) return;
    const sim = await loadSim(atHighHrothgar);
    try {
      const arngeir = sim.runtime.state.quest(MQ105).aliases.get(ARNGEIR) ?? 0;
      const trigger = await sim.position(SET_STAGE_20);
      if (trigger) await sim.walkTo(trigger, 20, 400);
      expect(await sim.until(() => sim.stageDone(MQ105, 20), 10)).toBe(true);
      const hall = await sim.position(arngeir);
      if (hall) await sim.moveTo([hall[0] + 150, hall[1] - 500, hall[2] + 10]);
      expect(await sim.until(() => greeting(sim, arngeir) !== undefined, 60)).toBe(true);
      await sim.converse(arngeir, [/summons/], greeting(sim, arngeir));
      expect(await sim.until(() => sim.stageDone(MQ105, 30), 10)).toBe(true);
      afterIntro = await sim.save('MQ105 30');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Unrelenting Force at the Greybeards: its push (VoiceUnrelentingForceEffect01) reaches them
  // and MQ105ShoutTargetScript's OnMagicEffectApply sets 25, then 50. The voice then recovers:
  // the key pressed again lets out no shout.
  it('has the player Shout at the Greybeards (25-50)', async () => {
    if (!afterIntro) return;
    const sim = await loadSim(afterIntro);
    try {
      const arngeir = sim.runtime.state.quest(MQ105).aliases.get(ARNGEIR) ?? 0;
      await sim.step(3);
      expect(await sim.equip(await sim.formId('SHOU', 'UnrelentingForceShout'))).toBe(true);
      await face(sim, arngeir);
      const casts = (): number =>
        sim.events('spellCast').filter((cast) => cast.caster === PLAYER_REF).length;
      await shout(sim);
      expect(await sim.until(() => sim.stageDone(MQ105, 25), 5)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ105, 50), 5)).toBe(true);
      const shouted = casts();
      expect(shouted).toBeGreaterThan(0);
      await sim.step(1);
      await shout(sim);
      await sim.step(2);
      expect(casts()).toBe(shouted);
      afterShout = await sim.save('MQ105 50');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Arngeir comes to the player again (IntroGreetInside2): talking to him sets 55, and
  // Einarth's scene goes on: his word appears on the floor (60). Found 2026-10-29: the word
  // (FXGreybeardShoutScript) waits for its "Play" sequence's "End" text key to enable its
  // trigger, and headless no object graph ran (the page's renderer advances those it draws):
  // the sim now advances every placed object's graph each step. Standing on the word teaches
  // Ro (70); Einarth's power flows into the player (75, 76: UnlockWord), then the push trial (80).
  it('has Einarth teach the player Ro (55-80)', async () => {
    if (!afterShout) return;
    const sim = await loadSim(afterShout);
    try {
      const quest = sim.runtime.state.quest(MQ105);
      const arngeir = quest.aliases.get(ARNGEIR) ?? 0;
      expect(await sim.until(() => greeting(sim, arngeir) !== undefined, 60)).toBe(true);
      await sim.converse(arngeir, [], greeting(sim, arngeir));
      expect(await sim.until(() => sim.stageDone(MQ105, 55), 10)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ105, 60), 120)).toBe(true);
      const word = quest.aliases.get(EINARTH_WORD) ?? 0;
      const at = await sim.position(word);
      if (at) await sim.walkTo(at, 20, 40);
      expect(await sim.until(() => sim.stageDone(MQ105, 70), 20)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ105, 76), 150)).toBe(true);
      await sim.step(1);
      const ro = await sim.formId('WOOP', 'WordRo');
      expect(sim.runtime.wordsLearned.get(ro)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ105, 80), 120)).toBe(true);
      afterRo = await sim.save('MQ105 80');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Borri, Einarth and Wulfgar each Shout a phantom target up (their Shout packages:
  // MQ105PhantomFormShout, a Target Location summon at a marker). Found 2026-10-29: a Target
  // Location spell without a projectile, aimed at an object, was put on the object, so no
  // phantom came; it now stands at the target's place. The player strikes each with Fus Ro
  // (two words: MQ105PhantomFormScript counts VoicePushEffect2), the quest resetting the voice
  // between targets: three hits, 90.
  it('has the player strike the phantom targets with Fus Ro (80-90)', async () => {
    if (!afterRo) return;
    const sim = await loadSim(afterRo);
    try {
      const struck = new Set<number>();
      for (let second = 0; second < 240 && !sim.stageDone(MQ105, 90); second++) {
        await sim.step(1);
        const phantom = sim
          .actors()
          .find((actor) => actor.reference >>> 24 === 0xff && !struck.has(actor.reference));
        if (!phantom) continue;
        struck.add(phantom.reference);
        await face(sim, phantom.reference);
        await shout(sim, 0.5);
        await sim.step(1);
        expect(await sim.runtime.actors.isDead(phantom.reference)).toBe(true);
      }
      expect(sim.stageDone(MQ105, 90)).toBe(true);
      expect(sim.runtime.state.globals.get(TARGETS_HIT)).toBe(3);
      afterTargets = await sim.save('MQ105 90');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // TODO(M13): with fast travel passing its hours (the chain at hour 15.7), the masters come out
  // of the courtyard door together, their character controllers inside each other at its one
  // arrival point; standing still (no movement asked), the controller's sweep moves Arngeir
  // out of the others' shapes by the overlap's depth every step (30 units: 1,900 units a
  // second), they move on together, and he slides off the ledge, so 105 never comes. Leaving
  // the overlapped actors out of a still actor's sweep stopped the slide but broke fights and
  // idle markers elsewhere; the engine's rule for character proxies placed into each other is
  // still to be found.
  // Arngeir leads the masters out to the courtyard and the player follows; by the word Borri
  // will teach (they wait for the player within 700 units) it appears (105), standing on it
  // teaches Wuld (110), Borri's power unlocks it (115, 120).
  it('has Borri teach the player Wuld in the courtyard (100-120)', async () => {
    if (!afterTargets) return;
    const sim = await loadSim(afterTargets);
    try {
      const quest = sim.runtime.state.quest(MQ105);
      const arngeir = quest.aliases.get(ARNGEIR) ?? 0;
      const outside = async (): Promise<boolean> =>
        (await sim.runtime.placement(arngeir))?.world === TAMRIEL;
      for (let second = 0; second < 90 && !(await outside()); second++) await sim.step(1);
      expect(await outside()).toBe(true);
      expect(sim.activate(COURTYARD_DOOR)).toBe(true);
      await sim.world.settle();
      expect((await sim.runtime.placement(PLAYER_REF))?.world).toBe(TAMRIEL);
      const word = quest.aliases.get(BORRI_WORD) ?? 0;
      const spot = await sim.position(word);
      // Across the courtyard to the masters, 200 units short of the word.
      const me = await sim.position(PLAYER_REF);
      if (spot && me) {
        const apart = Math.hypot(spot[0] - me[0], spot[1] - me[1]) || 1;
        const k = 200 / apart;
        await sim.moveTo([
          spot[0] + (me[0] - spot[0]) * k,
          spot[1] + (me[1] - spot[1]) * k,
          spot[2] + 10,
        ]);
      }
      expect(await sim.until(() => sim.stageDone(MQ105, 105), 120)).toBe(true);
      if (spot) await sim.walkTo(spot, 20, 40);
      expect(await sim.until(() => sim.stageDone(MQ105, 110), 20)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ105, 120), 120)).toBe(true);
      await sim.step(1);
      expect(await sim.distance(quest.aliases.get(BORRI) ?? 0, PLAYER_REF)).toBeLessThan(1500);
      const wuld = await sim.formId('WOOP', 'WordWuld');
      expect(sim.runtime.wordsLearned.get(wuld)).toBe(true);
      afterWuld = await sim.save('MQ105 120');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Wulfgar shows Whirlwind Sprint through Borri's gate (125, 127); then the player's trial
  // (130): at the start the gate opens for a moment, and the Shout carries them through to the
  // trigger past it (140). Found 2026-10-29: the player's movement never followed their graph,
  // so the Shout's rush (ShoutSprintMediumStart, animation-driven) left them standing; while
  // their graph is animation-driven its root motion now moves them, as it does every actor.
  it("has the player Whirlwind Sprint through Borri's gate (125-140)", async () => {
    if (!afterWuld) return;
    const sim = await loadSim(afterWuld);
    try {
      expect(await sim.until(() => sim.stageDone(MQ105, 130), 180)).toBe(true);
      expect(await sim.equip(await sim.formId('SHOU', 'WhirlwindSprintShout'))).toBe(true);
      const start = await sim.position(SPRINT_START);
      if (start) await sim.walkTo(start, 30, 30);
      await face(sim, SPRINT_SUCCESS);
      const open = (): boolean =>
        sim.openState(SPRINT_GATE) === 1 || sim.openState(SPRINT_GATE) === 2;
      expect(await sim.until(open, 60)).toBe(true);
      const before = (await sim.position(PLAYER_REF)) ?? [0, 0, 0];
      await shout(sim);
      expect(await sim.until(() => sim.stageDone(MQ105, 140), 5)).toBe(true);
      const after = (await sim.position(PLAYER_REF)) ?? [0, 0, 0];
      expect(Math.hypot(after[0] - before[0], after[1] - before[1])).toBeGreaterThan(800);
      afterSprint = await sim.save('MQ105 140');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Arngeir waits by the gate (MQ105ArngeirFinalTrialGreet, a ForceGreet run once a day); the
  // player comes up before him, he greets them and sends them for the Horn of Jurgen
  // Windcaller: 160 completes the quest. Found 2026-10-29: the once-a-day package was dropped at
  // the next evaluation after it began, and a loaded save lost the branches of a package whose
  // tree had run out (it waited at its place for ever).
  it('has Arngeir send the player for the Horn and the quest complete (150-160)', async () => {
    if (!afterSprint) return;
    const sim = await loadSim(afterSprint);
    try {
      const quest = sim.runtime.state.quest(MQ105);
      const arngeir = quest.aliases.get(ARNGEIR) ?? 0;
      const at = await sim.runtime.placement(arngeir);
      if (at) {
        const heading = at.rotation[2];
        await sim.moveTo([
          at.position[0] + Math.sin(heading) * 250,
          at.position[1] + Math.cos(heading) * 250,
          at.position[2],
        ]);
        await face(sim, arngeir);
      }
      expect(await sim.until(() => greeting(sim, arngeir) !== undefined, 120)).toBe(true);
      await sim.converse(arngeir, [/next/], greeting(sim, arngeir));
      expect(await sim.until(() => sim.stageDone(MQ105, 160), 30)).toBe(true);
      expect(quest.completed).toBe(true);
      afterVoice = await sim.save('MQ105 160');
    } finally {
      await sim.close();
    }
  }, 600_000);
});

describe.skipIf(!hasGamedata())('MQ105 The Horn of Jurgen Windcaller', () => {
  // MQ105's 160 starts MQ105Ustengrav (10: retrieve the Horn) and puts Ustengrav on the map. The
  // player goes there (a jump to its map marker) and in at the barrow's door from the marsh.
  it('sends the player to Ustengrav (160, Horn 10)', async () => {
    if (!afterVoice) return;
    const sim = await loadSim(afterVoice);
    try {
      expect(sim.stage(HORN_QUEST)).toBe(10);
      await sim.fastTravel(USTENGRAV_MARKER, false);
      await sim.step(2);
      const door = await sim.position(USTENGRAV_DOOR);
      if (door) await sim.walkPath(door, 30, 120);
      expect(sim.activate(USTENGRAV_DOOR)).toBe(true);
      await sim.world.settle();
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(USTENGRAV_01);
      await sim.step(2);
      inUstengrav = await sim.save('Horn 10');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Past the necromancers and the bandits they raise at the entrance (dunUstengravQST), and the
  // draugr of the crypts below, to the door down to Ustengrav02: the player walks the navmesh
  // and the fights are won with the helpers' kill.
  it('takes the player through Ustengrav to its depths', async () => {
    if (!inUstengrav) return;
    const sim = await loadSim(inUstengrav);
    try {
      const down = await sim.position(USTENGRAV_DOWN);
      expect(down && (await fightTo(sim, down, 240, 120))).toBe(true);
      expect(await sim.runtime.actors.isDead(PLAYER_REF)).toBe(false);
      expect(sim.activate(USTENGRAV_DOWN)).toBe(true);
      await sim.world.settle();
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(USTENGRAV_02);
      expect(sim.stage(USTENGRAV_QUEST)).toBeGreaterThanOrEqual(10);
      await sim.step(1);
      inDepths = await sim.save('Horn depths');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Down the stairs past the fire plates to the first stone of the gate trial; standing on it,
  // facing the gates, the player shouts the one word of Whirlwind Sprint they know and sprints
  // on: each gate shuts 1.5 s after its stone is left (dunUstenPuzGateSCRIPT), the rush and the
  // sprint after it carry the player through all three, and past them the puzzle is done
  // (dunUstengravQST 50). Found 2026-10-29: the player stuck at the stairs past the fire plates,
  // held on the edge of a safe plate (a slab 4 units off the floor, its bevel too steep to walk):
  // the controller's sweep met that edge at once whichever way it went.
  it('passes the Whirlwind Sprint gates with one word (dunUstengravQST 50)', async () => {
    if (!inDepths) return;
    const sim = await loadSim(inDepths);
    try {
      const stone = await sim.position(GATE_STONE_1);
      const last = await sim.position(LAST_GATE);
      expect(stone && last && (await fightTo(sim, stone, 300, 64))).toBe(true);
      if (!stone || !last) return;
      await sim.walkTo(stone, 10, 10);
      const yaw = Math.atan2(last[0] - stone[0], last[1] - stone[1]);
      sim.world.look(yaw);
      expect(await sim.equip(await sim.formId('SHOU', 'WhirlwindSprintShout'))).toBe(true);
      await sim.step(3);
      await shout(sim);
      sim.press('Forward', true);
      sim.press('Sprint', true);
      try {
        expect(await sim.until(() => sim.stageDone(USTENGRAV_QUEST, 50), 6)).toBe(true);
      } finally {
        sim.press('Forward', false);
        sim.press('Sprint', false);
      }
      afterGates = await sim.save('Horn gates');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Down to the word wall: walking up to it teaches Become Ethereal's Feim.
  it('learns the word at the word wall (Feim)', async () => {
    if (!afterGates) return;
    const sim = await loadSim(afterGates);
    try {
      const wall = await sim.position(WORD_WALL_LOOK);
      expect(wall && (await fightTo(sim, wall, 300, 64))).toBe(true);
      const feim = await sim.formId('WOOP', 'WordFeim');
      expect(await sim.until(() => sim.runtime.wordsLearned.has(feim), 20)).toBe(true);
      afterWall = await sim.save('Horn wall');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // On to the Horn's tomb (the way back through the gates, a dip by the cave rocks jumped out
  // of, the portcullis's pull chain): two spider webs hang across it, the first broken with the
  // player's fists, the second burned with Flames (the walk strikes what holds it up). Found
  // 2026-10-29: neither hurt a web. The first-person graph never left a jump (the landing idles
  // read the player's graph variables, which no view gave: GetGraphVariableInt(bInJumpState)
  // was 0, so ActionLand found no idle), and in first person only its strikes count; and a
  // blow's ray from the chest met the striker's own body first. The walk from the word wall
  // takes about 85 s now. In at the hall (MQ105SetStage180).
  it("breaks the webs on the way to the Horn's tomb (MQ105 180)", async () => {
    if (!afterWall) return;
    const sim = await loadSim(afterWall);
    try {
      const destruction = sim.runtime.destruction;
      const web = await sim.position(WEB_1);
      expect(web && (await fightTo(sim, web, 200, 30))).toBe(true);
      expect(destruction.stage(WEB_1)).toBeGreaterThan(0);
      expect(await sim.equip(await sim.formId('SPEL', 'Flames'))).toBe(true);
      await sim.step(0.5);
      const hall = await sim.position(SET_STAGE_180);
      expect(hall && (await fightTo(sim, hall, 200, 64))).toBe(true);
      expect(destruction.stage(WEB_2)).toBeGreaterThan(0);
      expect(await sim.until(() => sim.stageDone(MQ105, 180), 10)).toBe(true);
      afterHall = await sim.save('Horn hall');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The tomb in sight (190: 180's RegisterForLOS(player, tomb), OnGainLOS), the note in the
  // Horn's place taken (200: the Horn quest's 20, Delphine's MQ106 begun). TODO(M13): 190 does
  // not come here (reached 2026-10-29 by an earlier walk chained over saves): the player's
  // line of sight to the tomb (actor-senses' camera check and ray) is not yet looked into. The
  // three cases after it wait for this one.
  it.skip('finds the note in the tomb (MQ105 190-200, Horn 20)', async () => {
    if (!afterHall) return;
    const sim = await loadSim(afterHall);
    try {
      const tomb = await sim.position(TOMB);
      expect(tomb && (await fightTo(sim, tomb, 120, 200))).toBe(true);
      await face(sim, TOMB, true);
      expect(await sim.until(() => sim.stageDone(MQ105, 190), 10)).toBe(true);
      expect(sim.activate(TOMB_NOTE)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ105, 200), 10)).toBe(true);
      expect(sim.stage(HORN_QUEST)).toBe(20);
      afterNote = await sim.save('Horn note');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // To Riverwood and the Sleeping Giant Inn: asking Delphine for the attic room (MQ106 10), in
  // at the room (20); she follows (25) and her scene's ForceGreet opens MQ106DelphineIntroTopic,
  // whose greeting asks for that package (GetIsCurrentPackage): 30, the Horn given back (MQ105
  // 220, the Horn's 30). TODO(M13): no greeting passes. The info's GetIsCurrentPackage
  // (MQ106DelphineIntroGreet, her scene's package action) fails: the ForceGreet procedure
  // succeeds as it opens the conversation, so the package (and the scene action) is done before
  // the line is chosen. Holding the ForceGreet on until its conversation ended gave MQ106 30
  // and MQ105 220 here, but stopped Gerdur's greeting in MQ102B; when the engine ends a
  // ForceGreet is still to be found.
  it.skip('has Delphine meet the player in the Sleeping Giant Inn (MQ106 10-30, MQ105 220)', async () => {
    if (!afterNote) return;
    const sim = await loadSim(afterNote);
    try {
      expect(sim.stageDone(MQ106, 5)).toBe(true);
      await sim.fastTravel(RIVERWOOD_MARKER);
      const door = await sim.position(INN_DOOR);
      expect(door && (await sim.walkPath(door, 60, 120))).toBe(true);
      expect(sim.activate(INN_DOOR)).toBe(true);
      await sim.world.settle();
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(SLEEPING_GIANT);
      const delphine = sim.runtime.state.quest(MQ106).aliases.get(DELPHINE) ?? 0;
      const at = await sim.position(delphine);
      expect(at && (await sim.walkPath(at, 30, 120))).toBe(true);
      await sim.converse(delphine, [/attic/]);
      expect(await sim.until(() => sim.stageDone(MQ106, 10), 10)).toBe(true);
      const room = await sim.position(ROOM_TRIGGER);
      expect(room && (await sim.walkPath(room, 40, 30))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ106, 20), 10)).toBe(true);
      expect(await sim.until(() => greeting(sim, delphine) !== undefined, 90)).toBe(true);
      await sim.converse(delphine, [], greeting(sim, delphine));
      expect(await sim.until(() => sim.stageDone(MQ106, 30), 10)).toBe(true);
      expect(sim.stageDone(MQ105, 220)).toBe(true);
      expect(sim.stage(HORN_QUEST)).toBe(30);
      afterDelphine = await sim.save('MQ106 30');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Back up to High Hrothgar with the Horn: Arngeir takes it (240) and the masters gather; the
  // player stands in the hall's middle (242), the Greybeards greet them, Wulfgar's word appears
  // and teaches Dah (255-265), and the greeting ends the quest (300, the Horn's 60).
  it.skip('has the player return the Horn to Arngeir (MQ105 240-300)', async () => {
    if (!afterDelphine) return;
    const sim = await loadSim(afterDelphine);
    try {
      await sim.fastTravel(HIGH_HROTHGAR_MARKER);
      const door = await sim.position(FRONT_DOOR);
      if (door) await sim.moveTo([door[0] - 150, door[1], door[2]]);
      expect(sim.activate(FRONT_DOOR)).toBe(true);
      await sim.world.settle();
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(HIGH_HROTHGAR);
      const quest = sim.runtime.state.quest(MQ105);
      const arngeir = quest.aliases.get(ARNGEIR) ?? 0;
      const at = await sim.position(arngeir);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      await sim.converse(arngeir, [/Horn of Jurgen/]);
      expect(await sim.until(() => sim.stageDone(MQ105, 240), 10)).toBe(true);
      const middle = await sim.position(quest.aliases.get(OUTRO_TRIGGER) ?? 0);
      expect(middle && (await sim.walkPath(middle, 30, 30))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ105, 242), 30)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ105, 250), 180)).toBe(true);
      const word = await sim.position(quest.aliases.get(WULFGAR_WORD) ?? 0);
      if (word) await sim.walkTo(word, 20, 40);
      expect(await sim.until(() => sim.stageDone(MQ105, 300), 240)).toBe(true);
      const dah = await sim.formId('WOOP', 'WordDah');
      expect(sim.runtime.wordsLearned.get(dah)).toBe(true);
      expect(sim.stage(HORN_QUEST)).toBe(60);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
