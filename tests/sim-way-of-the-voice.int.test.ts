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
/** MQ105SetStage180 (the tomb's hall), the tomb (MQ105TombActivator) and the note on it. */
const SET_STAGE_180 = 0x7a507;
const TOMB = 0xc65ad;
const TOMB_NOTE = 0xc65ae;

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
async function face(sim: Sim, reference: number): Promise<void> {
  const at = await sim.position(reference);
  const me = await sim.position(PLAYER_REF);
  if (at && me) sim.world.look(Math.atan2(at[0] - me[0], at[1] - me[1]));
}

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

  // Down to the word wall (Become Ethereal's Feim: walking up to it teaches the word), then on
  // to the Horn's tomb: in at its hall (MQ105SetStage180), the tomb in sight (190), the note
  // left in the Horn's place taken (200: the Horn quest's 20, Delphine's MQ106 begun). Found
  // 2026-10-29: two spider webs across the way to the tomb never let the player through once
  // burnt: the headless world never brought destructible objects' looks (and their collision)
  // up to date. TODO(M13): Delphine in Riverwood (MQ106 10 by the attic room line, 20 by the
  // room's trigger: both pass) then begins her intro scene (25), but no info of
  // MQ106DelphineIntroTopic passes its conditions, so MQ106 30 and the Horn's 220 never come;
  // and the return to Arngeir (240-300).
  it('learns the word wall and finds the note in the tomb (MQ105 180-200, Horn 20)', async () => {
    if (!afterGates) return;
    const sim = await loadSim(afterGates);
    try {
      const wall = await sim.position(WORD_WALL_LOOK);
      expect(wall && (await fightTo(sim, wall, 300, 64))).toBe(true);
      const feim = await sim.formId('WOOP', 'WordFeim');
      expect(await sim.until(() => sim.runtime.wordsLearned.has(feim), 20)).toBe(true);
      const hall = await sim.position(SET_STAGE_180);
      expect(hall && (await fightTo(sim, hall, 400, 64))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ105, 180), 10)).toBe(true);
      const tomb = await sim.position(TOMB);
      expect(tomb && (await fightTo(sim, tomb, 120, 80))).toBe(true);
      await face(sim, TOMB);
      expect(await sim.until(() => sim.stageDone(MQ105, 190), 10)).toBe(true);
      expect(sim.activate(TOMB_NOTE)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ105, 200), 10)).toBe(true);
      expect(sim.stage(HORN_QUEST)).toBe(20);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
