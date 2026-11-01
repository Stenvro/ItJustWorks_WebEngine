// Conformance: the story manager's last five events as the engine raises them (engine map:
// Scripting > Story manager), in the headless simulation, each by the engine path that raises it
// in the game: an item made at a forge and one improved at an armor workbench through the
// crafting menu's model (Craft Item), a wanted player arrested by a Whiterun guard who comes up
// and opens the arrest's conversation (Arrest), a strongbox picked through the lockpicking
// menu's engine side (Pick Lock), the player staying in a shop its owner locked past the
// warnings of the one who sees them (Trespass), and a skeever's bite passing its disease on
// (Player Infected). Each event's data is checked as its type's members (the Creation Kit's
// event pages, the base scripts' OnStory declarations). Skipped without game data.
//
// The data (Skyrim.esm; `node tools/story-manager.ts <type>` prints each tree):
// - CRFT: the forge CraftingBlackSmithForgeWR [000C430A] and the armor workbench
//   CraftingBlacksmithArmorWorkbench [0002056C] by Warmaiden's (WhiterunWorld 4,-3 and 5,-2),
//   in WhiterunLocation; its nodes need WIEventsEnabled or a running tutorial, so no quest
//   starts here. The tutorials' TutorialBlacksmithingDaggerSharpen and ArmorTemper start on
//   Craft Item at the improving benches (GetEventData O1): an improvement is a craft.
// - ARRT: GuardWhiterun [0003706A] stands by Warmaiden's at 10:00. GenericArrestNode starts
//   DGArrestQuest [0006B94B] only for a criminal that is not the player (its event condition
//   GetIsID(Player) == 0 on R2); TG00ArrestMonitor only while TG00 runs: none for the player.
// - LOCK, TRES, INFC: event nodes without quests (LOCK), or none at all (TRES, INFC).
// - Belethor's General Goods [000165B3]: owned by Belethor's faction, not public; its door
//   [00016607] locks (level 50), its strongbox TGRStrongbox [000EA738] (level 25) upstairs;
//   Belethor [0001A672] keeps an eye on the shop.
// - Breezehome [000165A8] is empty at the start; EncSkeever [00023AB7]: SkeeverRace's bite
//   carries DiseaseAtaxia [000B877C].

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CrimeType } from '../../../src/gameplay/crime.ts';
import { ObjectHandle, type Value } from '../../../src/scripting/values.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const WHITERUN_WORLD = 0x1a26f;
const FORGE = 0xc430a;
const ARMOR_WORKBENCH = 0x2056c;
const WARMAIDENS_GUARD = 0x3706a;
const DG_ARREST_QUEST = 0x6b94b;
const BELETHORS = 0x165b3;
const BELETHORS_DOOR = 0x16607;
const STRONGBOX = 0xea738;
const ATAXIA = 0xb877c;
const BELETHOR = 0x1a672;
const BREEZEHOME = 0x165a8;

const handle = (value: Value): ObjectHandle => {
  if (!(value instanceof ObjectHandle)) throw new Error('no object');
  return value;
};

/** The story events of a type raised in a window of a simulation. */
const raised = (sim: Sim, type: string, since: number, until = Infinity) =>
  sim.storyEvents(type).filter((event) => event.at >= since && event.at < until);

describe.skipIf(!hasGamedata())(
  'Craft Item and Arrest by Warmaiden’s (headless simulation)',
  () => {
    let sim: Sim;
    let dagger = 0;
    let helmet = 0;
    let location: number | undefined;
    const at = { craft: 0, temper: 0, arrest: 0, end: 0 };
    let crafted = false;
    let tempered = false;
    let topics: string[] | undefined;
    let droppedHealth: Value = null;
    let takenHealth: number[] = [];

    beforeAll(async () => {
      sim = await openSim({
        exterior: { world: WHITERUN_WORLD, cell: [4, -3] },
        arrival: { position: [20450, -8150, -3600], heading: 0 },
        hour: 10,
      });
      await sim.step(5);
      const { runtime } = sim;
      location = await runtime.locationOf(FORGE);
      const give = async (type: string, editorId: string, count: number): Promise<number> => {
        const item = await sim.formId(type, editorId);
        await runtime.addItem(PLAYER_REF, runtime.formHandle(item), count, true);
        return item;
      };

      // An iron dagger made at the forge (an ingot and a leather strip).
      await give('MISC', 'IngotIron', 5);
      await give('MISC', 'LeatherStrips', 5);
      dagger = await sim.formId('WEAP', 'IronDagger');
      at.craft = sim.time;
      crafted = await sim.craft(FORGE, dagger);
      await sim.step(1);

      // An iron helmet improved at the armor workbench.
      helmet = await give('ARMO', 'ArmorIronHelmet', 1);
      at.temper = sim.time;
      tempered = await sim.craft(ARMOR_WORKBENCH, helmet);
      await sim.step(1);
      // Dropped from the inventory menu (its improved row) and taken again: the improvement stays
      // with it.
      const improved = runtime.crafting
        .instances(PLAYER_REF, helmet)
        .find((each) => each.stack !== undefined)?.stack;
      await sim.drop(helmet, 1, improved);
      const dropped = sim.storyEvents('REMP').at(-1)?.forms.R2;
      if (dropped !== undefined) {
        droppedHealth = await sim.native(
          handle(runtime.referenceHandle(dropped)),
          'ObjectReference',
          'GetItemHealthPercent',
          [],
        );
        await runtime.pickUp(dropped, PLAYER_REF);
        takenHealth = runtime.crafting.instances(PLAYER_REF, helmet).map((each) => each.health);
      }

      // Wanted in Whiterun (its arrest-on-sight bounty), beside a guard: it comes up, says its
      // force greet and the player gives themselves up.
      at.arrest = sim.time;
      const bounty = (await runtime.globalNamed('CrimeArrestOnSightNonViolentThreshold')) ?? 1000;
      await sim.native(handle(runtime.formHandle(0x267ea)), 'Faction', 'ModCrimeGold', [
        bounty,
        false,
      ]);
      const guard = await sim.position(WARMAIDENS_GUARD);
      if (guard) await sim.moveTo([guard[0] + 150, guard[1], guard[2] + 10]);
      topics = await sim.listen(WARMAIDENS_GUARD, 60);
      if (topics?.some((topic) => /submit/i.test(topic))) await sim.choose(/submit/i);
      await sim.step(3);
      at.end = sim.time;
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    it('raises Craft Item (CRFT: the forge, its location, the dagger) as the forge makes it; OnStoryCraftItem has no quest here', () => {
      expect(crafted).toBe(true);
      const events = raised(sim, 'CRFT', at.craft, at.temper);
      expect(events.map((event) => [event.forms.R1, event.forms.L1, event.forms.O1])).toEqual([
        [FORGE, location, dagger],
      ]);
      expect(location).toBeDefined();
      expect(events[0]?.started).toEqual([]);
    });

    it('raises Craft Item (OnStoryCraftItem: the workbench, the helmet) as the armor workbench improves it', () => {
      expect(tempered).toBe(true);
      const events = raised(sim, 'CRFT', at.temper, at.arrest);
      expect(events.map((event) => [event.forms.R1, event.forms.O1])).toEqual([
        [ARMOR_WORKBENCH, helmet],
      ]);
    });

    it('keeps the improved helmet’s health on the reference it is dropped as (GetItemHealthPercent), and on its stack once taken again', () => {
      expect(typeof droppedHealth).toBe('number');
      expect(droppedHealth as number).toBeGreaterThan(1);
      expect(takenHealth).toContain(droppedHealth);
    });

    it('raises Arrest (ARRT: the guard, the player, the location, no crime) as the guard reaches the wanted player; OnStoryArrest starts no quest for the player', () => {
      const events = raised(sim, 'ARRT', at.arrest, at.end);
      expect(events).toHaveLength(1);
      const [event] = events;
      expect([event?.forms.R1, event?.forms.R2, event?.values.V1]).toEqual([
        WARMAIDENS_GUARD,
        PLAYER_REF,
        0,
      ]);
      expect(event?.forms.L1).toBeDefined();
      expect(event?.started).not.toContain(DG_ARREST_QUEST);
      expect(event?.started).toEqual([]);
    });

    it('then opens the arrest’s conversation with its force greet; submitting sends the player to jail', () => {
      const arrest = raised(sim, 'ARRT', at.arrest, at.end)[0];
      const opened = sim
        .menus()
        .filter((menu) => menu.menu === 'Dialogue Menu' && menu.at >= (arrest?.at ?? Infinity));
      expect(opened[0]).toMatchObject({ reference: WARMAIDENS_GUARD });
      expect(opened[0]?.opening).toBeDefined();
      expect(topics).toContain('I submit. Take me to jail.');
      expect(raised(sim, 'JAIL', at.arrest, at.end)).toHaveLength(1);
    });
  },
);

describe.skipIf(!hasGamedata())(
  'Pick Lock and Trespass in Belethor’s General Goods (headless simulation)',
  () => {
    let sim: Sim;
    let picked = '';
    const at = { pick: 0, trespass: 0 };
    let warned = 0;

    beforeAll(async () => {
      sim = await openSim({ interior: BELETHORS, hour: 10 });
      await sim.step(5);
      const { runtime } = sim;
      const lockpick = await sim.formId('MISC', 'Lockpick');
      await runtime.addItem(PLAYER_REF, runtime.formHandle(lockpick), 10, true);

      // The strongbox upstairs picked.
      const box = await sim.position(STRONGBOX);
      if (box) await sim.moveTo([box[0] + 60, box[1], box[2]]);
      at.pick = sim.time;
      picked = await sim.pickLock(STRONGBOX);
      await sim.step(2);

      // The shop's door locked by its owner with the player inside (ObjectReference.Lock as
      // owner); the player stays where Belethor sees them.
      at.trespass = sim.time;
      await sim.native(handle(runtime.referenceHandle(BELETHORS_DOOR)), 'ObjectReference', 'Lock', [
        true,
        true,
      ]);
      const there = await sim.position(BELETHOR);
      if (there) await sim.moveTo([there[0] + 100, there[1], there[2]]);
      await sim.until(() => {
        warned = Math.max(warned, runtime.state.crime.trespassWarnings);
        return sim.storyEvents('TRES').length > 0;
      }, 60);
      await sim.step(1);
    }, 600_000);
    afterAll(async () => {
      await sim.close();
    });

    it('raises Pick Lock (LOCK: the player, the strongbox, whether a crime) as the lock opens; OnStoryPickLock has no quest', () => {
      expect(picked).toBe('opened');
      expect(sim.runtime.state.references.get(STRONGBOX)?.locked).toBe(false);
      const events = raised(sim, 'LOCK', at.pick, at.trespass);
      expect(events.map((event) => [event.forms.R1, event.forms.R2, event.started])).toEqual([
        [PLAYER_REF, STRONGBOX, []],
      ]);
      // Unseen up there: no crime (abCrime false), no bounty.
      expect(events[0]?.values.V1).toBe(0);
    });

    it('raises Trespass (TRES: the player, the shop’s location, the trespass crime) once Belethor’s warnings are used up; OnStoryTrespass has no quest', () => {
      const events = raised(sim, 'TRES', at.trespass);
      expect(warned).toBeGreaterThan(0);
      expect(events).toHaveLength(1);
      const [event] = events;
      expect([event?.forms.R2, event?.values.V1, event?.started]).toEqual([
        PLAYER_REF,
        CrimeType.trespass,
        [],
      ]);
      expect(event?.forms.L1).toBeDefined();
    });
  },
);

describe.skipIf(!hasGamedata())('Player Infected in Breezehome (headless simulation)', () => {
  let sim: Sim;
  let skeever = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: BREEZEHOME, hour: 10 });
    await sim.step(3);
    // A skeever beside the player: it bites until its disease takes. Each bite passes it on at
    // 3 in 100 (DiseaseAtaxia's effect: GetRandomPercent <= 2), about a bite every 2 s. The
    // player, unarmed, died after some 19 bites, so the disease took in fewer than half the
    // runs: in god mode (Debug.SetGodMode: no damage) the bites go on, up to 600 s.
    sim.runtime.godMode = true;
    skeever = await sim.place(await sim.formId('NPC_', 'EncSkeever'), PLAYER_REF);
    await sim.until(() => sim.storyEvents('INFC').length > 0, 600);
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('raises Player Infected (INFC: the skeever, Ataxia) as its bite passes the disease on; OnStoryInfection has no quest', async () => {
    expect(sim.storyEvents('INFC').map((event) => [event.forms.R1, event.forms.F1])).toEqual([
      [skeever, ATAXIA],
    ]);
    expect(sim.storyEvents('INFC')[0]?.started).toEqual([]);
    expect(await sim.runtime.actors.hasSpell(PLAYER_REF, ATAXIA)).toBe(true);
  });
});
