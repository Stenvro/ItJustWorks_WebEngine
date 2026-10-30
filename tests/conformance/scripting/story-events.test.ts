// Conformance: the story manager's events as the engine raises them (engine map: Scripting >
// Story manager), in the headless simulation, each by the engine path that raises it in the game:
// a script's Keyword.SendStoryEvent, skill books read (Increase Skill) and the level-up menu's
// choice (Increase Level), an item bought through the barter menu (Player Add Item) and dropped
// from the inventory menu (Player Remove Item), a gift through the gift menu (Relationship
// Change), a ward cast by the player's hand (Cast Magic), a voice power learned (New Voice
// Power), a disease cured by a potion (Player Cured), Hulda activated (Player Activate Actor),
// the inn's actors greeting each other and asking for scenes (Actor Hello, Actor Dialogue), a
// spell at Hulda (Assault Actor), a murder (Kill Actor, Crime Gold, Dead Body), the jail
// (Jail, Served Time, Escape Jail) and a fine paid (Pay Fine), as the guards' dialogue and the
// jail's bed call the natives. Each event's data is checked as its type's members (the
// Creation Kit's event pages), and every quest a node starts gets the event's OnStory event
// with those arguments (the game's Quest.pex). Bribe, Flatter, Intimidate and Player Gets
// Favor are never raised by the original: a bribe, an intimidation and a favor raise none.
// Skipped without game data.
//
// The data (Skyrim.esm; `node tools/story-manager.ts <type>` prints each tree):
// - SCPT: CRAela [0001CF17] is a Companions radiant keyword (CR01, CR02, CR12);
// - SKIL: WISkillIncrease02 [000F2593] starts on any skill increase (a node without conditions);
// - JAIL: JailQuest [0010D9F4]; ESJA: EscapeJailQuest [0010DCD8] and
//   EscapeJailAchievementQuest [0010FC2F] (nodes without conditions);
// - CURE, PFIN, STIJ, AFAV, ADCR have no quests in vanilla (CURE, PFIN, STIJ: a node without
//   quests or none; AFAV, ADCR: an empty event node);
// - books: the load order's skill books (BOOK, Teaches Skill), the first SkillBlock5 [0002F83C];
//   Hulda [0001A66E] sells SaltPile [00034CDF];
// - VoiceUnrelentingForce1 [00013E09] is a voice power; DiseaseAtaxia [000B877C] a disease,
//   CureDisease [000AE723] cures it; GemDiamond [00063B47] a gift; WardLesser [00013018];
//   Firebolt [00012FD0]; Brenuin [0002C90F]; CrimeFactionWhiterun [000267EA].

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STORY_EVENTS } from '../../../src/scripting/runtime/story-manager.ts';
import { ObjectHandle, type Value } from '../../../src/scripting/values.ts';
import { ActorValue, actorValueIndex } from '../../../src/world/actor-values.ts';
import { BookFlag, parseItem } from '../../../src/world/item-records.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const BANNERED_MARE = 0x1605e;
const CR_AELA = 0x1cf17;
/** Skill books read: enough of the load order's first for a level's experience. */
const BOOKS_READ = 16;
const WI_SKILL_INCREASE_02 = 0xf2593;
const HULDA = 0x1a66e;
const SALT = 0x34cdf;
const VOICE_POWER = 0x13e09;
const ATAXIA = 0xb877c;
const CURE_DISEASE = 0xae723;
const DIAMOND = 0x63b47;
const WARD = 0x13018;
const FIREBOLT = 0x12fd0;
const BRENUIN = 0x2c90f;
const CRIME_WHITERUN = 0x267ea;
const JAIL_QUEST = 0x10d9f4;
const ESCAPE_JAIL_QUEST = 0x10dcd8;

describe.skipIf(!hasGamedata())('the story manager’s events (headless simulation)', () => {
  let sim: Sim;
  let intimidated = false;
  const at = {
    script: 0,
    books: 0,
    level: 0,
    buy: 0,
    drop: 0,
    gift: 0,
    cast: 0,
    voice: 0,
    cure: 0,
    activate: 0,
    persuade: 0,
    assault: 0,
    kill: 0,
    jail: 0,
    serve: 0,
    escape: 0,
    fine: 0,
    end: 0,
  };

  beforeAll(async () => {
    // The evening: the inn's patrons are in (they greet each other and ask for scenes).
    sim = await openSim({ interior: BANNERED_MARE, hour: 20 });
    await sim.step(10);
    const { runtime } = sim;
    const handle = (value: Value): ObjectHandle => {
      if (!(value instanceof ObjectHandle)) throw new Error('no object');
      return value;
    };
    const player = handle(runtime.actorHandle(PLAYER_REF));
    const hulda = handle(runtime.actorHandle(HULDA));
    const whiterun = handle(runtime.formHandle(CRIME_WHITERUN));

    // A script sends a story event (Keyword.SendStoryEvent: no location, the player).
    at.script = sim.time;
    await sim.native(handle(runtime.formHandle(CR_AELA)), 'Keyword', 'SendStoryEvent', [
      null,
      player,
      null,
      0,
      0,
    ]);
    await sim.step(2);

    // Skill books read from the inventory, the level-up menu's choice (health).
    const books: number[] = [];
    for (const book of sim.db.formIdsOfType('BOOK')) {
      const record = await sim.db.get(book);
      const item = record && parseItem(record);
      if (item?.book && (item.book.flags & BookFlag.teachesSkill) !== 0) books.push(book);
      if (books.length === BOOKS_READ) break;
    }
    at.books = sim.time;
    for (const book of books) await sim.read(book);
    await sim.step(1);
    at.level = sim.time;
    await runtime.progression.levelUp(ActorValue.health);
    await sim.step(1);

    // Salt bought from Hulda (the barter menu), dropped (the inventory menu).
    await runtime.addItem(PLAYER_REF, runtime.formHandle(0xf), 500, true);
    at.buy = sim.time;
    await sim.buy(HULDA, SALT);
    await sim.step(1);
    at.drop = sim.time;
    await sim.drop(SALT);
    await sim.step(1);

    // A diamond given to Hulda (the gift menu, favor points).
    await runtime.addItem(PLAYER_REF, runtime.formHandle(DIAMOND), 1, true);
    at.gift = sim.time;
    await sim.gift(HULDA, DIAMOND);
    await sim.step(1);

    // A ward cast by the player's hand.
    await runtime.equipment.equipSpell(PLAYER_REF, WARD, 1);
    await sim.step(1);
    at.cast = sim.time;
    await sim.attack(2);
    await sim.step(1);

    // A voice power learned (Actor.AddSpell); a disease caught and cured by a potion.
    at.voice = sim.time;
    await sim.native(player, 'Actor', 'AddSpell', [runtime.formHandle(VOICE_POWER), false]);
    await sim.step(1);
    at.cure = sim.time;
    await sim.native(player, 'Actor', 'AddSpell', [runtime.formHandle(ATAXIA), false]);
    await sim.step(1);
    await runtime.addItem(PLAYER_REF, runtime.formHandle(CURE_DISEASE), 1, true);
    await runtime.magic.useItem(PLAYER_REF, CURE_DISEASE);
    await sim.step(1);

    // Hulda activated (talked to); she is bribed, intimidated, and does a favor.
    at.activate = sim.time;
    sim.activate(HULDA);
    await sim.step(3);
    sim.goodbye();
    at.persuade = sim.time;
    await sim.native(hulda, 'Actor', 'SetBribed', [true]);
    await sim.native(hulda, 'Actor', 'SetIntimidated', [true]);
    await sim.native(hulda, 'Actor', 'SetDoingFavor', [true]);
    intimidated = sim.runtime.crime.persuaded(HULDA, 'intimidated');
    await sim.step(1);

    // A firebolt at Hulda; Brenuin killed by the player.
    at.assault = sim.time;
    await sim.cast(FIREBOLT, HULDA);
    await sim.step(2);
    at.kill = sim.time;
    await sim.kill(BRENUIN, PLAYER_REF);
    await sim.step(3);

    // To jail (the guards' dialogue: Faction.SendPlayerToJail), the time served (the jail's
    // bed: Game.ServeTime); to jail again for a new bounty, out of its cell (escaped); a bounty
    // paid (Faction.PlayerPayCrimeGold).
    at.jail = sim.time;
    await sim.native(whiterun, 'Faction', 'SendPlayerToJail', [false, true]);
    await sim.step(3);
    at.serve = sim.time;
    await sim.native(player, 'Game', 'ServeTime', []);
    await sim.step(3);
    await sim.native(whiterun, 'Faction', 'ModCrimeGold', [500, false]);
    await sim.native(whiterun, 'Faction', 'SendPlayerToJail', [false, true]);
    await sim.step(3);
    at.escape = sim.time;
    await sim.openInterior(BANNERED_MARE);
    await sim.step(3);
    at.fine = sim.time;
    await sim.native(whiterun, 'Faction', 'ModCrimeGold', [100, false]);
    await sim.native(whiterun, 'Faction', 'PlayerPayCrimeGold', [false, false]);
    await sim.step(2);
    at.end = sim.time;
  }, 900_000);
  afterAll(async () => {
    await sim.close();
  });

  /** The story events of a type raised in a window. */
  const raised = (type: string, since: number, until: number) =>
    sim.storyEvents(type).filter((event) => event.at >= since && event.at < until);

  /** Every quest the events started got the type's OnStory event (on its own scripts). */
  const startedTold = (events: ReturnType<typeof raised>, type: string): void => {
    const name = STORY_EVENTS[type] ?? '';
    for (const event of events) {
      for (const quest of event.started) {
        const told = sim
          .scriptEvents({ event: name, target: quest, since: event.at })
          .filter((record) => record.alias === undefined);
        expect(told.length, `${name} to ${quest.toString(16)}`).toBeGreaterThan(0);
      }
    }
  };

  it('raises Script (SCPT) as Keyword.SendStoryEvent; its quests get OnStoryScript', () => {
    const events = raised('SCPT', at.script, at.books);
    expect(events.map((event) => [event.forms.K1, event.forms.R1])).toEqual([
      [CR_AELA, PLAYER_REF],
    ]);
    expect(events.flatMap((event) => event.started).length).toBeGreaterThan(0);
    startedTold(events, 'SCPT');
  });

  it('raises Increase Skill (SKIL: V1 the skill) as a skill book teaches; WISkillIncrease02 gets OnStoryIncreaseSkill', () => {
    const events = raised('SKIL', at.books, at.level);
    expect(events.length).toBeGreaterThanOrEqual(BOOKS_READ);
    expect(events[0]?.values.V1).toBe(actorValueIndex('Block'));
    expect(events.flatMap((event) => event.started)).toContain(WI_SKILL_INCREASE_02);
    startedTold(events, 'SKIL');
    expect(
      sim.scriptEvents({ event: 'OnStoryIncreaseSkill', target: WI_SKILL_INCREASE_02 })[0]?.args,
    ).toEqual(['Block']);
  });

  it('raises Increase Level (LEVL: V1 the new level) at the level-up menu’s choice; OnStoryIncreaseLevel to its quests', () => {
    const events = raised('LEVL', at.level, at.buy);
    expect(events.map((event) => event.values.V1)).toEqual([2]);
    startedTold(events, 'LEVL');
  });

  it('raises Player Add Item (AIPL: V1 2, bought) as the player buys; OnStoryAddToPlayer to its quests', () => {
    const events = raised('AIPL', at.buy, at.drop);
    expect(events.map((event) => [event.forms.F1 ?? event.forms.R1, event.values.V1])).toEqual([
      [SALT, 2],
    ]);
    startedTold(events, 'AIPL');
  });

  it('raises Player Remove Item (REMP: V1 4, dropped) as the player drops; OnStoryRemoveFromPlayer to its quests', () => {
    const events = raised('REMP', at.drop, at.gift);
    expect(events.map((event) => event.values.V1)).toEqual([4]);
    startedTold(events, 'REMP');
  });

  it('raises Relationship Change (CHRR: Hulda, the player, old and new rank) as a gift wins her favor; OnStoryRelationshipChange to its quests', () => {
    const events = raised('CHRR', at.gift, at.cast);
    expect(events.map((event) => [event.forms.R1, event.forms.R2])).toEqual([[HULDA, PLAYER_REF]]);
    expect(events[0]?.values.V2 ?? 0).toBeGreaterThan(events[0]?.values.V1 ?? 0);
    expect(events.flatMap((event) => event.started).length).toBeGreaterThan(0);
    startedTold(events, 'CHRR');
  });

  it('raises Cast Magic (CAST: the player, the ward) as their hand casts it; OnStoryCastMagic to its quests', () => {
    const events = raised('CAST', at.cast, at.voice);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]?.forms.R1).toBe(PLAYER_REF);
    startedTold(events, 'CAST');
  });

  it('raises New Voice Power (NVPE: the player, the power) as it is learned; OnStoryNewVoicePower to its quests', () => {
    const events = raised('NVPE', at.voice, at.cure);
    expect(events).toHaveLength(1);
    expect(events[0]?.forms.R1).toBe(PLAYER_REF);
    expect(events.flatMap((event) => event.started).length).toBeGreaterThan(0);
    startedTold(events, 'NVPE');
  });

  it('raises Player Cured (CURE: the disease) as a potion cures it; OnStoryCure has no vanilla quest', () => {
    const events = raised('CURE', at.cure, at.activate);
    expect(events.map((event) => [event.forms.F1, event.started])).toEqual([[ATAXIA, []]]);
  });

  it('raises Player Activate Actor (AFAV: Hulda) as the player activates her; OnStoryActivateActor has no vanilla quest', () => {
    const events = raised('AFAV', at.activate, at.persuade);
    expect(events.map((event) => [event.forms.R1, event.started])).toContainEqual([HULDA, []]);
  });

  it('raises Actor Hello and Actor Dialogue among the inn’s actors; OnStoryHello and OnStoryDialogue to their quests', () => {
    const hellos = raised('AHEL', 0, at.end);
    const dialogues = raised('ADIA', 0, at.end);
    expect(hellos.length).toBeGreaterThan(0);
    expect(dialogues.length).toBeGreaterThan(0);
    for (const event of [...hellos, ...dialogues]) {
      expect(event.forms.R1).toBeDefined();
      expect(event.forms.R2).toBeDefined();
    }
    startedTold(hellos, 'AHEL');
    startedTold(dialogues, 'ADIA');
  });

  it('never raises Bribe, Intimidate, Flatter or Player Gets Favor (OnStoryBribeNPC, OnStoryIntimidateNPC, OnStoryFlatterNPC, OnStoryPlayerGetsFavor): the original raises none', () => {
    for (const type of ['BRIB', 'INTM', 'FLAT', 'PRFV']) expect(sim.storyEvents(type)).toEqual([]);
    // The last of them took: she was intimidated.
    expect(intimidated).toBe(true);
  });

  it('raises Assault Actor (ASSU: Hulda, the player) as the firebolt hits her; OnStoryAssaultActor to its quests', () => {
    const events = raised('ASSU', at.assault, at.kill);
    expect(events.map((event) => [event.forms.R1, event.forms.R2])).toContainEqual([
      HULDA,
      PLAYER_REF,
    ]);
    expect(events.flatMap((event) => event.started).length).toBeGreaterThan(0);
    startedTold(events, 'ASSU');
  });

  it('raises Kill Actor (KILL: Brenuin, the player) and Crime Gold (ADCR) as the player murders him; OnStoryKillActor to its quests, OnStoryCrimeGold has none', () => {
    const kills = raised('KILL', at.kill, at.jail);
    expect(kills.map((event) => [event.forms.R1, event.forms.R2])).toEqual([[BRENUIN, PLAYER_REF]]);
    startedTold(kills, 'KILL');
    const gold = raised('ADCR', at.kill, at.jail);
    expect(gold.length).toBeGreaterThan(0);
    expect(gold[0]?.forms.R2).toBe(PLAYER_REF);
    expect(gold[0]?.started).toEqual([]);
  });

  it('raises Dead Body (DEAD: who found it, Brenuin) as the inn’s actors see him; OnStoryDiscoverDeadBody to its quests', () => {
    const events = raised('DEAD', at.kill, at.jail);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) expect(event.forms.R2).toBe(BRENUIN);
    startedTold(events, 'DEAD');
  });

  it('raises Jail (JAIL) as the player is sent to jail; JailQuest gets OnStoryJail', () => {
    const events = raised('JAIL', at.jail, at.serve);
    expect(events).toHaveLength(1);
    expect(events[0]?.started).toContain(JAIL_QUEST);
    startedTold(events, 'JAIL');
  });

  it('raises Served Time (STIJ) as the player serves it; OnStoryServedTime has no vanilla quest', () => {
    expect(raised('STIJ', at.serve, at.escape).map((event) => event.started)).toEqual([[]]);
  });

  it('raises Escape Jail (ESJA) as the player leaves the cell; EscapeJailQuest gets OnStoryEscapeJail', () => {
    const events = raised('ESJA', at.escape, at.fine);
    expect(events).toHaveLength(1);
    expect(events[0]?.started).toContain(ESCAPE_JAIL_QUEST);
    startedTold(events, 'ESJA');
  });

  it('raises Pay Fine (PFIN) as the player pays their bounty; OnStoryPayFine has no vanilla quest', () => {
    expect(raised('PFIN', at.fine, Infinity).map((event) => event.started)).toEqual([[]]);
  });
});
