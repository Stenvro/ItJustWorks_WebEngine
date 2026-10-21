import { describe, expect, it } from 'vitest';
import { ActorExecutions } from './actor-executions.ts';
import type { FurnitureUser } from './actor-furniture.ts';

const BLOCK = 0xaa7cc;

function setup(entered: Map<number, string>) {
  const sent: string[] = [];
  const killed: string[] = [];
  const executions = new ActorExecutions({
    enteredBy: (reference) => {
      const event = entered.get(reference);
      return event === undefined ? undefined : { furniture: BLOCK, events: [event] };
    },
    kill: (victim, killer) => {
      killed.push(`${victim.toString(16)} by ${killer.toString(16)}`);
    },
  });
  const actors = [0x1, 0x2, 0x3].map((reference) => ({
    reference,
    dead: false,
    user: () =>
      ({
        reference,
        send: (event: string) => {
          sent.push(`${reference.toString(16)} ${event}`);
          return true;
        },
      }) as unknown as FurnitureUser,
  }));
  return { executions, actors, sent, killed };
}

describe('executions at a chopping block', () => {
  it('chops once the executioner, the guard and the prisoner are all in', () => {
    const entered = new Map([
      [0x1, 'IdleExecutionerIdle'],
      [0x2, 'IdleExecutioneeIdle'],
    ]);
    const { executions, actors, sent, killed } = setup(entered);
    executions.frame(actors);
    // Without the guard behind the prisoner, nothing yet.
    expect(sent).toEqual([]);
    entered.set(0x3, 'IdleExecutionGuardIdle');
    executions.frame(actors);
    executions.frame(actors);
    expect(sent).toEqual([
      '1 IdleExecutionerChop',
      '3 IdleExecutionerChop',
      '2 IdleExecutionerChop',
    ]);
    // The blow kills the prisoner, once.
    executions.events(0x2, ['SoundPlay.NPCHumanExecutionerPushA']);
    expect(killed).toEqual([]);
    executions.events(0x2, ['Decapitate']);
    expect(killed).toEqual([]);
    executions.events(0x2, ['KillActor']);
    executions.events(0x2, ['KillActor']);
    expect(killed).toEqual(['2 by 1']);
  });

  it('raises the axe over the player: their own chop, the guard pushes', () => {
    const entered = new Map([
      [0x1, 'IdleExecutionerIdle'],
      [0x3, 'IdleExecutionGuardIdle'],
      [0x14, 'IdleExecutioneeIdle'],
    ]);
    const { executions, sent } = setup(entered);
    const user = (reference: number) => () =>
      ({
        reference,
        send: (event: string) => {
          sent.push(`${reference.toString(16)} ${event}`);
          return true;
        },
      }) as unknown as FurnitureUser;
    executions.frame(
      [0x1, 0x3, 0x14].map((reference) => ({ reference, dead: false, user: user(reference) })),
    );
    expect(sent).toEqual([
      '1 IdleExecutionerChop_Player',
      '3 IdleExecutionerChop',
      '14 IdleExecutionerChop_Player',
    ]);
  });
});
