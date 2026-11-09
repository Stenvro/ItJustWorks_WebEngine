// The engine's own packages (src/ai/engine-packages.ts): Avoid Player in front of the actor's
// package, its start's test, its spot away from the player.

import { describe, expect, it } from 'vitest';
import { pack, packageActor, procedure, tick } from '../../tests/helpers/packages.ts';
import {
  avoidPlayer,
  avoidsPlayer,
  awayFrom,
  Breath,
  feedOn,
  followCommander,
  followSpot,
  followsUp,
  getUpFromChairBed,
  reactToDestroyedObject,
  StealWarnings,
  warnThief,
} from './engine-packages.ts';
import type { ProcedureRunner } from './package-runtime.ts';

describe('engine packages', () => {
  it('Avoid Player starts within fTriggerAvoidPlayerDistance, for one that sees them, out of combat', () => {
    expect(avoidsPlayer(300, true, false, 400)).toBe(true);
    expect(avoidsPlayer(450, true, false, 400)).toBe(false);
    expect(avoidsPlayer(300, false, false, 400)).toBe(false);
    expect(avoidsPlayer(300, true, true, 400)).toBe(false);
  });

  it('goes to the player’s far side', () => {
    const [x, y] = awayFrom([50, 0, 0], [0, 0, 0], 200);
    expect(x).toBeCloseTo(200, 6);
    expect(y).toBeCloseTo(0, 6);
  });

  it('sets the package aside while the player is near, then its package runs again', async () => {
    let starts = 0;
    const lasting: ProcedureRunner = async (run) => {
      starts++;
      while (!run.stopped()) await run.wait(1);
      return 'failure';
    };
    const at: { here: [number, number, number] } = { here: [50, 0, 0] };
    const travels: [number, number, number][] = [];
    const { actor, events } = packageActor(
      [pack(1, procedure('lasting'))],
      { lasting },
      {
        mind: { livePosition: () => [0, 0, 0] },
        body: {
          position: () => at.here,
          travel: (to) => {
            travels.push([to[0], to[1], to[2]]);
            at.here = [to[0], to[1], to[2]];
            return Promise.resolve(true);
          },
        },
      },
    );
    await tick(actor, 1);
    expect(starts).toBe(1);
    expect(actor.push('avoidPlayer', avoidPlayer)).toBe(true);
    // One at a time.
    expect(actor.push('avoidPlayer', avoidPlayer)).toBe(false);
    expect(actor.engine()).toBe('avoidPlayer');
    for (let i = 0; i < 12; i++) await tick(actor, 0.25);
    expect(travels[0]?.[0]).toBeCloseTo(200, 6);
    expect(actor.engine()).toBeUndefined();
    await tick(actor, 0.25);
    expect(starts).toBe(2);
    // Its own package was set aside, not left: no package events.
    expect(events.filter((event) => !event.startsWith('begin'))).toEqual([]);
  });

  it('Follow Commander: beyond fSummonedCreatureMaxFollowDist it makes for the minimum’s spot', async () => {
    const settings = { summonedMinFollowDist: 250, summonedMaxFollowDist: 400 };
    expect(followsUp(399, settings)).toBe(false);
    expect(followsUp(401, settings)).toBe(true);
    const [x, y] = followSpot([1000, 0, 0], [0, 0, 0], 250);
    expect(x).toBeCloseTo(250, 6);
    expect(y).toBeCloseTo(0, 6);
    const at: { here: [number, number, number] } = { here: [1000, 0, 0] };
    const travels: [number, number, number][] = [];
    const lasting: ProcedureRunner = async (run) => {
      while (!run.stopped()) await run.wait(1);
      return 'failure';
    };
    const { actor } = packageActor(
      [pack(1, procedure('lasting'))],
      { lasting },
      {
        mind: { livePosition: () => [0, 0, 0] },
        body: {
          position: () => at.here,
          travel: (to) => {
            travels.push([to[0], to[1], to[2]]);
            at.here = [to[0], to[1], to[2]];
            return Promise.resolve(true);
          },
        },
      },
    );
    await tick(actor, 1);
    const commander = 0x14;
    expect(actor.push('followCommander', followCommander, commander)).toBe(true);
    for (let i = 0; i < 4; i++) await tick(actor, 0.25);
    expect(travels).toHaveLength(1);
    expect(travels[0]?.[0]).toBeCloseTo(250, 6);
    // Near enough, it stands: its following goes on while it is commanded.
    for (let i = 0; i < 8; i++) await tick(actor, 0.25);
    expect(travels).toHaveLength(1);
    expect(actor.engine()).toBe('followCommander');
  });

  it('Steal Warning: iStealWarnings warnings, forgotten fWarningTimer after the first', () => {
    const warnings = new StealWarnings();
    const settings = { stealWarnings: 2, warningTimer: 5 };
    for (const now of [0, 1]) {
      expect(warnings.due(now, settings)).toBe(true);
      warnings.give(now, settings);
    }
    // Used up: the next theft seen is the crime.
    expect(warnings.due(2, settings)).toBe(false);
    expect(warnings.due(5, settings)).toBe(true);
    expect(warnings.count).toBe(0);
  });

  it('the owner comes up to the thief, warns them and watches them before its package', async () => {
    const at: { here: [number, number, number] } = { here: [1000, 0, 0] };
    const said: string[] = [];
    const lasting: ProcedureRunner = async (run) => {
      while (!run.stopped()) await run.wait(1);
      return 'failure';
    };
    const { actor } = packageActor(
      [pack(1, procedure('lasting'))],
      { lasting },
      {
        mind: { livePosition: () => [0, 0, 0] },
        body: {
          position: () => at.here,
          travel: (to, _gait, arrive) => {
            at.here = [to[0] + arrive - 10, to[1], to[2]];
            return Promise.resolve(true);
          },
          say: (line) => {
            said.push(String(line));
          },
        },
      },
    );
    await tick(actor, 1);
    expect(actor.push('stealWarning', warnThief('StealFromNC'))).toBe(true);
    await tick(actor, 0.25);
    expect(said).toEqual(['StealFromNC']);
    expect(at.here[0]).toBeLessThanOrEqual(150);
    // It watches them fWarningTimer (5 s), then its own package goes on.
    for (let i = 0; i < 4; i++) await tick(actor, 1);
    expect(actor.engine()).toBe('stealWarning');
    for (let i = 0; i < 3; i++) await tick(actor, 1);
    expect(actor.engine()).toBeUndefined();
  });

  it('React To Destroyed Object turns to the object; Get Up leaves its furniture', async () => {
    let heading: number | undefined;
    let left = 0;
    const lasting: ProcedureRunner = async (run) => {
      while (!run.stopped()) await run.wait(1);
      return 'failure';
    };
    const { actor } = packageActor(
      [pack(1, procedure('lasting'))],
      { lasting },
      {
        mind: { livePosition: () => [100, 0, 0] },
        body: {
          position: () => [0, 0, 0],
          face: (to) => {
            heading = to ?? heading;
          },
          leaveFurniture: () => {
            left++;
            return Promise.resolve();
          },
        },
      },
    );
    await tick(actor, 1);
    expect(actor.push('reactToDestroyedObject', reactToDestroyedObject, 7)).toBe(true);
    await tick(actor, 0.1);
    expect(heading).toBeCloseTo(Math.PI / 2, 6);
    for (let i = 0; i < 4; i++) await tick(actor, 1);
    expect(actor.engine()).toBeUndefined();
    expect(actor.push('getUpFromChairBed', getUpFromChairBed)).toBe(true);
    await tick(actor, 0.1);
    expect(left).toBe(1);
    expect(actor.engine()).toBeUndefined();
  });
});

describe('what starts Get Up and Surface', () => {
  it('gets an actor up from its furniture before an engine package that moves it', async () => {
    const order: string[] = [];
    const lasting: ProcedureRunner = async (run) => {
      while (!run.stopped()) await run.wait(1);
      return 'failure';
    };
    let near = true;
    const { actor } = packageActor(
      [pack(1, procedure('lasting'))],
      { lasting },
      {
        mind: { livePosition: () => (near ? [20, 0, 0] : [5000, 0, 0]) },
        body: {
          position: () => [50, 0, 0],
          leaveFurniture: () => {
            order.push('up');
            return Promise.resolve();
          },
          travel: () => {
            order.push('travel');
            near = false;
            return Promise.resolve(true);
          },
        },
      },
    );
    await tick(actor, 1);
    order.length = 0;
    expect(actor.push('avoidPlayer', avoidPlayer)).toBe(true);
    await tick(actor, 0.1);
    expect(order.slice(0, 2)).toEqual(['up', 'travel']);
  });

  it('puts Get Up From Chair Or Bed in front of an engine package on a seated actor (inferred)', async () => {
    const lasting: ProcedureRunner = async (run) => {
      while (!run.stopped()) await run.wait(1);
      return 'failure';
    };
    let seat: number | undefined = 0x77;
    let stand: (() => void) | undefined;
    const { actor } = packageActor(
      [pack(1, procedure('lasting'))],
      { lasting },
      {
        mind: { livePosition: () => [20, 0, 0] },
        body: {
          position: () => [50, 0, 0],
          inFurniture: () => seat,
          leaveFurniture: () =>
            seat === undefined
              ? Promise.resolve()
              : new Promise<void>((resolve) => {
                  stand = () => {
                    seat = undefined;
                    resolve();
                  };
                }),
          travel: () => new Promise<boolean>(() => undefined),
        },
      },
    );
    await tick(actor, 1);
    expect(actor.push('avoidPlayer', avoidPlayer)).toBe(true);
    // It runs Get Up, a package of its own, until it stands; then Avoid Player.
    await tick(actor, 0.1);
    expect(actor.engine()).toBe('getUpFromChairBed');
    stand?.();
    await tick(actor, 0.1);
    expect(actor.engine()).toBe('avoidPlayer');
  });

  it('runs Vampire Feed as a package in front of the feeder’s own while the feeding lasts', async () => {
    let starts = 0;
    const lasting: ProcedureRunner = async (run) => {
      starts++;
      while (!run.stopped()) await run.wait(1);
      return 'failure';
    };
    let heading = 0;
    let feeding = false;
    const told: string[] = [];
    const { actor } = packageActor(
      [pack(1, procedure('lasting'))],
      { lasting },
      {
        mind: { livePosition: () => [0, 100, 0] },
        body: {
          position: () => [0, 0, 0],
          inFurniture: () => undefined,
          face: (to) => {
            heading = to ?? heading;
          },
        },
      },
    );
    await tick(actor, 1);
    const feed = feedOn({
      begin: () => {
        feeding = true;
        told.push('begin');
      },
      feeding: () => feeding,
      end: () => told.push('end'),
    });
    expect(actor.push('vampireFeed', feed, 0x400)).toBe(true);
    await tick(actor, 0.1);
    // Turned to its target, feeding: its own package set aside meanwhile.
    expect(actor.engine()).toBe('vampireFeed');
    expect(heading).toBeCloseTo(0, 6);
    expect(told).toEqual(['begin']);
    await tick(actor, 1);
    expect(actor.engine()).toBe('vampireFeed');
    // Its graph's feed end: the package ends, its own runs again.
    feeding = false;
    await tick(actor, 0.2);
    expect(told).toEqual(['begin', 'end']);
    expect(actor.engine()).toBeUndefined();
    await tick(actor, 0.2);
    expect(starts).toBe(2);
  });

  it('has a swimmer under water surface once its breath is short of the rise and a second', () => {
    const settings = { swimBreathBase: 10, swimBreathMult: 0.5 };
    const breath = new Breath();
    // 35 s of breath; 200 units down at 100 a second: it surfaces with under 4 s left.
    let surfaced = -1;
    for (let second = 1; second <= 40 && surfaced < 0; second++) {
      if (breath.step(1, true, 200, 100, settings)) surfaced = second;
    }
    expect(surfaced).toBe(32);
    // Its head out, its breath is full again.
    expect(breath.step(1, false, 0, 100, settings)).toBe(false);
    expect(breath.left).toBeUndefined();
  });
});
