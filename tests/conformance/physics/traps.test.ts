// Conformance: traps (engine map: Physics > Traps). The trap hit events the engine raises when a
// trap's body touches an actor (OnTrapHitStart, OnTrapHit, OnTrapHitStop: 14 vanilla scripts
// handle them), over every trap of the load order. Skipped without game data.
//
// Sources:
// - The engine's rule, observed in the original (src/scripting/runtime/trap-hits.ts): each physics world
//   has a trap listener; bodies on L_TRAP and L_CLOUDTRAP are traps, a character controller's
//   contact with one is a hit. A new contact tells the start, a lasting one a hit once more than
//   [Havok] fTrapHitEventDelayMS (500 ms) has passed since the last telling, its end the stop
//   (TESTrapHitEvent); the scripts hear them only on living actors.
// - The base scripts' declarations (`node tools/script-events.ts OnTrapHit`): OnTrapHitStart,
//   OnTrapHit (akTarget, the velocity, the position, aeMaterial, abInitialHit, aeMotionType),
//   OnTrapHitStop (akTarget).
// - The data (Skyrim.esm): TrapSpear01 [0005B8F4] (TrapHitBase; its spear SpikeTrap, a fixed body
//   on L_TRAP up to 388 units over its origin: `node tools/collision-info.ts
//   meshes/traps/spiketrap/spiketrap01.nif`); one of them, [00050C22], stands in
//   RiftenMercerFreyHouse [00037CC6] at (−2371.1, 2148.9, −814.6).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventHub, type GameEvents } from '../../../src/scripting/runtime/event-hub.ts';
import {
  TRAP_HIT_EVENT_DELAY_MS,
  TrapHits,
  type TrapTouchNow,
} from '../../../src/scripting/runtime/trap-hits.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { openGameFolder } from '../../../tools/gamedata-path.ts';
import { scriptEventUsage } from '../../../tools/script-event-usage.ts';
import { worldRulesCensus, type WorldRulesCensus } from '../../../tools/world-rules-census.ts';
import { hasGamedata, openSim, PLAYER_REF, type Sim } from '../../helpers/sim.ts';

const TOUCH: TrapTouchNow = { position: [1, 2, 3], velocity: [0, 0, -50], motionType: 4 };

describe('trap contacts (the engine’s rule)', () => {
  const setup = () => {
    const hub = new EventHub();
    const told: GameEvents['trapHit'][] = [];
    hub.on('trapHit', (event) => {
      told.push(event);
    });
    let now = 0;
    const hits = new TrapHits(hub, () => now);
    return { hits, told, at: (ms: number) => (now = ms) };
  };

  it('tells the start as a trap first touches an actor', () => {
    const { hits, told } = setup();
    hits.touching(20, new Map([[7, TOUCH]]));
    expect(told).toEqual([
      {
        trap: 7,
        phase: 'start',
        target: 20,
        velocity: [0, 0, -50],
        position: [1, 2, 3],
        material: undefined,
        initial: false,
        motionType: 4,
      },
    ]);
  });

  it('tells a hit once more than fTrapHitEventDelayMS (500 ms) has passed, then again', () => {
    const { hits, told, at } = setup();
    const touching = new Map([[7, TOUCH]]);
    hits.touching(20, touching);
    for (const ms of [100, 400, 500, 501, 900, 1002]) {
      at(ms);
      hits.touching(20, touching);
    }
    expect(told.map((event) => event.phase)).toEqual(['start', 'hit', 'hit']);
    expect(TRAP_HIT_EVENT_DELAY_MS).toBe(500);
  });

  it('tells the stop as the contact ends, and nothing after', () => {
    const { hits, told } = setup();
    hits.touching(20, new Map([[7, TOUCH]]));
    hits.touching(20, new Map());
    hits.touching(20, new Map());
    expect(told.map((event) => event.phase)).toEqual(['start', 'stop']);
  });

  it('keeps an entry per trap and target', () => {
    const { hits, told } = setup();
    hits.touching(20, new Map([[7, TOUCH]]));
    hits.touching(21, new Map([[7, TOUCH]]));
    hits.touching(
      20,
      new Map([
        [7, TOUCH],
        [8, TOUCH],
      ]),
    );
    expect(told.map((event) => `${String(event.trap)}>${String(event.target)}`)).toEqual([
      '7>20',
      '7>21',
      '8>20',
    ]);
  });
});

describe.skipIf(!hasGamedata())('the traps of the load order (data)', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  let census: WorldRulesCensus;
  let handlers: ReadonlyMap<string, readonly string[]>;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    census = await worldRulesCensus(vfs, db);
    handlers = (await scriptEventUsage(vfs)).handlers;
  }, 300_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('counts the scripts that handle the trap hit events (8, 6, 0)', () => {
    expect(handlers.get('ontraphit')?.length).toBe(8);
    expect(handlers.get('ontraphitstart')?.length).toBe(6);
    expect(handlers.get('ontraphitstop')?.length ?? 0).toBe(0);
  });

  it('counts the trap-hit scripts and the 28 bases and 1,797 references that carry them', () => {
    expect([...census.trapHitScripts].sort()).toEqual([
      'bladetraphit',
      'ccbgs_arspiketrapscript',
      'hazardbase',
      'physicstraphit',
      'trapdweflamepillarhit',
      'trapdwethresherhit',
      'traphitbase',
    ]);
    expect(census.trapBases).toBe(28);
    expect(census.trapReferences).toBe(1797);
  });
});

const MERCER_FREY_HOUSE = 0x37cc6;
const SPEAR_TRAP = 0x50c22;

describe.skipIf(!hasGamedata())('the player stands on a spear trap (headless simulation)', () => {
  let sim: Sim;
  let since = 0;

  beforeAll(async () => {
    sim = await openSim({ interior: MERCER_FREY_HOUSE, hour: 10 });
    await sim.step(1);
    since = sim.time;
    await sim.moveTo([-2371.1, 2148.9, -814.6]);
    await sim.step(3);
  }, 600_000);
  afterAll(async () => {
    await sim.close();
  });

  it('tells the trap’s start on the player (TESTrapHitEvent)', () => {
    const hits = sim.events('trapHit').filter((event) => event.trap === SPEAR_TRAP);
    expect(hits[0]).toMatchObject({ phase: 'start', target: PLAYER_REF, initial: false });
  });

  it('sends the trap OnTrapHitStart(akTarget = the player, …)', () => {
    const sent = sim.scriptEvents({ event: 'OnTrapHitStart', target: SPEAR_TRAP, since });
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]?.args[0]).toEqual({ form: PLAYER_REF });
  });
});

describe('what traps do', () => {
  it.todo('hurts the player as the trap’s script processes the hit (ProcessTrapHit)  [data] (sim)');
  it.todo(
    'swings a log trap set off by its tripwire into an actor in its way, which OnTrapHit tells  ' +
      '[data: TrapSwingingLog, Tripwire] (sim)',
  );
  it.todo('tells the hits of a gas cloud (L_CLOUDTRAP) on the actors in it  [original] (sim)');
  it.todo(
    'tells an NPC’s contact with a trap as the player’s (the movers check their controllers)  ' +
      '[original] (sim)',
  );
  it.todo(
    'carries the trap body’s material (aeMaterial) and the initial-hit flag as the engine sets ' +
      'them  [original: unread]',
  );
  it.todo(
    'lets an activator trap with a keyword pass actors that have it (the listener asks the ' +
      'actor)  [original: the keyword is not identified]',
  );
  it.todo(
    'pushes clutter and actors with trap blows by fProjectileKnockMultTrap (0.05) and ' +
      'fGameplayImpulseMultTrap (0.15)  [settings]',
  );
  it.todo(
    'sets traps off by lock picking failures (fLockTrapGoOffBase, fLockTrapGoOffMult)  [settings]',
  );
});
