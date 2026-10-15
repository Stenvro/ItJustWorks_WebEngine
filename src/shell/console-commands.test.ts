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

  it('gives the player every control back with epc, takes them with dpc', async () => {
    const controls = {
      movement: false,
      fighting: false,
      camSwitch: false,
      looking: false,
      sneaking: false,
      menu: false,
      activate: false,
      journalTabs: false,
      disablePov: 1,
    };
    let changed = 0;
    const commands = new ConsoleCommands({
      runtime: { controls },
      controlsChanged: () => {
        changed++;
      },
    } as unknown as ConsoleContext);
    expect(await commands.run('EnablePlayerControls')).toEqual([]);
    expect(controls).toMatchObject({
      movement: true,
      menu: true,
      journalTabs: true,
      disablePov: 0,
    });
    expect(await commands.run('dpc')).toEqual([]);
    expect(controls.menu).toBe(false);
    expect(changed).toBe(2);
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
