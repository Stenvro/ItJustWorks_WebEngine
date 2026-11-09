import { describe, expect, it } from 'vitest';
import type { PlayerAppearance } from '../../gameplay/chargen.ts';
import { ActorValue } from '../../world/actor-values.ts';
import { AliasFlag } from '../../world/quest-records.ts';
import { ActorEngine } from './actor-engine.ts';
import { EventHub } from './event-hub.ts';
import { PLAYER_BASE, PLAYER_REF } from './forms.ts';
import { GameState } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';
import { relayScriptEvents, type ScriptEventHost } from './script-events.ts';

const NORD = 0x13746;
const ARGONIAN = 0x13740;
const WEREWOLF = 0xcdd84;

const appearance: PlayerAppearance = {
  race: ARGONIAN,
  sex: 1,
  weight: 50,
  headParts: [],
  hairColor: undefined,
  skinTone: [1, 1, 1],
  faceMorphs: [],
  faceParts: [0, -1, 0, 0],
  tints: [],
  complexion: undefined,
};

/** A runtime with the game state and a Player record named "Prisoner". */
function engine(state: GameState): ActorEngine {
  return new ActorEngine({
    state,
    forms: {
      record: (formId: number) =>
        Promise.resolve(
          formId === PLAYER_BASE ? { type: 'NPC_', text: () => 'Prisoner' } : undefined,
        ),
    },
  } as unknown as ScriptRuntime);
}

describe("the player's race, sex and name", () => {
  it('are the race menu choices once made', async () => {
    const state = new GameState();
    state.playerAppearance = appearance;
    state.playerName = 'Big E';
    const actors = engine(state);
    expect(await actors.raceOf(PLAYER_REF)).toBe(ARGONIAN);
    expect(await actors.baseRace(PLAYER_BASE)).toBe(ARGONIAN);
    expect(await actors.baseSex(PLAYER_BASE)).toBe(1);
    expect(await actors.isFemale(PLAYER_REF)).toBe(true);
    expect(await actors.playerName()).toBe('Big E');
  });

  it("keep the base's race when Actor.SetRace changes the actor's", async () => {
    const state = new GameState();
    state.playerAppearance = { ...appearance, race: NORD };
    state.actor(PLAYER_REF).race = WEREWOLF;
    const actors = engine(state);
    expect(await actors.raceOf(PLAYER_REF)).toBe(WEREWOLF);
    expect(await actors.baseRace(PLAYER_BASE)).toBe(NORD);
  });

  it("take the Player record's name before one is chosen", async () => {
    expect(await engine(new GameState()).playerName()).toBe('Prisoner');
  });
});

/** What a death tells the world and the scripts, in order. */
interface DeathLog {
  readonly calls: string[];
  readonly runtime: { godMode: boolean };
}

/**
 * A runtime for the player's death: the player's health 100, an alias (quest 0x100, alias 1)
 * holding them, essential if `essentialAlias`.
 */
function dyingEngine(
  essentialAlias = false,
  dying?: (actor: number) => Promise<void> | undefined,
): { actors: ActorEngine; log: DeathLog } {
  const state = new GameState();
  const calls: string[] = [];
  const runtime = {
    state,
    godMode: false,
    debug: { immortal: false },
    forms: {
      record: () => Promise.resolve(undefined),
      alias: () => Promise.resolve({ flags: essentialAlias ? AliasFlag.essential : 0 }),
    },
    baseOf: () => Promise.resolve(undefined),
    indexedFlags: () => undefined,
    aliasesHolding: () => [{ quest: 0x100, alias: 1 }],
    actorHandle: (reference: number) => `actor ${reference.toString(16)}`,
    world: {
      killed: (actor: number, killer: number | undefined) => {
        calls.push(`killed ${actor.toString(16)} by ${String(killer?.toString(16))}`);
      },
      bleedout: (actor: number) => {
        calls.push(`bleedout ${actor.toString(16)}`);
      },
      dying,
    },
    magic: { died: () => Promise.resolve() },
    perks: { leveledLists: () => Promise.resolve([]) },
    crime: { killed: () => Promise.resolve() },
    // The runtime sends an actor's events to it and its aliases (ScriptRuntime.sendEvent).
    sendEvent: (target: number, event: string, args: readonly unknown[] = []) => {
      calls.push(`${event} ${target.toString(16)} (${String(args[0])})`);
      return Promise.resolve();
    },
    events: new EventHub(),
    // OnDeath waits for a dying actor's end (ScriptRuntime.dyingEnd).
    dyingEnd: (actor: number) => made.engine?.dyingEnd(actor),
  };
  const made: { engine?: ActorEngine } = {};
  // The hub's events reach the scripts through the relay (script-events.ts).
  relayScriptEvents(runtime as unknown as ScriptEventHost);
  const actors = new ActorEngine(runtime as unknown as ScriptRuntime);
  made.engine = actors;
  actors.setBase(PLAYER_REF, ActorValue.health, 100);
  return { actors, log: { calls, runtime } };
}

describe("the player's death", () => {
  it('kills the player at no health: the world shows it, OnDying then OnDeath', async () => {
    const { actors, log } = dyingEngine();
    await actors.damage(PLAYER_REF, ActorValue.health, 60, 0x1234);
    expect(await actors.isDead(PLAYER_REF)).toBe(false);
    await actors.damage(PLAYER_REF, ActorValue.health, 60, 0x1234);
    expect(await actors.isDead(PLAYER_REF)).toBe(true);
    expect(log.calls).toEqual([
      'killed 14 by 1234',
      'OnDying 14 (actor 1234)',
      'OnDeath 14 (actor 1234)',
    ]);
    expect((await actors.value(PLAYER_REF, ActorValue.health)).current).toBeLessThanOrEqual(0);
    // Dead once: more blows do nothing.
    await actors.damage(PLAYER_REF, ActorValue.health, 10, 0x1234);
    expect(log.calls).toHaveLength(3);
  });

  it('kills the player by a script (Actor.Kill), without a killer', async () => {
    const { actors, log } = dyingEngine();
    await actors.scriptKill(PLAYER_REF, undefined);
    expect(await actors.isDead(PLAYER_REF)).toBe(true);
    expect(log.calls).toEqual(['killed 14 by undefined', 'OnDying 14 (null)', 'OnDeath 14 (null)']);
  });

  it('lets an essential player (an alias) bleed out instead, from blows and Kill', async () => {
    const blows = dyingEngine(true);
    await blows.actors.damage(PLAYER_REF, ActorValue.health, 200, 0x1234);
    expect(await blows.actors.isDead(PLAYER_REF)).toBe(false);
    expect(blows.log.calls).toEqual(['bleedout 14']);
    const kill = dyingEngine(true);
    await kill.actors.scriptKill(PLAYER_REF, 0x1234);
    expect(await kill.actors.isDead(PLAYER_REF)).toBe(false);
    expect(kill.log.calls).toEqual(['bleedout 14']);
    // KillEssential: Kill once Essential is cleared (here: the engine's kill).
    await kill.actors.kill(PLAYER_REF, 0x1234);
    expect(await kill.actors.isDead(PLAYER_REF)).toBe(true);
  });

  it('keeps the player from harm and death in god mode', async () => {
    const { actors, log } = dyingEngine();
    log.runtime.godMode = true;
    await actors.damage(PLAYER_REF, ActorValue.health, 500, 0x1234);
    await actors.damage(PLAYER_REF, ActorValue.stamina, 50);
    expect((await actors.value(PLAYER_REF, ActorValue.health)).current).toBe(100);
    await actors.scriptKill(PLAYER_REF, undefined);
    expect(await actors.isDead(PLAYER_REF)).toBe(false);
    expect(log.calls).toEqual([]);
    log.runtime.godMode = false;
    await actors.damage(PLAYER_REF, ActorValue.health, 500, 0x1234);
    expect(await actors.isDead(PLAYER_REF)).toBe(true);
  });
});

describe('the dying life state', () => {
  const GUARD = 0x5000;

  it('tells OnDying at the kill and OnDeath only once the world says its dying ended', async () => {
    let dead = (): void => undefined;
    const { actors, log } = dyingEngine(false, (actor) =>
      actor === GUARD
        ? new Promise<void>((resolve) => {
            dead = resolve;
          })
        : undefined,
    );
    actors.setBase(GUARD, ActorValue.health, 50);
    await actors.damage(GUARD, ActorValue.health, 80, 0x1234);
    // Dying: IsDead already answers yes, OnDying was told, OnDeath waits.
    expect(await actors.isDead(GUARD)).toBe(true);
    expect(actors.dying(GUARD)).toBe(true);
    expect(log.calls).toEqual(['killed 5000 by 1234', 'OnDying 5000 (actor 1234)']);
    dead();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(actors.dying(GUARD)).toBe(false);
    expect(log.calls).toEqual([
      'killed 5000 by 1234',
      'OnDying 5000 (actor 1234)',
      'OnDeath 5000 (actor 1234)',
    ]);
  });

  it('sends no OnDeath to one resurrected while it was dying', async () => {
    let dead = (): void => undefined;
    const { actors, log } = dyingEngine(
      false,
      () =>
        new Promise<void>((resolve) => {
          dead = resolve;
        }),
    );
    actors.setBase(GUARD, ActorValue.health, 50);
    await actors.kill(GUARD, undefined);
    await actors.resurrect(GUARD);
    dead();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(log.calls).toEqual([
      'killed 5000 by undefined',
      'OnDying 5000 (null)',
      'OnResurrect 5000 (undefined)',
    ]);
    expect(await actors.isDead(GUARD)).toBe(false);
  });
});

describe('vendors', () => {
  /** A vendor in one faction trading 8–20 near a far-off reference; its package's PKDT flags. */
  function vendor(hour: number, packageFlags: number | undefined): ActorEngine {
    const pkdt = new Uint8Array(12);
    new DataView(pkdt.buffer).setUint32(0, packageFlags ?? 0, true);
    const record = {
      type: 'PACK',
      fields: { first: (sig: string) => (sig === 'PKDT' ? pkdt : undefined) },
    };
    const actors = new ActorEngine({
      state: new GameState(),
      gameHour: hour,
      referenceHandle: () => ({}),
      conditionsHold: () => Promise.resolve(true),
      currentPackage: () => (packageFlags === undefined ? undefined : 0x500),
      placement: () => Promise.resolve({ position: [0, 0, 0], world: 1, cell: 2 }),
      forms: {
        record: (formId: number) => Promise.resolve(formId === 0x500 ? record : undefined),
      },
    } as unknown as ScriptRuntime);
    actors.factionsOf = () => Promise.resolve(new Map([[0x600, 0]]));
    actors.faction = () =>
      Promise.resolve({
        vendor: { startHour: 8, endHour: 20, radius: 0, location: undefined, conditions: [] },
      } as never);
    return actors;
  }

  it('trade outside their hours while their package offers services (PKDT 0x1)', async () => {
    expect(await vendor(12, 0).offersServicesNow(0x800)).toBe(true);
    expect(await vendor(22, 0).offersServicesNow(0x800)).toBe(false);
    expect(await vendor(22, 0x1).offersServicesNow(0x800)).toBe(true);
  });
});

describe('a deferred kill across a save', () => {
  it('keeps a killmove victim deferred, so the killmove’s end kills it after the load', async () => {
    const { actors } = dyingEngine();
    actors.startDeferredKill(PLAYER_REF);
    await actors.damage(PLAYER_REF, ActorValue.health, 120, 0x1234);
    expect(await actors.isDead(PLAYER_REF)).toBe(false);
    const saved = actors.saveData();
    expect(saved).toEqual([[PLAYER_REF, 1, 0x1234]]);
    // Loaded: its health runs out without its dying until the deferral ends, by its killer.
    const loaded = dyingEngine();
    loaded.actors.loadData(saved);
    await loaded.actors.damage(PLAYER_REF, ActorValue.health, 120, 0x1234);
    expect(await loaded.actors.isDead(PLAYER_REF)).toBe(false);
    await loaded.actors.endDeferredKill(PLAYER_REF);
    expect(await loaded.actors.isDead(PLAYER_REF)).toBe(true);
    expect(loaded.log.calls[0]).toBe('killed 14 by 1234');
  });
});
