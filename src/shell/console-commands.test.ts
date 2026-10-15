import { describe, expect, it } from 'vitest';
import { parseConsoleLine } from './console-commands.ts';

describe('parseConsoleLine', () => {
  it('splits a command and its arguments, quotes keeping spaces', () => {
    expect(parseConsoleLine('help "iron sword" 4')).toEqual({
      reference: undefined,
      command: 'help',
      args: ['iron sword', '4'],
    });
  });

  it('takes the reference before a dot, the command in lower case', () => {
    expect(parseConsoleLine('player.AddItem f 100')).toEqual({
      reference: 'player',
      command: 'additem',
      args: ['f', '100'],
    });
  });
});
