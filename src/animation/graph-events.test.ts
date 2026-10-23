import { describe, expect, it } from 'vitest';
import { parseAnimationResponses } from '../formats/animdata/responses.ts';
import { GraphEventDispatch, graphEvent, isEvent, type GraphEventSource } from './graph-events.ts';

const ACTOR = parseAnimationResponses(
  ['swingEvent : SwingHandler', 'swingLeft : SwingHandler', 'sitDown : ChairHandler'].join('\n'),
);
const PLAYER = parseAnimationResponses(
  ['BackupResponse : ActorResponse', 'sitDown : PlayerChairHandler', 'look : LookHandler'].join(
    '\n',
  ),
);

const npc: GraphEventSource = { reference: 0x100, player: false };
const player: GraphEventSource = { reference: 0x14, player: true };

describe('graphEvent', () => {
  it('splits a dotted name without a payload of its own at its first dot', () => {
    expect(graphEvent('CameraShake.0.5')).toEqual({
      name: 'CameraShake',
      payload: '0.5',
      text: 'CameraShake.0.5',
    });
    expect(graphEvent('FootLeft')).toEqual({ name: 'FootLeft', text: 'FootLeft' });
    // A payload of its own keeps the name whole.
    expect(graphEvent('AnimObjLoad', 'AnimObjectTankard')).toEqual({
      name: 'AnimObjLoad',
      payload: 'AnimObjectTankard',
      text: 'AnimObjLoad',
    });
    expect(isEvent(graphEvent('SoundPlay.X'), 'soundplay')).toBe(true);
  });
});

describe('GraphEventDispatch', () => {
  it("answers each event by its handler class, the player's list first, in order", () => {
    const dispatch = new GraphEventDispatch<GraphEventSource>();
    dispatch.setResponses(ACTOR, PLAYER);
    const heard: string[] = [];
    dispatch.handle('swinghandler', (source, event) => {
      heard.push(`swing ${String(source.reference)} ${event.name}`);
    });
    dispatch.handle('ChairHandler', () => heard.push('chair'));
    dispatch.handle('PlayerChairHandler', () => heard.push('player chair'));
    dispatch.otherwise((_source, event) => heard.push(`own ${event.name}`));
    dispatch.listen((_source, events) => heard.push(`all ${String(events.length)}`));
    dispatch.dispatch(npc, [
      graphEvent('swingLeft'),
      graphEvent('blockStop'),
      graphEvent('sitDown'),
    ]);
    dispatch.dispatch(player, [graphEvent('sitDown'), graphEvent('swingEvent')]);
    expect(heard).toEqual([
      'all 3',
      'swing 256 swingLeft',
      'own blockStop',
      'chair',
      'all 2',
      'player chair',
      'swing 20 swingEvent',
    ]);
    // An actor's events do not reach the player's own handlers.
    expect(dispatch.handlerOf('look', false)).toBeUndefined();
    expect(dispatch.handlerOf('look', true)).toBe('LookHandler');
  });

  it('holds what comes before the response files are read, and names unanswered handlers', () => {
    const dispatch = new GraphEventDispatch<GraphEventSource>();
    const heard: string[] = [];
    dispatch.handle('SwingHandler', (_source, event) => heard.push(event.name));
    dispatch.dispatch(npc, [graphEvent('swingEvent'), graphEvent('sitDown')]);
    expect(heard).toEqual([]);
    dispatch.setResponses(ACTOR, PLAYER);
    expect(heard).toEqual(['swingEvent']);
    expect(dispatch.unanswered()).toEqual(['ChairHandler']);
    expect(dispatch.implements('swinghandler')).toBe(true);
  });
});
