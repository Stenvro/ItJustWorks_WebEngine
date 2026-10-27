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

  it.todo(
    'raises no Change Location for a move between cells of one location (the engine raises it ' +
      'only between locations: CK, Change Location event)',
  );
  it.todo(
    'raises Change Location for no actor but the player, while NPCs still get ' +
      'OnLocationChange (engine map: Script events, OnLocationChange for NPCs)',
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
  QSTR: { event: '', when: 'a quest starts (the TES5 quest start event; no OnStory event)' },
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

/** The types our engine raises, and where (docs/scripting.md "Story events"). */
const RAISED: Readonly<Record<string, string>> = {
  ADCR: 'crime-engine.ts',
  ADIA: 'actor-talk.ts',
  AHEL: 'the actors’ looks',
  AIPL: 'the takes, the container and barter menus',
  ARRT: 'the guards’ arrest',
  ASSU: 'crime-engine.ts',
  BRIB: 'dialogue-engine.ts (a bribe counted)',
  CAST: 'casting-engine.ts',
  CHRR: 'crime-engine.ts',
  CRFT: 'crafting-menu.ts',
  CURE: 'magic-engine.ts (Cure Disease)',
  DEAD: 'the senses',
  ESJA: 'crime-engine.ts',
  INFC: 'magic-engine.ts (contractDisease)',
  INTM: 'dialogue-engine.ts (an intimidation counted)',
  JAIL: 'crime-engine.ts',
  PRFV: 'Actor.SetDoingFavor',
  QSTR: 'story-events.ts (the quest start event)',
  KILL: 'crime-engine.ts (checked in event-sources.test.ts)',
  LEVL: 'progression-engine.ts',
  LOCK: 'crime-engine.ts',
  NVPE: 'casting-engine.ts, actor-engine.ts',
  PFIN: 'crime-engine.ts',
  REMP: 'the inventory’s drop',
  SCPT: 'Keyword.SendStoryEvent',
  SKIL: 'progression-engine.ts',
  STIJ: 'crime-engine.ts',
  TRES: 'crime-engine.ts',
};

/** The types the interaction cases of this suite check (CLOC above, AFAV and FLAT below). */
const CHECKED = new Set(['CLOC', 'AFAV', 'FLAT']);
/** The Whiterun gate guard's line as the player's persuasion succeeds (its fragment: Persuade). */
const GATE_PERSUADED_INFO = 0xd1981;

describe('every story manager event type', () => {
  for (const [type, { event, when }] of Object.entries(STORY_TYPES)) {
    if (CHECKED.has(type)) continue;
    const raised = RAISED[type];
    const name = event ? ` (${event})` : '';
    it.todo(
      raised === undefined
        ? `raises ${type}${name} as ${when}: not raised yet  [xEdit, Quest.pex]`
        : `raises ${type}${name} as ${when}: raised by ${raised}, to check in the simulation  ` +
            '[xEdit, Quest.pex]',
    );
  }
});

describe.skipIf(!hasGamedata())('the story manager’s events (data, headless simulation)', () => {
  let sim: Sim;
  let declared: string[] = [];
  let counts = new Map<string, { nodes: number; quests: number }>();
  let talkedTo = 0;
  let talkedAt = 0;

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

  it('raises Flatter (FLAT: R1 the actor) as a persuasion succeeds in dialogue', async () => {
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
    for (let i = 0; i < 20 && sim.storyEvents('FLAT').length === 0; i++) await sim.step(0.5);
    await sim.step(0.5);
    void said;
    expect(sim.runtime.stats.get('persuasions')).toBeGreaterThan(0);
    const raised = sim.storyEvents('FLAT').filter((event) => event.at >= since);
    expect(raised.map((event) => event.forms.R1)).toEqual([talkedTo]);
  }, 60_000);
});
