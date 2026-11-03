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

/** The topic an actor's ForceGreet opened the dialogue menu with (undefined: none yet). */
function greeting(sim: Sim, actor: number): number | undefined {
  return sim.menus().find((menu) => menu.menu === 'Dialogue Menu' && menu.reference === actor)
    ?.opening;
}

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
    } finally {
      await sim.close();
    }
  }, 600_000);

  // TODO(M13): the rest of MQ201, from afterParty on, is not played in the sim yet: written down
  // from the quest's record, scripts and scenes.
  it.todo(
    'has Malborn lead the player through the kitchen past Tsavani to the gear chest (KitchenScene: 150-170)',
  );
  it.todo(
    "has the player sneak to Elenwen's solar and overhear Rulindil and Gissur (ElenwenOfficeScene: 180-190)",
  );
  it.todo(
    "has the player read Elenwen's dossier and free Etienne Rarnis in the interrogation room (200-210)",
  );
  it.todo(
    'has the guards bring Malborn down and the player escape through the trapdoor to Reeking Cave (220-230)',
  );
  it.todo('has the player tell Delphine of Esbern in Riverwood (240-250, MQ202 10)');
});
