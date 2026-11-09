// The engine's own packages (src/ai/engine-packages.ts): Avoid Player in front of the actor's
// package, its start's test, its spot away from the player.

import { describe, expect, it } from 'vitest';
import { lasting, pack, packageActor, procedure, tick } from '../../tests/helpers/packages.ts';
import {
  ALARM_SECONDS,
  alarmPackage,
  avoidPlayer,
  avoidsPlayer,
  awayFrom,
  Breath,
  fleeFrom,
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

describe('an NPC criminal, the guard that answers', () => {
  const CRIMINAL = 0x300;
  const GUARD = 0x301;

  it('Alarm: the guard runs to the criminal and fights it once it detects it', async () => {
    const at: { here: [number, number, number] } = { here: [3000, 0, 0] };
    const criminal: [number, number, number] = [0, 0, 0];
    const fights: [number, number][] = [];
    const travels: [number, number, number][] = [];
    const { actor } = packageActor(
      [pack(1, procedure('lasting'))],
      { lasting },
      {
        mind: { livePosition: () => criminal },
        body: {
          position: () => at.here,
          // Each leg takes it halfway there.
          travel: (to) => {
            travels.push([to[0], to[1], to[2]]);
            at.here = [(at.here[0] + to[0]) / 2, (at.here[1] + to[1]) / 2, to[2]];
            return Promise.resolve(true);
          },
        },
      },
    );
    await tick(actor, 1);
    const hooks = {
      detects: () => Math.hypot(at.here[0] - criminal[0], at.here[1] - criminal[1]) < 500,
      fight: (guard: number, other: number) => {
        fights.push([guard, other]);
      },
    };
    expect(actor.push('alarm', alarmPackage(hooks), CRIMINAL)).toBe(true);
    await tick(actor, 0.25);
    // Not seen yet: no fight, it heads for the criminal.
    expect(fights).toEqual([]);
    expect(travels[0]).toEqual([0, 0, 0]);
    for (let i = 0; i < 8 && fights.length === 0; i++) await tick(actor, 0.25);
    expect(fights.map(([, other]) => other)).toEqual([CRIMINAL]);
    expect(at.here[0]).toBeLessThan(500);
    await tick(actor, 0.25);
    expect(actor.engine()).toBeUndefined();
  });

  it('Alarm gives up on a dead criminal, or one it does not find in its time', async () => {
    let alive = false;
    const fights: number[] = [];
    const { actor } = packageActor(
      [pack(1, procedure('lasting'))],
      { lasting },
      {
        mind: {
          livePosition: () => [5000, 0, 0],
          alive: () => Promise.resolve(alive),
        },
        body: { position: () => [0, 0, 0], travel: () => new Promise<boolean>(() => undefined) },
      },
    );
    await tick(actor, 1);
    const hooks = {
      detects: () => false,
      fight: (_guard: number, other: number) => fights.push(other),
    };
    expect(actor.push('alarm', alarmPackage(hooks), CRIMINAL)).toBe(true);
    await tick(actor, 0.25);
    expect(actor.engine()).toBeUndefined();
    alive = true;
    expect(actor.push('alarm', alarmPackage(hooks), CRIMINAL)).toBe(true);
    for (let i = 0; i < ALARM_SECONDS * 4 - 2; i++) await tick(actor, 0.25);
    expect(actor.engine()).toBe('alarm');
    for (let i = 0; i < 4; i++) await tick(actor, 0.25);
    expect(actor.engine()).toBeUndefined();
    expect(fights).toEqual([]);
  });

  it('Flee: the criminal runs beyond fFleeDoneDistanceExterior of the guard, fleeing until safe', async () => {
    const at: { here: [number, number, number] } = { here: [0, 0, 0] };
    const travels: [number, number, number][] = [];
    const fleeing: boolean[] = [];
    const { actor } = packageActor(
      [pack(1, procedure('lasting'))],
      { lasting },
      {
        mind: { livePosition: (reference) => (reference === GUARD ? [500, 0, 0] : at.here) },
        body: {
          position: () => at.here,
          travel: (to) => {
            travels.push([to[0], to[1], to[2]]);
            at.here = [to[0], to[1], to[2]];
            return Promise.resolve(true);
          },
          fleeing: (on) => {
            fleeing.push(on);
          },
        },
      },
    );
    await tick(actor, 1);
    expect(actor.push('flee', fleeFrom, GUARD)).toBe(true);
    await tick(actor, 0.5);
    // On the guard's far side, the done distance (2500) and its arrival from it.
    expect(travels).toHaveLength(1);
    expect(travels[0]?.[0]).toBeLessThan(500 - 2500);
    expect(fleeing).toEqual([true]);
    // Safe after fFleeIsSafeTimer (30 s) beyond it: the flight ends, its package goes on.
    for (let i = 0; i < 50; i++) await tick(actor, 0.5);
    expect(actor.engine()).toBe('flee');
    for (let i = 0; i < 14; i++) await tick(actor, 0.5);
    expect(actor.engine()).toBeUndefined();
    expect(fleeing).toEqual([true, false]);
  });
});
