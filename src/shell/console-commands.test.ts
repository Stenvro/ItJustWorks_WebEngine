import { describe, expect, it } from 'vitest';
import { ConsoleCommands, parseConsoleLine, type ConsoleContext } from './console-commands.ts';

describe('ConsoleCommands', () => {
  it('opens the race menu with showracemenu', async () => {
    let opened = 0;
    const commands = new ConsoleCommands({
      showRaceMenu: () => {
        opened++;
      },
    } as unknown as ConsoleContext);
    expect(await commands.run('ShowRaceMenu')).toEqual([]);
    expect(opened).toBe(1);
  });
});

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
