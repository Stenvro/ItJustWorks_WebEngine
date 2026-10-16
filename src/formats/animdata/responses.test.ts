import { describe, expect, it } from 'vitest';
import { animationResponse, parseAnimationResponses } from './responses.ts';

const ACTOR = ['swingEvent : SwingHandler', 'sitDown : ChairHandler', 'broken line', ''].join(
  '\r\n',
);
const PLAYER = ['BackupResponse : ActorResponse', 'sitDown : PlayerChairHandler'].join('\r\n');

describe('parseAnimationResponses', () => {
  const actor = parseAnimationResponses(ACTOR);
  const player = parseAnimationResponses(PLAYER);

  it('maps events to handlers and skips lines without one', () => {
    expect([...actor.handlers]).toEqual([
      ['swingevent', 'SwingHandler'],
      ['sitdown', 'ChairHandler'],
    ]);
    expect(actor.backup).toBeUndefined();
    expect(player.backup).toBe('ActorResponse');
  });

  it('answers from the list, else from its backup, in any case', () => {
    expect(animationResponse('SITDOWN', player, actor)).toBe('PlayerChairHandler');
    expect(animationResponse('swingEvent', player, actor)).toBe('SwingHandler');
    expect(animationResponse('swingEvent', player)).toBeUndefined();
    expect(animationResponse('unknown', player, actor)).toBeUndefined();
  });
});
