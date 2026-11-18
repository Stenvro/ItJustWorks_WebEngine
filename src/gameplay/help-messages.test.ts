import { describe, expect, it } from 'vitest';
import { decodeValue, encodeValue } from '../save/save-codec.ts';
import { HelpMessages, type WaitingHelp } from './help-messages.ts';

const jump = { text: 'Press Jump', event: 'Jump', seconds: 3, interval: 10, times: 2 };

function messages(): {
  help: HelpMessages;
  waiting: Map<string, WaitingHelp>;
  done: Set<string>;
} {
  const waiting = new Map<string, WaitingHelp>();
  const done = new Set<string>();
  return { help: new HelpMessages(waiting, done), waiting, done };
}

describe('help messages (ShowAsHelpMessage)', () => {
  it('show for their seconds, again after their interval, their times', () => {
    const { help, waiting } = messages();
    expect(help.start(jump).started?.showing).toBe(true);
    expect(help.advance(2.9).hide).toEqual([]);
    expect(help.advance(0.2).hide.map((h) => h.event)).toEqual(['Jump']);
    // Its interval counts from when it last showed.
    expect(help.advance(6.8).show).toEqual([]);
    expect(help.advance(0.2).show.map((h) => h.event)).toEqual(['Jump']);
    // The second of two times: it goes for good once its seconds are up.
    expect(help.advance(3).hide.map((h) => h.event)).toEqual(['Jump']);
    expect(waiting.size).toBe(0);
  });

  it('show one at a time; one for ever stays until its event, which is then done', () => {
    const { help, done } = messages();
    help.start({ ...jump, seconds: 0, interval: 1, times: 0 });
    const sprint = help.start({
      text: 'Hold Sprint',
      event: 'Sprint',
      seconds: 2,
      interval: 1,
      times: 0,
    });
    // The new one takes the place of the one showing.
    expect(sprint.hide.map((h) => h.event)).toEqual(['Jump']);
    expect(help.advance(2).hide.map((h) => h.event)).toEqual(['Sprint']);
    // With none showing, the first past its interval shows; it shows on for ever.
    expect(help.showing()?.event).toBe('Jump');
    expect(help.advance(1000).hide).toEqual([]);
    expect(help.done('jump')?.event).toBe('Jump');
    expect(done.has('jump')).toBe(true);
    expect(help.start(jump)).toEqual({ hide: [] });
    help.reset('JUMP');
    expect(help.start(jump).started?.event).toBe('Jump');
  });

  it('go on after a save from where they were', () => {
    const { help, waiting } = messages();
    help.start(jump);
    help.advance(3.5);
    // Saved 3.5 seconds after it showed, loaded: it shows again 6.5 seconds on.
    const loaded = decodeValue(JSON.parse(JSON.stringify(encodeValue(waiting)))) as Map<
      string,
      WaitingHelp
    >;
    const again = new HelpMessages(loaded, new Set());
    expect(again.showing()).toBeUndefined();
    expect(again.advance(6.4).show).toEqual([]);
    expect(again.advance(0.2).show.map((h) => [h.event, h.timesLeft])).toEqual([['Jump', 0]]);
  });
});
