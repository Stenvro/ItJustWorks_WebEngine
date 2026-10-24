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
