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

  it('toggles god mode with tgm', async () => {
    const runtime = { godMode: false };
    const commands = new ConsoleCommands({ runtime } as unknown as ConsoleContext);
    expect(await commands.run('tgm')).toEqual(['God Mode -- ON']);
    expect(runtime.godMode).toBe(true);
    expect(await commands.run('ToggleGodMode')).toEqual(['God Mode -- OFF']);
    expect(runtime.godMode).toBe(false);
  });

  it('kills an actor as Actor.Kill does with kill, the player by default', async () => {
    const killed: [number, number | undefined][] = [];
    const commands = new ConsoleCommands({
      runtime: {
        actors: {
          isActor: (reference: number) => Promise.resolve(reference !== 0x1234),
          scriptKill: (reference: number, killer: number | undefined) => {
            killed.push([reference, killer]);
            return Promise.resolve();
          },
        },
      },
    } as unknown as ConsoleContext);
    expect(await commands.run('player.kill')).toEqual([]);
    expect(await commands.run('kill 1a2b')).toEqual([]);
    expect(await commands.run('1a2b.kill player')).toEqual([]);
    // Not an actor: nothing.
    expect(await commands.run('1234.kill')).toEqual([]);
    expect(killed).toEqual([
      [0x14, undefined],
      [0x14, 0x1a2b],
      [0x1a2b, 0x14],
    ]);
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
