// When a Decapitate's blow fell, as the graph events' handler tells the dismemberment
// (src/shell/actor-graph-events.ts, src/shell/actor-dismemberment.ts; docs/animation.md,
// "Dismemberment"): an actor's graph on the animation clock, the player's body on its own.

import { describe, expect, it, vi } from 'vitest';
import type { AnimatedSkeleton } from '../src/animation/animated-skeleton.ts';
import { graphEvent, type GraphEvent } from '../src/animation/graph-events.ts';
import type { AnimationResponses } from '../src/formats/animdata/responses.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import type { BlowMoment } from '../src/shell/actor-dismemberment.ts';
import { ActorGraphEvents, type ActorGraphEventsOptions } from '../src/shell/actor-graph-events.ts';
import type { PlayerAvatar } from '../src/shell/player-avatar.ts';

/** Anything asked of it: a function doing nothing, whose members are the same. */
function inert(): unknown {
  return new Proxy(() => undefined, {
    get: (_, key) => (key === 'then' ? undefined : inert()),
  });
}

/** The graph events' handlers on a stage that only records its Decapitate calls. */
async function decapitations(pace = 1): Promise<{
  readonly events: ActorGraphEvents;
  readonly calls: [number, BlowMoment | undefined][];
}> {
  const calls: [number, BlowMoment | undefined][] = [];
  const dismemberment = {
    decapitate: vi.fn((reference: number, moment?: BlowMoment) => {
      calls.push([reference, moment]);
      return Promise.resolve();
    }),
  };
  const stage = new Proxy(
    {},
    { get: (_, key) => (key === 'dismemberment' ? dismemberment : inert()) },
  );
  const responses: AnimationResponses = {
    handlers: new Map([['decapitate', 'DecapitateHandler']]),
    backup: undefined,
  };
  const library = Promise.resolve({ actorResponses: responses, playerResponses: undefined });
  const options = {
    session: {
      animation: { animationData: () => library },
      time: { playerPace: pace },
      scriptsReady: undefined,
      scriptWorld: inert(),
    },
    terminal: inert(),
    stage,
    sounding: inert(),
    gait: () => undefined,
  } as unknown as ActorGraphEventsOptions;
  const events = new ActorGraphEvents(options);
  await library;
  await Promise.resolve();
  return { events, calls };
}

const chop = (late: number): GraphEvent => ({ ...graphEvent('Decapitate'), late });

describe('the Decapitate handler', () => {
  it("gives an actor's blow its moment on the animation clock: its graph's time less the lateness", async () => {
    const { events, calls } = await decapitations();
    const skeleton = { time: 12.5, behavior: undefined } as unknown as AnimatedSkeleton;
    const source = { reference: 0x1234, player: false, firstPerson: false, skeleton };
    events.dispatch.dispatch(source, [chop(0.02)]);
    expect(calls).toEqual([[0x1234, { late: 0.02, graphTime: 12.5 }]]);
  });

  it("does not put the player's avatar clock on the animation clock", async () => {
    // Found in review 2026-11-09: the player's blow was given its avatar's clock less the
    // lateness (minutes ahead of the animation clock after a long chargen, whose menu animates
    // the player on real time), so the head stayed on that long; behind it, the killer's swing
    // was read from before the trail. Only the lateness goes, as seconds of the animation clock
    // (the avatar runs at the player's pace).
    const { events, calls } = await decapitations(0.5);
    const avatar = { body: { time: 300, behavior: undefined }, firstPerson: undefined };
    events.player(avatar as unknown as PlayerAvatar, [chop(0.02)], false);
    expect(calls).toHaveLength(1);
    const [reference, moment] = calls[0] ?? [];
    expect(reference).toBe(PLAYER_REF);
    expect(moment?.graphTime).toBeUndefined();
    expect(moment?.late).toBeCloseTo(0.04, 6);
  });
});
