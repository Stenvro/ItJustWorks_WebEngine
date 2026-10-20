import { describe, expect, it } from 'vitest';
import { bearing, Reaction, type ReactionBody, type ReactionSettings } from './reactions.ts';

type Vec3 = readonly [number, number, number];

const settings: ReactionSettings = {
  searchInvestigateDistance: 256,
  searchLookTime: 1,
  searchInvestigateTime: 2.5,
  stateExpireTime: 30,
  spectatorDistance: 200,
  spectatorShutdownDistance: 1000,
  spectatorRememberTimer: 5,
};

/** A body that walks at once to where it is sent, and writes down what it does. */
function body(start: Vec3): ReactionBody & { log: string[]; at: Vec3 } {
  const self = {
    log: [] as string[],
    at: start,
    position: () => self.at,
    travel: (to: Vec3) => {
      self.log.push(`travel ${to.map(Math.round).join(',')}`);
      self.at = to;
      return Promise.resolve(true);
    },
    face: (heading: number | undefined) => {
      self.log.push(heading === undefined ? 'face none' : 'face');
    },
    stop: () => self.log.push('stop'),
    say: (subtype: string) => self.log.push(`say ${subtype}`),
  };
  return self;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('reactions', () => {
  it('measure headings clockwise from north', () => {
    expect(bearing([0, 0, 0], [0, 10, 0])).toBeCloseTo(0, 9);
    expect(bearing([0, 0, 0], [10, 0, 0])).toBeCloseTo(Math.PI / 2, 9);
  });

  it('search: turn to the place, walk there, look round three times, go back', async () => {
    const actor = body([0, 0, 0]);
    const search = new Reaction('search', [1000, 0, 0], 0x14, actor, settings, () => 0.5);
    expect(actor.log).toEqual(['say NormalToAlert']);
    expect(search.update(0.5)).toBe(true);
    expect(search.update(0.6)).toBe(true);
    // Turned for fCombatSearchLookTime: on its way.
    expect(search.update(0.1)).toBe(true);
    expect(actor.log).toContain('travel 1000,0,0');
    await tick();
    expect(search.update(0.1)).toBe(true);
    // Three looks of fCombatSearchInvestigateTime, then it ends.
    expect(search.update(2.5)).toBe(true);
    expect(search.update(2.5)).toBe(true);
    expect(search.update(2.5)).toBe(false);
    expect(actor.log.slice(-3)).toEqual(['say AlertToNormal', 'stop', 'face none']);
  });

  it('search ends when what it looked for is found, or after fDetectionStateExpireTime', () => {
    const found = new Reaction('search', [100, 0, 0], 1, body([0, 0, 0]), settings, () => 0);
    expect(found.update(0.1, { over: true })).toBe(false);
    const long = new Reaction('search', [100, 0, 0], 1, body([0, 0, 0]), settings, () => 0);
    expect(long.update(31)).toBe(false);
  });

  it('observing the dead: walk to the body, say NoticeCorpse, look a while', async () => {
    const actor = body([0, 0, 0]);
    const corpse = new Reaction('corpse', [500, 0, 0], 2, actor, settings, () => 0);
    expect(corpse.update(0.1)).toBe(true);
    await tick();
    expect(corpse.update(0.1)).toBe(true);
    expect(actor.log).toContain('say NoticeCorpse');
    expect(corpse.update(4)).toBe(true);
    expect(corpse.update(1.1)).toBe(false);
  });

  it('spectating: keep back from the fight, watch it until it has been over a while', async () => {
    const actor = body([50, 0, 0]);
    const watch = new Reaction('spectator', [0, 0, 0], 3, actor, settings, () => 0);
    expect(watch.update(0.1)).toBe(true);
    expect(actor.log.at(-1)).toBe('travel 200,0,0');
    await tick();
    expect(watch.update(0.1)).toBe(true);
    expect(actor.log.at(-1)).toBe('face');
    expect(watch.update(3, { over: true })).toBe(true);
    expect(watch.update(3, { over: true })).toBe(false);
  });

  it('warning: go to the one warned and face them until lifted', async () => {
    const actor = body([0, 0, 0]);
    const warn = new Reaction('warn', [600, 0, 0], 4, actor, settings, () => 0);
    expect(warn.update(0.1)).toBe(true);
    await tick();
    expect(warn.update(0.1)).toBe(true);
    expect(warn.update(0.1)).toBe(true);
    expect(actor.log).toContain('say Trespass');
    expect(warn.update(0.1, { over: true })).toBe(false);
  });
});
