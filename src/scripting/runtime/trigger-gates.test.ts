import { describe, expect, it } from 'vitest';
import type { PexInstruction, PexScript } from '../../formats/pex/pex.ts';
import { triggerEnterAsksForPlayer } from './trigger-gates.ts';

const id = (name: string) => ({ kind: 'identifier', name }) as const;

/** A script of one object whose states hold the functions given (name → code). */
function script(
  name: string,
  parent: string,
  states: Record<string, Record<string, readonly PexInstruction[]>>,
): PexScript {
  return {
    majorVersion: 3,
    minorVersion: 2,
    gameId: 1,
    sourceFile: `${name}.psc`,
    objects: [
      {
        name,
        parent,
        docString: '',
        userFlags: 0,
        autoState: '',
        variables: [],
        properties: [],
        states: Object.entries(states).map(([state, functions]) => ({
          name: state,
          functions: Object.entries(functions).map(([fn, code]) => ({
            name: fn,
            returnType: 'None',
            docString: '',
            userFlags: 0,
            global: false,
            native: false,
            params: [],
            locals: [],
            code,
          })),
        })),
      },
    ],
  };
}

const getPlayer: PexInstruction = {
  op: 'callstatic',
  args: [id('game'), id('GetPlayer'), id('::temp0')],
};
const getBase: PexInstruction = {
  op: 'callmethod',
  args: [id('GetActorBase'), id('actorRef'), id('::temp2')],
};

describe('triggerEnterAsksForPlayer', () => {
  const scripts = new Map<string, PexScript>([
    // RDSTriggerScript: compares who entered with the player.
    [
      'playergate',
      script('PlayerGate', 'ObjectReference', { '': { OnTriggerEnter: [getPlayer] } }),
    ],
    // defaultsetStageTrigSCRIPT: its handler lives in a state.
    [
      'stategate',
      script('StateGate', 'ObjectReference', {
        '': { OnInit: [] },
        waitingForPlayer: { onTriggerEnter: [getPlayer] },
      }),
    ],
    // defaultSetStageTRIGSpecificActor: compares the actor's base with a property.
    [
      'actorgate',
      script('ActorGate', 'ObjectReference', { waitingForActor: { OnTriggerEnter: [getBase] } }),
    ],
    // A child without a handler of its own: its parent's counts.
    ['child', script('Child', 'PlayerGate', { '': { TriggerMe: [] } })],
  ]);
  const load = (name: string): Promise<PexScript | undefined> =>
    Promise.resolve(scripts.get(name.toLowerCase()));

  it("finds the player asked for in a trigger's enter event, in any state", async () => {
    expect(await triggerEnterAsksForPlayer('PlayerGate', load)).toBe(true);
    expect(await triggerEnterAsksForPlayer('StateGate', load)).toBe(true);
  });

  it('does not take a trigger for another actor as one for the player', async () => {
    expect(await triggerEnterAsksForPlayer('ActorGate', load)).toBe(false);
  });

  it("reads a parent's handler where the script has none", async () => {
    expect(await triggerEnterAsksForPlayer('Child', load)).toBe(true);
    expect(await triggerEnterAsksForPlayer('Missing', load)).toBe(false);
  });
});
