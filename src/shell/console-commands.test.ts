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

describe('ConsoleCommands perks and spells', () => {
  const types = new Map([
    [0xbabe4, 'PERK'],
    [0x12fcd, 'SPEL'],
  ]);
  const setup = () => {
    const calls: string[] = [];
    const commands = new ConsoleCommands({
      runtime: {
        forms: {
          record: (formId: number) =>
            Promise.resolve(types.has(formId) ? { type: types.get(formId) } : undefined),
        },
        perks: {
          add: (actor: number, perk: number) => {
            calls.push(`add perk ${actor.toString(16)} ${perk.toString(16)}`);
            return Promise.resolve();
          },
          remove: (actor: number, perk: number) => {
            calls.push(`remove perk ${actor.toString(16)} ${perk.toString(16)}`);
            return Promise.resolve();
          },
        },
        actors: {
          addSpell: (actor: number, spell: number) => {
            calls.push(`add spell ${actor.toString(16)} ${spell.toString(16)}`);
            return Promise.resolve(true);
          },
          removeSpell: (actor: number, spell: number) => {
            calls.push(`remove spell ${actor.toString(16)} ${spell.toString(16)}`);
            return Promise.resolve(true);
          },
        },
        magic: {
          syncLasting: () => Promise.resolve(),
          cast: (spell: number, source: number, target: number) => {
            calls.push(`cast ${spell.toString(16)} ${source.toString(16)} ${target.toString(16)}`);
            return Promise.resolve(true);
          },
        },
        spellMessage: () => Promise.resolve(),
        detach: () => undefined,
      },
    } as unknown as ConsoleContext);
    return { commands, calls };
  };

  it('adds and removes perks as Actor.AddPerk does, by form id', async () => {
    const { commands, calls } = setup();
    expect(await commands.run('player.addperk babe4')).toEqual([]);
    expect(await commands.run('1a2b.RemovePerk babe4')).toEqual([]);
    // A spell is no perk.
    expect(await commands.run('player.addperk 12fcd')).toEqual([
      "Item '12fcd' not found for parameter Perk.",
    ]);
    expect(calls).toEqual(['add perk 14 babe4', 'remove perk 1a2b babe4']);
  });

  it('adds and removes spells as Actor.AddSpell does', async () => {
    const { commands, calls } = setup();
    expect(await commands.run('player.addspell 12fcd')).toEqual([]);
    expect(await commands.run('player.removespell 12fcd')).toEqual([]);
    expect(await commands.run('player.addspell babe4')).toEqual([
      "Item 'babe4' not found for parameter Spell.",
    ]);
    expect(calls).toEqual(['add spell 14 12fcd', 'remove spell 14 12fcd']);
  });

  it('casts a spell from a reference at a target as Spell.Cast does, at itself by default', async () => {
    const { commands, calls } = setup();
    expect(await commands.run('player.cast 12fcd 1a2b')).toEqual([]);
    expect(await commands.run('player.cast 12fcd')).toEqual([]);
    expect(await commands.run('player.cast babe4 player')).toEqual([
      "Item 'babe4' not found for parameter Spell.",
    ]);
    expect(calls).toEqual(['cast 12fcd 14 1a2b', 'cast 12fcd 14 14']);
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
