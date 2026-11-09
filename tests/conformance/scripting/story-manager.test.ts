// Conformance: the story manager answers the engine's Change Location event (engine map:
// Scripting > Story manager; cross-cutting finding 1, "Events nobody sends"). The player walks
// into inns in the headless simulation: the actor location change goes out, the story manager
// gets its Change Location event (SMEN CLOC) and starts the quests whose nodes and aliases its
// data lets through. Skipped without game data.
//
// Expected output, from the data (Skyrim.esm; `node tools/story-manager.ts CLOC` prints the tree,
// `node tools/quest-info.ts WITavern` the quest):
// - CLOC's event data: R1 the actor, L1 the old location, L2 the new one (the Creation Kit's
//   Change Location event; the nodes below read L2).
// - WIGreetingNodeSHARES [000C791B] (stacked, shares event): IsTrespassing == 0 on the player,
//   quest WIGreeting [000C7919].
// - WITavernQuestNodeSHARES [000DEE94] (stacked, shares event): GetEventData HasKeyword L2
//   LocTypeInn [0001CB87] == 1, quest WITavern [000DEE92]. Its aliases Innkeeper, Server1,
//   Server2 and Bard are not optional and match the location's actors by their conditions: the
//   Bannered Mare has its innkeeper (Hulda), servers and bard; the Sleeping Giant Inn has no
//   server, so WITavern cannot start there (a quest whose required alias finds nobody does not
//   start: Creation Kit, Quest Aliases Tab).
// - A quest a story manager node starts gets its script's OnStoryChangeLocation(akActor,
//   akOldLocation, akNewLocation) (the game's Quest.pex; STORY_EVENTS in story-manager.ts).

import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildStoryTrees,
  parseStoryNode,
  type StoryNode,
} from '../../../src/world/story-manager-records.ts';
import { parseInfo } from '../../../src/world/dialogue-records.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

/** The Bannered Mare (interior CELL) and its location (LCTN). */
const BANNERED_MARE = 0x1605e;
const BANNERED_MARE_LOCATION = 0x1f86d;
/** The Sleeping Giant Inn and its location. */
const SLEEPING_GIANT_INN = 0x133c6;
const SLEEPING_GIANT_INN_LOCATION = 0x1cb8c;
const WI_GREETING = 0xc7919;
const WI_TAVERN = 0xdee92;

describe.skipIf(!hasGamedata())('story manager: Change Location (headless simulation)', () => {
  let sim: Sim;
  /** When the player went into each inn (seconds on the simulation's clock). */
  let intoMare = 0;
  let intoGiant = 0;

  /** The Change Location events of the player from a time on. */
  const changes = (since: number, until = Infinity) =>
    sim
      .storyEvents('CLOC')
      .filter((event) => event.at >= since && event.at < until && event.forms.R1 === PLAYER_REF);

  beforeAll(async () => {
    sim = await openSim({ hour: 10 });
    intoMare = sim.time;
    await sim.openInterior(BANNERED_MARE);
    await sim.step(2);
    intoGiant = sim.time;
    await sim.openInterior(SLEEPING_GIANT_INN);
    await sim.step(2);
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  it('tells the player’s change of location (TESActorLocationChangeEvent)', () => {
    const moves = sim.events('actorLocationChange').filter((event) => event.actor === PLAYER_REF);
    expect(moves.map((event) => event.to)).toEqual([
      BANNERED_MARE_LOCATION,
      SLEEPING_GIANT_INN_LOCATION,
    ]);
  });

  it('raises Change Location once per location entered, with the actor and both locations', () => {
    const intoTheMare = changes(intoMare, intoGiant);
    expect(intoTheMare).toHaveLength(1);
    expect(intoTheMare[0]?.forms.L2).toBe(BANNERED_MARE_LOCATION);
    const intoTheGiant = changes(intoGiant);
    expect(intoTheGiant).toHaveLength(1);
    expect(intoTheGiant[0]?.forms.L1).toBe(BANNERED_MARE_LOCATION);
    expect(intoTheGiant[0]?.forms.L2).toBe(SLEEPING_GIANT_INN_LOCATION);
  });

  it('starts WIGreeting through WIGreetingNodeSHARES (the player is not trespassing)', () => {
    expect(changes(intoMare, intoGiant)[0]?.started).toContain(WI_GREETING);
  });

  it('starts WITavern through WITavernQuestNodeSHARES in an inn with its staff', () => {
    expect(changes(intoMare, intoGiant)[0]?.started).toContain(WI_TAVERN);
    expect(sim.questsStarted()).toContain(WI_TAVERN);
  });

  it('starts no WITavern in an inn without a server (alias Server1 is not optional)', () => {
    expect(changes(intoGiant)[0]?.started).not.toContain(WI_TAVERN);
  });

  it('sends a started quest OnStoryChangeLocation(akActor, akOldLocation, akNewLocation)', () => {
    const story = sim.scriptEvents({
      event: 'OnStoryChangeLocation',
      target: WI_GREETING,
      since: intoMare,
    });
    expect(story.length).toBeGreaterThan(0);
    const [actor, , to] = story[0]?.args ?? [];
    expect(actor).toEqual({ form: PLAYER_REF });
    expect(to).toEqual({ form: BANNERED_MARE_LOCATION });
  });
});

// Moves that raise no Change Location, from the data: Dragonsreach [000165A3] and its Jarl's
// Quarters [00080C6A] are two cells of WhiterunDragonsreachLocation [0001F871] (their XLCN); the
// player going from one to the other enters no other location. An NPC that a script moves to
// another location (ObjectReference.MoveTo to the Bannered Mare) changes location
// (TESActorLocationChangeEvent: its OnLocationChange), but the story manager's Change Location
// is the player's alone (the engine raises it as it puts the player in a cell of another
// location; observed in the original, docs/scripting.md "Story events").
const DRAGONSREACH = 0x165a3;
const JARLS_QUARTERS = 0x80c6a;
const DRAGONSREACH_LOCATION = 0x1f871;

describe.skipIf(!hasGamedata())('story manager: moves without Change Location (simulation)', () => {
  let sim: Sim;
  let upstairs = 0;
  let movedAt = 0;
  let mover = 0;
  let locationUpstairs: number | undefined;

  beforeAll(async () => {
    sim = await openSim({ interior: DRAGONSREACH, hour: 10 });
    await sim.step(2);
    // One of the hall's actors with scripts (or an alias) to hear its OnLocationChange.
    const heard = new Set(sim.scriptEvents().map((event) => event.target));
    const actors = sim.actors().map((staged) => staged.reference);
    mover = actors.find((actor) => actor !== PLAYER_REF && heard.has(actor)) ?? 0;
    upstairs = sim.time;
    await sim.openInterior(JARLS_QUARTERS);
    await sim.step(2);
    locationUpstairs = sim.runtime.state.playerLocation;
    // A script moves it to the Bannered Mare (both cells out of the loaded area now).
    const marker = sim.db.cellReferences(BANNERED_MARE)[0];
    if (mover !== 0 && marker !== undefined) {
      movedAt = sim.time;
      await sim.native(sim.runtime.referenceHandle(mover), 'ObjectReference', 'MoveTo', [
        sim.runtime.referenceHandle(marker),
        0,
        0,
        0,
        true,
      ]);
      await sim.step(2);
    }
  }, 300_000);
  afterAll(async () => {
    await sim.close();
  });

  it(
    'raises no Change Location for a move between cells of one location (the engine raises it ' +
      'only between locations: CK, Change Location event)',
    () => {
      expect(locationUpstairs).toBe(DRAGONSREACH_LOCATION);
      expect(
        sim.events('actorLocationChange').filter((event) => event.actor === PLAYER_REF),
      ).toEqual([{ actor: PLAYER_REF, from: undefined, to: DRAGONSREACH_LOCATION }]);
      expect(sim.storyEvents('CLOC').filter((event) => event.at >= upstairs)).toEqual([]);
      expect(
        sim.scriptEvents({ event: 'OnLocationChange', target: PLAYER_REF, since: upstairs }),
      ).toEqual([]);
    },
  );

  it(
    'raises Change Location for no actor but the player, while NPCs still get ' +
      'OnLocationChange (engine map: Script events, OnLocationChange for NPCs)',
    () => {
      expect(mover).not.toBe(0);
      const moves = sim
        .events('actorLocationChange')
        .filter((event) => event.actor === mover && event.to === BANNERED_MARE_LOCATION);
      expect(moves).toEqual([
        { actor: mover, from: DRAGONSREACH_LOCATION, to: BANNERED_MARE_LOCATION },
      ]);
      const told = sim.scriptEvents({ event: 'OnLocationChange', target: mover, since: movedAt });
      expect(told.length).toBeGreaterThan(0);
      for (const event of told) {
        expect(event.args).toEqual([
          { form: DRAGONSREACH_LOCATION },
          { form: BANNERED_MARE_LOCATION },
        ]);
      }
      expect(sim.storyEvents('CLOC').filter((event) => event.forms.R1 !== PLAYER_REF)).toEqual([]);
    },
  );
});

// Every story manager event type of the game (xEdit's TES5 quest event list, wbQuestEventEnum),
// with when the original raises it and its data, as the started quest's OnStory event takes it
// (Quest.pex: the OnStory* arguments; the members R references, L locations, F forms, V numbers:
// docs/scripting.md "Story events"). The data case counts each type's nodes and quests over the
// load order (`node tools/story-manager.ts`).

/** Each type: its OnStory event (Quest.pex) and when the engine raises it. */
const STORY_TYPES: Readonly<Record<string, { readonly event: string; readonly when: string }>> = {
  ADCR: {
    event: 'OnStoryCrimeGold',
    when: 'a crime adds a bounty (victim, criminal, faction, gold, crime)',
  },
  ADIA: {
    event: 'OnStoryDialogue',
    when: 'two actors ask for a scene with each other (location, actor, other)',
  },
  AFAV: { event: 'OnStoryActivateActor', when: 'the player activates an actor (location, actor)' },
  AHEL: {
    event: 'OnStoryHello',
    when: 'an NPC turns its head to another actor (location, actor, other)',
  },
  AIPL: {
    event: 'OnStoryAddToPlayer',
    when: 'the player takes or buys an item (owner, container, location, item, how)',
  },
  ARRT: {
    event: 'OnStoryArrest',
    when: 'a guard reaches the criminal it arrests (guard, criminal, location, crime)',
  },
  ASSU: {
    event: 'OnStoryAssaultActor',
    when: 'an actor is assaulted (victim, attacker, location, crime)',
  },
  BRIB: { event: 'OnStoryBribeNPC', when: 'the player bribes an actor in dialogue (actor)' },
  CAST: {
    event: 'OnStoryCastMagic',
    when: 'an actor not in combat begins a cast (caster, target, location, spell)',
  },
  CHRR: {
    event: 'OnStoryRelationshipChange',
    when: 'a relationship rank changes (actor, other, old, new)',
  },
  CLOC: {
    event: 'OnStoryChangeLocation',
    when: 'the player enters another location (actor, old, new)',
  },
  CRFT: {
    event: 'OnStoryCraftItem',
    when: 'the player crafts at a workbench (bench, location, item)',
  },
  CURE: { event: 'OnStoryCure', when: 'the player is cured of a disease (infection)' },
  DEAD: {
    event: 'OnStoryDiscoverDeadBody',
    when: 'an NPC finds a dead actor (actor, dead, location)',
  },
  ESJA: { event: 'OnStoryEscapeJail', when: 'the player escapes jail (location, crime faction)' },
  FLAT: { event: 'OnStoryFlatterNPC', when: 'the player persuades an actor in dialogue (actor)' },
  INFC: {
    event: 'OnStoryInfection',
    when: 'the player catches a disease (transmitting actor, infection)',
  },
  INTM: {
    event: 'OnStoryIntimidateNPC',
    when: 'the player intimidates an actor in dialogue (actor)',
  },
  JAIL: {
    event: 'OnStoryJail',
    when: 'the player goes to jail (guard, crime faction, location, gold)',
  },
  KILL: {
    event: 'OnStoryKillActor',
    when: 'an actor is killed (victim, killer, location, crime, rank)',
  },
  LEVL: { event: 'OnStoryIncreaseLevel', when: 'the player levels up (new level)' },
  LOCK: { event: 'OnStoryPickLock', when: 'a lock is picked (picker, lock)' },
  NVPE: { event: 'OnStoryNewVoicePower', when: 'an actor comes by a voice power (actor, power)' },
  PFIN: {
    event: 'OnStoryPayFine',
    when: 'the player pays a fine (criminal, guard, crime faction, gold)',
  },
  PRFV: { event: 'OnStoryPlayerGetsFavor', when: 'an actor does the player a favor (actor)' },
  QSTR: { event: '', when: 'a script starts a quest (queued; no node runs for it)' },
  REMP: {
    event: 'OnStoryRemoveFromPlayer',
    when: 'an item leaves the player (owner, item, location, base, how)',
  },
  SCPT: {
    event: 'OnStoryScript',
    when: 'Keyword.SendStoryEvent (keyword, location, two refs, two values)',
  },
  SKIL: { event: 'OnStoryIncreaseSkill', when: 'a skill of the player goes up (skill)' },
  STIJ: {
    event: 'OnStoryServedTime',
    when: 'the player serves their time (location, crime faction, gold, days)',
  },
  TRES: {
    event: 'OnStoryTrespass',
    when: 'an actor trespasses (victim, trespasser, location, crime)',
  },
};

/**
 * The types our engine raises, where, and the suite of tests/conformance/scripting that checks
 * each in the simulation (docs/scripting.md "Story events"); CHECKED: this suite.
 */
const RAISED: Readonly<Record<string, { readonly by: string; readonly checked?: string }>> = {
  ADCR: { by: 'crime-engine.ts', checked: 'story-events.test.ts' },
  ADIA: { by: 'actor-talk.ts', checked: 'story-events.test.ts' },
  AFAV: { by: 'story-events.ts (the activation)' },
  AHEL: { by: 'the actors’ looks', checked: 'story-events.test.ts' },
  AIPL: { by: 'the takes, the container and barter menus', checked: 'story-events.test.ts' },
  ARRT: { by: 'the guards’ arrest', checked: 'story-events-world.test.ts' },
  ASSU: { by: 'crime-engine.ts', checked: 'story-events.test.ts' },
  BRIB: { by: 'nothing: the original never raises it', checked: 'story-events.test.ts' },
  CAST: { by: 'casting-engine.ts', checked: 'story-events.test.ts' },
  CHRR: { by: 'crime-engine.ts', checked: 'story-events.test.ts' },
  CLOC: { by: 'story-events.ts (the player’s location change)' },
  CRFT: { by: 'crafting-menu.ts', checked: 'story-events-world.test.ts' },
  CURE: { by: 'magic-engine.ts (Cure Disease)', checked: 'story-events.test.ts' },
  DEAD: { by: 'the senses', checked: 'story-events.test.ts' },
  ESJA: { by: 'crime-engine.ts', checked: 'story-events.test.ts' },
  FLAT: { by: 'nothing: the original never raises it' },
  INFC: { by: 'magic-engine.ts (contractDisease)', checked: 'story-events-world.test.ts' },
  INTM: { by: 'nothing: the original never raises it', checked: 'story-events.test.ts' },
  JAIL: { by: 'crime-engine.ts', checked: 'story-events.test.ts' },
  KILL: { by: 'crime-engine.ts', checked: 'event-sources.test.ts' },
  LEVL: { by: 'progression-engine.ts', checked: 'story-events.test.ts' },
  LOCK: { by: 'crime-engine.ts', checked: 'story-events-world.test.ts' },
  NVPE: { by: 'casting-engine.ts, actor-engine.ts', checked: 'story-events.test.ts' },
  PFIN: { by: 'crime-engine.ts', checked: 'story-events.test.ts' },
  PRFV: { by: 'nothing: the original never raises it', checked: 'story-events.test.ts' },
  QSTR: { by: 'StoryManager.questStart (Quest.Start, SetStage queue it)' },
  REMP: { by: 'the inventory’s drop', checked: 'story-events.test.ts' },
  SCPT: { by: 'Keyword.SendStoryEvent', checked: 'story-events.test.ts' },
  SKIL: { by: 'progression-engine.ts', checked: 'story-events.test.ts' },
  STIJ: { by: 'crime-engine.ts', checked: 'story-events.test.ts' },
  TRES: { by: 'crime-engine.ts', checked: 'story-events-world.test.ts' },
};

/** The types the interaction cases of this suite check (CLOC above; AFAV, FLAT, QSTR below). */
const CHECKED = new Set(['CLOC', 'AFAV', 'FLAT', 'QSTR']);
/** The Whiterun gate guard's line as the player's persuasion succeeds (its fragment: Persuade). */
const GATE_PERSUADED_INFO = 0xd1981;
/** A Companions radiant keyword (CR01, CR02, CR12 start on its Script event). */
const CR_AELA = 0x1cf17;
/** A quest with no story event that does not run at a new game (Blind Cliff Cave's). */
const DUN_BLIND_CLIFF_QST = 0x39b3b;

describe('every story manager event type', () => {
  it('is raised by the engine (or by nothing, as in the original) and checked in a simulation case', () => {
    expect(Object.keys(RAISED).sort()).toEqual(Object.keys(STORY_TYPES).sort());
    for (const [type, { checked }] of Object.entries(RAISED)) {
      if (CHECKED.has(type)) continue;
      expect(checked, type).toBeDefined();
      // The suite named raises it: its type or its OnStory event is in a case of it.
      const text = fs.readFileSync(new URL(checked ?? '', import.meta.url), 'utf8');
      const event = STORY_TYPES[type]?.event ?? type;
      expect(text.includes(type) || text.includes(event), `${type} in ${checked ?? ''}`).toBe(true);
    }
  });
});

describe.skipIf(!hasGamedata())('the story manager’s events (data, headless simulation)', () => {
  let sim: Sim;
  let declared: string[] = [];
  let counts = new Map<string, { nodes: number; quests: number }>();
  let talkedTo = 0;
  let talkedAt = 0;
  let queuedAt = 0;
  let wasRunning = true;
  let started: unknown;

  beforeAll(async () => {
    sim = await openSim({ interior: BANNERED_MARE, hour: 10 });
    await sim.step(1);
    const nodes: StoryNode[] = [];
    for (const type of ['SMEN', 'SMBN', 'SMQN']) {
      for (const formId of sim.db.formIdsOfType(type)) {
        const record = await sim.db.get(formId);
        if (record && !record.deleted) nodes.push(parseStoryNode(record));
      }
    }
    const count = (node: StoryNode): { nodes: number; quests: number } =>
      node.children.reduce(
        (sum, child) => {
          const below = count(child);
          return { nodes: sum.nodes + below.nodes, quests: sum.quests + below.quests };
        },
        { nodes: 1, quests: node.quests.length },
      );
    counts = new Map([...buildStoryTrees(nodes)].map(([type, tree]) => [type, count(tree)]));
    const quest = await sim.runtime.vm.library.get('quest');
    declared = [...(quest?.states.get('')?.keys() ?? [])].filter((name) =>
      name.startsWith('onstory'),
    );
    // The player talks to one of the inn's actors (Player Activate Actor).
    const actor = sim.actors().find((staged) => !staged.visibility.hidden)?.reference;
    if (actor !== undefined) {
      talkedTo = actor;
      talkedAt = sim.time;
      sim.activate(actor);
      await sim.step(1);
    }
    // A script sends a story event (queued), then starts a quest that has no event: the start
    // waits behind the event (Quest Start, QSTR).
    wasRunning = sim.isRunning(DUN_BLIND_CLIFF_QST);
    queuedAt = sim.time;
    const player = sim.runtime.actorHandle(PLAYER_REF);
    await sim.native(sim.runtime.formHandle(CR_AELA), 'Keyword', 'SendStoryEvent', [
      null,
      player,
      null,
      0,
      0,
    ]);
    started = await sim.native(sim.runtime.formHandle(DUN_BLIND_CLIFF_QST), 'Quest', 'Start', []);
    await sim.step(1);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('counts each event type’s nodes and quests over the load order', () => {
    console.log(
      [...counts]
        .sort((a, b) => b[1].quests - a[1].quests)
        .map(([type, c]) => `${type} ${String(c.nodes)} nodes, ${String(c.quests)} quests`)
        .join('\n'),
    );
    // Change Location's tree starts 258 quests (engine map, cross-cutting finding 1).
    expect(counts.get('CLOC')?.quests).toBe(258);
    for (const type of counts.keys()) expect(Object.keys(STORY_TYPES)).toContain(type);
  });

  it('knows the OnStory event of every type Quest.pex declares one for', () => {
    expect(declared.length).toBeGreaterThan(25);
    const events = new Set(Object.values(STORY_TYPES).map((type) => type.event.toLowerCase()));
    for (const name of declared) expect(events).toContain(name);
  });

  it('raises Player Activate Actor (AFAV: L1 the actor’s location, R1 the actor) as the player activates one', () => {
    expect(talkedTo).not.toBe(0);
    const raised = sim
      .storyEvents('AFAV')
      .filter((event) => event.at >= talkedAt && event.forms.R1 === talkedTo);
    expect(raised).toHaveLength(1);
    expect(raised[0]?.forms.L1).toBe(BANNERED_MARE_LOCATION);
  });

  it('sends the actor OnActivate(the player) as the player activates it', () => {
    const sent = sim.scriptEvents({ event: 'OnActivate', target: talkedTo, since: talkedAt });
    expect(sent.filter((event) => event.alias === undefined).map((event) => event.args)).toEqual([
      [{ form: PLAYER_REF }],
    ]);
  });

  it('starts a quest a script starts at its turn in the story manager’s queue (QSTR); no node runs for it', () => {
    expect(wasRunning).toBe(false);
    expect(started).toBe(true);
    expect(sim.isRunning(DUN_BLIND_CLIFF_QST)).toBe(true);
    const records = sim.records(queuedAt);
    const script = records.findIndex(
      (record) => record.kind === 'story' && record.type === 'SCPT' && record.forms.K1 === CR_AELA,
    );
    const start = records.findIndex(
      (record) =>
        record.kind === 'game' &&
        record.type === 'questStartStop' &&
        record.event.quest === DUN_BLIND_CLIFF_QST &&
        record.event.started,
    );
    expect(script).toBeGreaterThanOrEqual(0);
    // Behind the event raised before it: the event is processed first.
    expect(start).toBeGreaterThan(script);
    // No story manager node answers a quest start: none starts a quest for one.
    expect(counts.get('QSTR')).toBeUndefined();
    expect(sim.storyEvents('QSTR').flatMap((event) => event.started)).toEqual([]);
  });

  it('raises no Flatter as a persuasion succeeds in dialogue (the original never raises it)', async () => {
    expect(talkedTo).not.toBe(0);
    const record = await sim.db.get(GATE_PERSUADED_INFO);
    expect(record).toBeDefined();
    if (!record) return;
    const since = sim.time;
    // The info's fragments as it is said: FavorDialogueScript.Persuade counts a persuasion. (Its
    // scripts run as the simulation steps.)
    const info = parseInfo(record);
    const said = (async () => {
      await sim.runtime.dialogue.runFragment(info, 'begin', talkedTo);
      await sim.runtime.dialogue.runFragment(info, 'end', talkedTo);
    })();
    for (let i = 0; i < 20 && !(sim.runtime.stats.get('persuasions') ?? 0); i++) {
      await sim.step(0.5);
    }
    await sim.step(0.5);
    void said;
    expect(sim.runtime.stats.get('persuasions')).toBeGreaterThan(0);
    expect(sim.storyEvents('FLAT').filter((event) => event.at >= since)).toEqual([]);
  }, 60_000);
});
