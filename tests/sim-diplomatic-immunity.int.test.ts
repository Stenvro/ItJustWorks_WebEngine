// Integration test: MQ201 "Diplomatic Immunity" on the headless simulation, played through as
// the player plays it, segment by segment (each one loads the save the one before it left).
// Skipped without game data.

import { describe, expect, it } from 'vitest';
import { containerModel } from '../src/shell/container-menu.ts';
import { inventoryModel } from '../src/shell/inventory-menu.ts';
import { hasGamedata, loadSim, openSim, PLAYER_REF, type Sim } from './helpers/sim.ts';

const MQ106 = 0x32926;
const MQ201 = 0x35d5f;
/** MQ201's Delphine and Malborn aliases. */
const DELPHINE = 44;
const MALBORN = 51;
/** MQ201's Elenwen and Razelan aliases. */
const ELENWEN = 65;
const RAZELAN = 111;
/** The trigger beyond the bar's backroom door (MQ201's ExitPartyTrigger). */
const EXIT_PARTY_TRIGGER = 0x68844;
/** MQ201PartyDistractionDrunkSceneNEW, MQ201LeavePartyScene. */
const DRUNK_SCENE = 0x63b58;
const LEAVE_PARTY_SCENE = 0x665ee;
/** RiverwoodMapMarker, the Sleeping Giant Inn's door from the street and the inn. */
const RIVERWOOD_MARKER = 0x162a4;
const INN_DOOR = 0x13424;
const SLEEPING_GIANT = 0x133c6;
/** MQ201's hidden holding container (an actor: PlayerGearContainerHidden). */
const GEAR_HIDDEN = 73;
/** Solitude's gate from the road (SolitudeOpeningGateExterior), the Winking Skeever's door
 * from the street (SolitudeWinkingSkeeverDoorRef) and the inn. */
const GATE_OUTSIDE = 0x101d9e;
const SKEEVER_DOOR = 0x37f25;
const WINKING_SKEEVER = 0x16a0e;
/** The Winking Skeever's door to the street, and Solitude's gate to the road (SolitudeOpeningGate). */
const SKEEVER_INSIDE = 0x16a8a;
const GATE_INSIDE = 0x101d9d;
/** MQ201's ExteriorGuardDay1 alias, the Embassy's front door (ThalmorEmbassyFrontDoor). */
const EXTERIOR_GUARD = 102;
const EMBASSY_FRONT_DOOR = 0x361ee;
/** The Embassy (ThalmorEmbassy02, the party's floor). */
const EMBASSY = 0x7c98b;
/** MQ201PartyIntroScene. */
const PARTY_INTRO_SCENE = 0x42166;
/** MQ201DelphineIntroScene. */
const INTRO_SCENE = 0x35d60;
const MQ202 = 0x36191;
/** MQ201's PlayerGearContainer, ElenwenOfficeContainer, ElenwenOfficeNote, Prisoner,
 * TortureChamberContainer, TortureChamberNote (the dossier), EscapeSceneGuard1 and 2,
 * DungeonEscapeTrapDoor aliases. */
const GEAR_CHEST = 71;
const OFFICE_CHEST = 55;
const OFFICE_NOTE = 76;
const PRISONER = 78;
const TORTURE_CHEST = 80;
const DOSSIER = 81;
const ESCAPE_GUARD_1 = 93;
const ESCAPE_GUARD_2 = 94;
const TRAPDOOR = 113;
/** MQ201KitchenScene, MQ201ElenwenOfficeScene, MQ201TortureChamberScene. */
const KITCHEN_SCENE = 0x361f2;
const OFFICE_SCENE = 0x39f28;
const TORTURE_SCENE = 0x3a1d8;
/** A point beyond MQ201SetStage160, the doorway out of the kitchen's side of the Embassy. */
const KITCHEN_EXIT_BEYOND: [number, number, number] = [-864, -800, 0];
/** Before the cabinet in Delphine's room at the inn (MQDelphineSecretDoor). */
const SECRET_CABINET: [number, number, number] = [-634, 760, 0];
/** The Embassy's lower back door (to ThalmorBackExitLower), the courtyard's door into
 * Elenwen's solar (ThalmorEmbassyDoorIntoElenwensSolar), MQ201Stage180, the solar's door to
 * the dungeon (ThalmorEmbassyGuardsToDungeonDoor), Reeking Cave's mouth. */
const BACK_EXIT_LOWER = 0x7cb74;
const SOLAR_DOOR = 0x3654a;
const STAGE_180 = 0x39f1d;
const DUNGEON_DOOR = 0x7decd;
const CAVE_MOUTH = 0x2fb8e;
/** ThalmorEmbassy02 (the solar), ThalmorEmbassy03 (the dungeon), ThalmorEmbassy05 (Reeking
 * Cave). */
const SOLAR = 0x7dcfc;
const DUNGEON = 0x362d8;
const REEKING_CAVE = 0x27f1a;

/** The topic an actor's ForceGreet opened the dialogue menu with (undefined: none yet). */
function greeting(sim: Sim, actor: number): number | undefined {
  return sim.menus().find((menu) => menu.menu === 'Dialogue Menu' && menu.reference === actor)
    ?.opening;
}

/** The game with the player out of the Embassy, at Reeking Cave's mouth (stage 230). */
let afterEscape: Uint8Array | undefined;
/** The game with Etienne freed and the dossier read (stage 220). */
let afterDossier: Uint8Array | undefined;
/** The game with Elenwen's note read and the dungeon's key taken (stage 190). */
let afterSolar: Uint8Array | undefined;
/** The game with the player's gear back and out of the kitchen (stage 170). */
let afterKitchen: Uint8Array | undefined;
/** The game with the player through the backroom door with Malborn (stage 140). */
let afterParty: Uint8Array | undefined;
/** The game with the player in the Embassy (stage 105). */
let afterGate: Uint8Array | undefined;
/** The game with the player arrived at the Embassy (stage 100). */
let afterRide: Uint8Array | undefined;
/** The item the player gave Malborn to smuggle in. */
let smuggled: number | undefined;
/** The game with Delphine's plan heard and Malborn waiting in Solitude (stage 40). */
let afterPlan: Uint8Array | undefined;
/** The game with the gear handed to Malborn (stage 70). */
let afterMalborn: Uint8Array | undefined;

/** The first item a container holds of the first record type it has of these (its base form). */
async function firstOfType(
  sim: Sim,
  container: number,
  types: readonly string[],
): Promise<number | undefined> {
  const held = await sim.runtime.inventory(container);
  for (const type of types) {
    for (const [form, count] of held) {
      if (count > 0 && (await sim.db.get(form))?.type === type) return form;
    }
  }
  return undefined;
}

/** The player puts an item into a container as the container menu does (ItemTransfer). */
async function handOver(sim: Sim, container: number, item: number, count = 1): Promise<boolean> {
  const session = sim.world.session;
  const inventory = inventoryModel(session, sim.world.terminal, () => Promise.resolve());
  const model = containerModel(session, container, inventory, true);
  const entry = (await model.view()).entries.find(
    (candidate) => candidate.formId === item && !candidate.container,
  );
  if (!entry || !model.transfer) return false;
  let done = false;
  const work = model.transfer(entry, count, false).finally(() => {
    done = true;
  });
  await sim.until(() => done, 10);
  await work;
  return true;
}

/** The player takes everything from a container as the container menu's Take All does. */
async function takeAll(sim: Sim, container: number): Promise<void> {
  const session = sim.world.session;
  const inventory = inventoryModel(session, sim.world.terminal, () => Promise.resolve());
  const model = containerModel(session, container, inventory);
  let done = false;
  const work = (model.takeAll?.() ?? Promise.resolve()).finally(() => {
    done = true;
  });
  await sim.until(() => done, 10);
  await work;
}

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

/** The player walks to a point a few seconds at a time, fighting off those who attack. */
async function walkFighting(
  sim: Sim,
  target: readonly [number, number, number],
  seconds: number,
  reach: number,
): Promise<boolean> {
  const until = sim.time + seconds;
  while (sim.time < until) {
    const there = await sim.walkPath([...target], Math.min(5, until - sim.time), reach);
    await fendOff(sim);
    if (there) return true;
  }
  return false;
}

describe.skipIf(!hasGamedata())('MQ201 Diplomatic Immunity', () => {
  // MQ201's own start for a game that skips ahead (stage 0 sets 1: MQ105 and MQ106 played to
  // their ends), then MQ106's last talk with Delphine (30: "Meet me back in Riverwood", MQ106
  // 200). Coming into the Sleeping Giant sets 35 (MQ201PlayerScript's OnLocationChange: Delphine
  // at the inn, MQ201DelphineIntroScene); she takes the player down to the secret room and tells
  // the plan ("Good to see you."): Malborn in Solitude's Winking Skeever, the party, the
  // stables. "I'll see you in Solitude" ends it (40: Malborn moved to the inn).
  it('has Delphine tell the player her plan in Riverwood (30-40)', async () => {
    const sim = await openSim({ hour: 10 });
    try {
      void sim.runtime.quests.setStage(MQ201, 0);
      expect(await sim.until(() => sim.stageDone(MQ201, 1), 60)).toBe(true);
      void sim.runtime.quests.setStage(MQ201, 30);
      expect(await sim.until(() => sim.stageDone(MQ106, 200), 30)).toBe(true);
      // The skip's own chain (the earlier quests' stages and what they move) runs out first.
      await sim.step(30);
      await sim.fastTravel(RIVERWOOD_MARKER, false);
      await sim.step(2);
      const door = await sim.position(INN_DOOR);
      expect(door && (await sim.walkPath(door, 60, 120))).toBe(true);
      expect(sim.activate(INN_DOOR)).toBe(true);
      await sim.world.settle();
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(SLEEPING_GIANT);
      expect(await sim.until(() => sim.stageDone(MQ201, 35), 10)).toBe(true);
      expect(await sim.until(() => sim.runtime.scenes.isPlaying(INTRO_SCENE), 10)).toBe(true);
      const delphine = sim.runtime.state.quest(MQ201).aliases.get(DELPHINE) ?? 0;
      await sim.step(20);
      const at = await sim.position(delphine);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      await sim.converse(
        delphine,
        [
          /Good to see you/,
          /take long/,
          /your plan/,
          /contact/,
          /this party/,
          /inside the Embassy/,
          /see you in Solitude/,
        ],
        greeting(sim, delphine),
      );
      expect(await sim.until(() => sim.stageDone(MQ201, 40), 10)).toBe(true);
      afterPlan = await sim.save('MQ201 40');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // To Solitude: in at its gate (SolitudeOpeningGateExterior, from the road), through the
  // town to the Winking Skeever, where Malborn waits (40 moved him to MalbornMeet). "Our mutual
  // friend sent me." (50), "I'm ready to go.", "I'm ready. Here's what I'll need." (70:
  // Malborn's hidden holding container opened for trading, as a follower's). The player hands
  // him gear to smuggle in; Delphine waits at the Solitude stables.
  it('has the player meet Malborn in the Winking Skeever and hand him gear (50-70)', async () => {
    if (!afterPlan) return;
    const sim = await loadSim(afterPlan);
    try {
      await sim.fastTravel(GATE_OUTSIDE, false);
      await sim.step(1);
      expect(sim.activate(GATE_OUTSIDE)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      const door = await sim.position(SKEEVER_DOOR);
      expect(door && (await sim.walkPath(door, 60, 120))).toBe(true);
      expect(sim.activate(SKEEVER_DOOR)).toBe(true);
      await sim.world.settle();
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(WINKING_SKEEVER);
      const malborn = sim.runtime.state.quest(MQ201).aliases.get(MALBORN) ?? 0;
      const at = await sim.position(malborn);
      expect(at && (await sim.walkPath(at, 60, 120))).toBe(true);
      await sim.converse(malborn, [/mutual friend/, /Here.s what/]);
      expect(sim.stageDone(MQ201, 50)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ201, 70), 10)).toBe(true);
      // The trade's container menu (OpenInventory): the player gives Malborn gear.
      const hidden = sim.runtime.state.quest(MQ201).aliases.get(GEAR_HIDDEN) ?? 0;
      expect(sim.menus().at(-1)).toMatchObject({ menu: 'Container Menu', reference: hidden });
      smuggled = await firstOfType(sim, PLAYER_REF, ['WEAP', 'ARMO', 'ALCH', 'BOOK']);
      expect(smuggled && (await handOver(sim, hidden, smuggled))).toBe(true);
      expect(await sim.runtime.itemCount(hidden, smuggled ?? 0)).toBe(1);
      afterMalborn = await sim.save('MQ201 70');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Out of the inn, through the gate and down to the stables, where Delphine waits (70 moved
  // her there). "I'm ready to go." "Yes, Malborn's all set." (90: the party clothes and the
  // invitation given; what Malborn holds goes into the Embassy). Dressed for the party (her
  // "I'm ready to go." asks for the outfit and the boots worn, no armor), "I'm ready. Keep the
  // rest of my things safe for me." (95): MQ201BoardCarriageScene. Its phase 1 (98) takes the
  // player's things for Delphine and seats them in the carriage; seated, the ride (100): the
  // player arrives at the Embassy's party.
  it('has Delphine dress the player and send them to the Embassy by carriage (90-100)', async () => {
    if (!afterMalborn) return;
    const sim = await loadSim(afterMalborn);
    try {
      expect(sim.activate(SKEEVER_INSIDE)).toBe(true);
      await sim.world.settle();
      const gate = await sim.position(GATE_INSIDE);
      expect(gate && (await sim.walkPath(gate, 60, 120))).toBe(true);
      expect(sim.activate(GATE_INSIDE)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      const delphine = sim.runtime.state.quest(MQ201).aliases.get(DELPHINE) ?? 0;
      const at = await sim.position(delphine);
      expect(at && (await sim.walkPath(at, 80, 300))).toBe(true);
      await sim.converse(delphine, [/ready to go/, /all set/]);
      expect(await sim.until(() => sim.stageDone(MQ201, 90), 10)).toBe(true);
      const outfit = await sim.formId('ARMO', 'MQ201PartyOutfit');
      const boots = await sim.formId('ARMO', 'MQ201PartyBoots');
      expect(await sim.runtime.itemCount(PLAYER_REF, outfit)).toBe(1);
      expect(await sim.equip(outfit)).toBe(true);
      expect(await sim.equip(boots)).toBe(true);
      await sim.converse(delphine, [/ready to go/, /Keep the rest/]);
      expect(await sim.until(() => sim.stageDone(MQ201, 95), 10)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ201, 98), 30)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ201, 100), 60)).toBe(true);
      // 100's fragment fades out, puts the player at the party's arrival marker and begins the
      // party's intro scene.
      expect(await sim.until(() => sim.runtime.scenes.isPlaying(PARTY_INTRO_SCENE), 20)).toBe(true);
      const guard = sim.runtime.state.quest(MQ201).aliases.get(EXTERIOR_GUARD) ?? 0;
      expect(await sim.distance(PLAYER_REF, guard)).toBeLessThan(2000);
      expect(await sim.runtime.itemCount(PLAYER_REF, outfit)).toBe(1);
      afterRide = await sim.save('MQ201 100');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // At the Embassy's gate: MQ201PartyIntroScene, Razelan arriving late with the player; the
  // gate guard's ForceGreet asks for the invitation ("Here you go.": 102, the Embassy's door
  // unlocked). In at the front door (MQ201EmbassyFrontDoorScript lets the player through).
  it('has the guard let the player into the Embassy with the invitation (102-105)', async () => {
    if (!afterRide) return;
    const sim = await loadSim(afterRide);
    try {
      const quest = sim.runtime.state.quest(MQ201);
      const guard = quest.aliases.get(EXTERIOR_GUARD) ?? 0;
      // Up to the gate, where the guard waits (MQ201GuardForcegreetAtParty: the player within
      // 300 units of his post, detected).
      const post = await sim.position(guard);
      expect(post && (await sim.walkPath(post, 60, 200))).toBe(true);
      expect(await sim.until(() => greeting(sim, guard) !== undefined, 90)).toBe(true);
      await sim.converse(guard, [/Show invitation/], greeting(sim, guard));
      expect(await sim.until(() => sim.stageDone(MQ201, 102), 10)).toBe(true);
      const door = await sim.position(EMBASSY_FRONT_DOOR);
      expect(door && (await sim.walkPath(door, 60, 120))).toBe(true);
      expect(sim.activate(EMBASSY_FRONT_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(2);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(EMBASSY);
      expect(await sim.until(() => sim.stageDone(MQ201, 105), 10)).toBe(true);
      afterGate = await sim.save('MQ201 105');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // The party: Elenwen's ForceGreet welcomes her guest ("My name is ...": 108); Malborn,
  // behind the bar ("What can I get for you?": 110), pours a drink ("I'd like a drink.": the
  // Colovian brandy). Razelan comes in once the gate guard has seen his invitation and sits
  // down; he takes the drink gladly and, asked to cause a scene, makes one
  // (PartyDistractionDrunkSceneNEW, with MQ201LeavePartyScene). Found 2026-11-03: Razelan's
  // travel to the gate guard (MQ201RazelanToExteriorGuard: an alias's reference, a moving
  // actor) was dropped once he was out of the Embassy's door, so the intro scene never ended
  // and held him; and his blocking topic (no text) was never said, so the party's dialogue with
  // him was shut.
  it('has Razelan cause a scene while the player slips away with Malborn (110-140)', async () => {
    if (!afterGate) return;
    const sim = await loadSim(afterGate);
    try {
      const quest = sim.runtime.state.quest(MQ201);
      const elenwen = quest.aliases.get(ELENWEN) ?? 0;
      const malborn = quest.aliases.get(MALBORN) ?? 0;
      const razelan = quest.aliases.get(RAZELAN) ?? 0;
      expect(await sim.until(() => greeting(sim, elenwen) !== undefined, 60)).toBe(true);
      await sim.converse(elenwen, [/Pleased to meet you/], greeting(sim, elenwen));
      expect(await sim.until(() => sim.stageDone(MQ201, 108), 10)).toBe(true);
      const bar = await sim.position(malborn);
      expect(bar && (await sim.walkPath(bar, 60, 120))).toBe(true);
      await sim.converse(malborn, [/talk to you/]);
      expect(await sim.until(() => sim.stageDone(MQ201, 110), 10)).toBe(true);
      await sim.converse(malborn, [/like a drink/]);
      const drink = await sim.formId('ALCH', 'MQ201Drink');
      expect(await sim.runtime.itemCount(PLAYER_REF, drink)).toBe(1);
      // Razelan comes in after the player, once the gate guard has seen his invitation
      // (MQ201PartyIntroScene's end), and sits down at the party (MQ201RazelanSitDrunk).
      const seated = async (): Promise<boolean> =>
        !sim.runtime.scenes.isPlaying(PARTY_INTRO_SCENE) &&
        (await sim.runtime.placement(razelan))?.cell === EMBASSY &&
        sim.package(razelan)?.procedure === 'Sit';
      let sat = false;
      for (let second = 0; second < 180 && !sat; second += 2) {
        await sim.step(2);
        sat = await seated();
      }
      expect(sat).toBe(true);
      const guest = await sim.position(razelan);
      expect(guest && (await sim.walkPath(guest, 60, 120))).toBe(true);
      await sim.converse(razelan, [
        /brought you a drink/,
        /something you could do/,
        /cause a scene/,
      ]);
      expect(await sim.until(() => sim.runtime.scenes.isPlaying(DRUNK_SCENE), 10)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(LEAVE_PARTY_SCENE)).toBe(true);
      // Everyone watches Razelan (PartyDistractionState 2); the player joins Malborn by the
      // backroom door (its phase 0: within 256 units of his waiting marker), he opens it (its
      // phase 1) and the player goes through (ExitPartyTrigger: 140).
      const leavePhase = (): number =>
        sim.runtime.scenes.snapshot().find((scene) => scene.scene === LEAVE_PARTY_SCENE)?.phase ??
        -1;
      const waiting = await sim.position(malborn);
      expect(waiting && (await sim.walkPath(waiting, 60, 150))).toBe(true);
      expect(await sim.until(() => leavePhase() >= 1, 60)).toBe(true);
      const exit = await sim.position(EXIT_PARTY_TRIGGER);
      expect(exit && (await sim.walkPath(exit, 30, 40))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ201, 140), 20)).toBe(true);
      expect(await sim.runtime.itemCount(PLAYER_REF, drink)).toBe(0);
      // 140's fragment shuts the party behind them (the exit trigger disabled, the door barred).
      await sim.step(2);
      afterParty = await sim.save('MQ201 140');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Through the backroom door: MQ201KitchenScene. Malborn leads the player to the kitchen and
  // talks Tsavani round (its phase 8: 150); the gear chest by the backroom (PlayerGearContainer,
  // opened after 140: 170) holds what he smuggled in. Out of the kitchen across
  // MQ201SetStage160's doorway (160: the Thalmor's combat faction the player's enemy, the
  // scene stopped, Malborn waiting in the kitchen).
  it('has Malborn lead the player through the kitchen to the gear chest (150-170)', async () => {
    if (!afterParty) return;
    const sim = await loadSim(afterParty);
    try {
      const quest = sim.runtime.state.quest(MQ201);
      const malborn = quest.aliases.get(MALBORN) ?? 0;
      // The player keeps up with him.
      for (let second = 0; second < 180 && !sim.stageDone(MQ201, 150); second += 2) {
        const at = await sim.position(malborn);
        if (at && ((await sim.distance(PLAYER_REF, malborn)) ?? 0) > 250) {
          await sim.walkPath(at, 10, 150);
        } else await sim.step(2);
      }
      expect(sim.stageDone(MQ201, 150)).toBe(true);
      const chest = quest.aliases.get(GEAR_CHEST) ?? 0;
      const at = await sim.position(chest);
      expect(at && (await sim.walkPath(at, 30, 100))).toBe(true);
      expect(sim.activate(chest)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ201, 170), 5)).toBe(true);
      await takeAll(sim, chest);
      if (smuggled !== undefined) {
        expect(await sim.runtime.itemCount(PLAYER_REF, smuggled)).toBeGreaterThan(0);
      }
      // Across the doorway out of the kitchen.
      expect(await sim.walkPath(KITCHEN_EXIT_BEYOND, 60, 30)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ201, 160), 5)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(KITCHEN_SCENE)).toBe(false);
      afterKitchen = await sim.save('MQ201 170');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Out through the Embassy's lower back door (the upper one's hall has a navmesh of its own,
  // linked to no other) and across the courtyard to Elenwen's solar, sneaking. Within, past
  // MQ201Stage180 (180: MQ201ElenwenOfficeScene, Rulindil and Gissur talking of Etienne); a
  // Thalmor who sees the player fights (the player's blows: TODO(M13), the sim has no aimed
  // attacks yet, so the one fighting them is killed). The scene's end sets 185 (Rulindil to
  // the interrogation chamber, Gissur to the courtyard). Elenwen's chest holds her note (read:
  // 190) and the dungeon's key.
  it("has the player sneak to Elenwen's solar and overhear Rulindil and Gissur (180-190)", async () => {
    if (!afterKitchen) return;
    const sim = await loadSim(afterKitchen);
    try {
      const quest = sim.runtime.state.quest(MQ201);
      sim.world.player.sneaking = true;
      const back = await sim.position(BACK_EXIT_LOWER);
      expect(back && (await walkFighting(sim, back, 120, 80))).toBe(true);
      expect(sim.activate(BACK_EXIT_LOWER)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      const solar = await sim.position(SOLAR_DOOR);
      expect(solar && (await walkFighting(sim, solar, 120, 80))).toBe(true);
      expect(sim.activate(SOLAR_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(SOLAR);
      const listen = await sim.position(STAGE_180);
      expect(listen && (await sim.walkPath(listen, 20, 30))).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ201, 180), 5)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(OFFICE_SCENE)).toBe(true);
      for (let second = 0; second < 300 && !sim.stageDone(MQ201, 185); second++) {
        await sim.step(1);
        await fendOff(sim);
      }
      expect(sim.stageDone(MQ201, 185)).toBe(true);
      const chest = quest.aliases.get(OFFICE_CHEST) ?? 0;
      const at = await sim.position(chest);
      expect(at && (await walkFighting(sim, at, 60, 90))).toBe(true);
      expect(sim.activate(chest)).toBe(true);
      await sim.step(0.5);
      await takeAll(sim, chest);
      const note = quest.aliases.get(OFFICE_NOTE) ?? 0;
      expect(await sim.read((await sim.runtime.baseOf(note)) ?? 0, note)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ201, 190), 5)).toBe(true);
      const key = await sim.formId('KEYM', 'MQ201InterrogationChamberKey');
      expect(await sim.runtime.itemCount(PLAYER_REF, key)).toBe(1);
      afterSolar = await sim.save('MQ201 190');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Down to the dungeon by the locked door behind the solar (its key from Elenwen's chest):
  // MQ201Stage200a (200: MQ201TortureChamberScene, Rulindil questioning Etienne while the guard
  // strikes him). Those who see the player fight. Etienne, asked ("I'm not here to torture
  // you."), is freed (205) and tells of Esbern in Riften (210, which sets 220); the chest of the
  // interrogation room holds the Esbern dossier. Found 2026-11-03: the guard's
  // MQ201GuardHitPrisoner (UseWeapon) strikes while he is within its Trigger Radius of its
  // Trigger Ref, a package data condition naming the Prisoner alias, which was read as no
  // reference: he never struck and the scene waited in its second phase for good.
  it('has the player free Etienne Rarnis and read the dossier in the interrogation room (200-210)', async () => {
    if (!afterSolar) return;
    const sim = await loadSim(afterSolar);
    try {
      const quest = sim.runtime.state.quest(MQ201);
      const door = await sim.position(DUNGEON_DOOR);
      expect(door && (await walkFighting(sim, door, 60, 90))).toBe(true);
      expect(sim.activate(DUNGEON_DOOR)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(DUNGEON);
      expect(await sim.until(() => sim.stageDone(MQ201, 200), 5)).toBe(true);
      expect(sim.runtime.scenes.isPlaying(TORTURE_SCENE)).toBe(true);
      // The interrogation plays out to its end (the guard's last line, MQ201GuardExitCell).
      sim.world.player.sneaking = true;
      for (let second = 0; second < 300 && sim.runtime.scenes.isPlaying(TORTURE_SCENE); second++) {
        await sim.step(1);
        await fendOff(sim);
      }
      expect(sim.runtime.scenes.isPlaying(TORTURE_SCENE)).toBe(false);
      const etienne = quest.aliases.get(PRISONER) ?? 0;
      const at = await sim.position(etienne);
      expect(at && (await walkFighting(sim, at, 60, 150))).toBe(true);
      await fendOff(sim);
      await sim.converse(etienne, [
        /I need to talk/,
        /not here to torture/,
        /Free him/,
        /something important/,
      ]);
      expect(sim.stageDone(MQ201, 205)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ201, 220), 10)).toBe(true);
      const chest = quest.aliases.get(TORTURE_CHEST) ?? 0;
      const box = await sim.position(chest);
      expect(box && (await walkFighting(sim, box, 60, 90))).toBe(true);
      expect(sim.activate(chest)).toBe(true);
      await sim.step(0.5);
      await takeAll(sim, chest);
      const dossier = quest.aliases.get(DOSSIER) ?? 0;
      expect(await sim.read((await sim.runtime.baseOf(dossier)) ?? 0, dossier)).toBe(true);
      afterDossier = await sim.save('MQ201 220');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // 220: Malborn caught, brought down by two guards (MQ201EscapeScene); their lines said, they
  // turn on the player (222; the scene's end: 223, Malborn's MQ201MalbornEscape). Each carries
  // a key to the trapdoor (MQ201InterrogationExitKey: 225 as one is the player's); the locked
  // trapdoor (its key alone opens it: 227) is a load door down into Reeking Cave, whose
  // creatures meet the player on the way out (fought as above). Out of the cave, the player is
  // out of the Embassy's location (230). Found 2026-11-03: the guards are created references
  // (the quest's Create Reference at Elenwen's office marker), which the schedule of actors
  // away left out: they never set out for the dungeon and the scene waited for them for good.
  it('has the guards bring Malborn down and the player escape through the trapdoor to Reeking Cave (220-230)', async () => {
    if (!afterDossier) return;
    const sim = await loadSim(afterDossier);
    try {
      const quest = sim.runtime.state.quest(MQ201);
      const guards = [
        quest.aliases.get(ESCAPE_GUARD_1) ?? 0,
        quest.aliases.get(ESCAPE_GUARD_2) ?? 0,
      ];
      expect(await sim.until(() => sim.stageDone(MQ201, 222), 180)).toBe(true);
      // The player stands by Malborn: a guard fighting anyone falls to their blows.
      for (let second = 0; second < 120 && !sim.stageDone(MQ201, 223); second++) {
        await sim.step(1);
        await fendOff(sim);
        for (const guard of guards) {
          const staged = sim.actor(guard);
          if (staged && !staged.dead && sim.world.stage.combat.targetOf(guard) !== undefined) {
            await sim.kill(guard, PLAYER_REF);
          }
        }
      }
      expect(sim.stageDone(MQ201, 223)).toBe(true);
      for (let second = 0; second < 90 && !guards.some((g) => sim.actor(g)?.dead); second++) {
        await sim.step(1);
        await fendOff(sim);
      }
      const key = await sim.formId('KEYM', 'MQ201InterrogationExitKey');
      const carrier = guards.find((guard) => sim.actor(guard)?.dead) ?? 0;
      expect(await sim.runtime.itemCount(carrier, key)).toBe(1);
      const body = await sim.position(carrier);
      expect(body && (await walkFighting(sim, body, 60, 100))).toBe(true);
      await takeAll(sim, carrier);
      expect(await sim.until(() => sim.stageDone(MQ201, 225), 5)).toBe(true);
      const trapdoor = quest.aliases.get(TRAPDOOR) ?? 0;
      const at = await sim.position(trapdoor);
      expect(at && (await walkFighting(sim, at, 60, 100))).toBe(true);
      expect(sim.activate(trapdoor)).toBe(true);
      await sim.world.settle();
      await sim.step(1);
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(REEKING_CAVE);
      expect(sim.stageDone(MQ201, 227)).toBe(true);
      // Through the cave to its mouth (an automatic door) and out.
      const mouth = await sim.position(CAVE_MOUTH);
      let out = false;
      for (let leg = 0; leg < 40 && !out && mouth; leg++) {
        await walkFighting(sim, mouth, 5, 60);
        out = (await sim.runtime.placement(PLAYER_REF))?.world !== undefined;
      }
      expect(out).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ201, 230), 10)).toBe(true);
      afterEscape = await sim.save('MQ201 230');
    } finally {
      await sim.close();
    }
  }, 600_000);

  // Back to Delphine in the Sleeping Giant's secret room (100 sent her home), through the
  // cabinet in her room: "You made it out alive, at least." (say once, invisible continue),
  // "Did you learn anything useful?" The player tells her of Esbern (240), and where the
  // Thalmor think he hides; her last words end the quest (250: MQ202 10, "A Cornered Rat").
  // Found 2026-11-03: that first info is one of 920 older infos whose flags are in DATA (no
  // ENAM); read as none, the talk ended on its line.
  it('has the player tell Delphine of Esbern in Riverwood (240-250, MQ202 10)', async () => {
    if (!afterEscape) return;
    const sim = await loadSim(afterEscape);
    try {
      await sim.fastTravel(RIVERWOOD_MARKER, false);
      await sim.step(2);
      const door = await sim.position(INN_DOOR);
      expect(door && (await sim.walkPath(door, 60, 120))).toBe(true);
      expect(sim.activate(INN_DOOR)).toBe(true);
      await sim.world.settle();
      expect((await sim.runtime.placement(PLAYER_REF))?.cell).toBe(SLEEPING_GIANT);
      const delphine = sim.runtime.state.quest(MQ201).aliases.get(DELPHINE) ?? 0;
      await sim.step(2);
      expect(await sim.walkPath(SECRET_CABINET, 30, 60)).toBe(true);
      const at = await sim.position(delphine);
      expect(at && (await sim.walkPath(at, 60, 150))).toBe(true);
      await sim.converse(delphine, [
        /know nothing about the dragons/,
        /looking for someone named Esbern/,
        /want with Esbern/,
        /hiding out in Riften/,
      ]);
      expect(sim.stageDone(MQ201, 240)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ201, 250), 10)).toBe(true);
      expect(await sim.until(() => sim.stageDone(MQ202, 10), 10)).toBe(true);
    } finally {
      await sim.close();
    }
  }, 600_000);
});
