import { describe, expect, it } from 'vitest';
import { ConsoleCommands, type ConsoleContext } from './console-commands.ts';
import { parseAxis, parseConsoleLine, parseConsoleNumber, parseFormId } from './console-parse.ts';
import { consoleCommand } from './console-table.ts';

/** Record types by form id, as the fake forms answer. */
const TYPES = new Map([
  [0xbabe4, 'PERK'],
  [0x12fcd, 'SPEL'],
  [0x1a2b, 'ACHR'],
  [0x1234, 'REFR'],
]);

const fakeContext = (extra: Record<string, unknown>, runtime: Record<string, unknown> = {}) =>
  ({
    db: { scan: () => Promise.resolve() },
    ...extra,
    // The runtime given is the one the commands change (the cases read it back).
    runtime: Object.assign(runtime, {
      forms: {
        record: (formId: number) =>
          Promise.resolve(TYPES.has(formId) ? { type: TYPES.get(formId) } : undefined),
      },
      state: { created: new Map(), actors: new Map() },
    }),
  }) as unknown as ConsoleContext;

describe('ConsoleCommands', () => {
  it('opens the race menu with showracemenu', async () => {
    let opened = 0;
    const commands = new ConsoleCommands(
      fakeContext({
        showRaceMenu: () => {
          opened++;
        },
      }),
    );
    expect(await commands.run('ShowRaceMenu')).toEqual([]);
    expect(opened).toBe(1);
  });

  it('gives the player every control back with epc, takes them with dpc', async () => {
    const controls = { movement: false, menu: false, journalTabs: false, disablePov: 1 };
    let changed = 0;
    const commands = new ConsoleCommands(
      fakeContext(
        {
          controlsChanged: () => {
            changed++;
          },
        },
        { controls },
      ),
    );
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

  it('toggles god mode and immortal mode as the game words it', async () => {
    const runtime = { godMode: false, debug: { immortal: false } };
    const commands = new ConsoleCommands(fakeContext({}, runtime));
    expect(await commands.run('tgm')).toEqual(['God Mode enabled.']);
    expect(runtime.godMode).toBe(true);
    expect(await commands.run('ToggleGodMode')).toEqual(['God Mode disabled.']);
    expect(await commands.run('tim')).toEqual(['Immortal Mode enabled.']);
    expect(runtime.debug.immortal).toBe(true);
  });

  it('toggles all AI, combat AI and detection with their messages', async () => {
    const runtime = { debug: { ai: true, combatAi: true, detection: true } };
    const commands = new ConsoleCommands(fakeContext({}, runtime));
    expect(await commands.run('tai')).toEqual(['All AI Processing is  Off']);
    expect(await commands.run('tcai')).toEqual(['All Combat AI processing is Off']);
    expect(await commands.run('tdetect')).toEqual(['AI Detection is  Off']);
    expect(runtime.debug).toEqual({ ai: false, combatAi: false, detection: false });
  });

  it('toggles collision, the free camera and the menus through the world', async () => {
    let collision = true;
    let free = false;
    let menus = true;
    const commands = new ConsoleCommands(
      fakeContext({
        toggleCollision: () => (collision = !collision),
        toggleFreeCamera: () => (free = !free),
        toggleMenus: () => (menus = !menus),
      }),
    );
    expect(await commands.run('tcl')).toEqual(['Collision -> Off']);
    expect(await commands.run('tfc')).toEqual(['Fly Camera Is On']);
    expect(await commands.run('tm')).toEqual(['Menus -> Off']);
  });

  it('kills the reference before the dot, or the one selected, as Actor.Kill does', async () => {
    const killed: [number, number | undefined][] = [];
    const commands = new ConsoleCommands(
      fakeContext(
        {},
        {
          referenceHandle: (formId: number) => ({ formId }),
          actors: {
            isActor: (reference: number) => Promise.resolve(reference !== 0x1234),
            scriptKill: (reference: number, killer: number | undefined) => {
              killed.push([reference, killer]);
              return Promise.resolve();
            },
            playerName: () => 'Prisoner',
          },
          baseOf: () => Promise.resolve(undefined),
        },
      ),
    );
    expect(await commands.run('player.kill')).toEqual([]);
    // Nothing selected: a reference function has nothing to act on.
    expect(await commands.run('kill')).toEqual(['No Reference Selected']);
    expect(await commands.run('1a2b.kill player')).toEqual([]);
    // Not an actor: nothing.
    expect(await commands.run('1234.kill')).toEqual([]);
    expect(killed).toEqual([
      [0x14, undefined],
      [0x1a2b, 0x14],
    ]);
  });

  it('reports what it cannot read as the script compiler does', async () => {
    const commands = new ConsoleCommands(fakeContext({}));
    expect(await commands.run('player.additem f')).toEqual([
      "Item 'f' not found for parameter ObjectID.",
      'Compiled script not saved!',
    ]);
    expect(await commands.run('player.addperk')).toEqual([
      'Missing parameter Perk.',
      'Compiled script not saved!',
    ]);
    expect(await commands.run('tpm')).toEqual(['Script command "tpm" not found.']);
    expect(await commands.run('help')).toHaveLength(3);
  });
});

describe('ConsoleCommands perks and spells', () => {
  const setup = () => {
    const calls: string[] = [];
    const commands = new ConsoleCommands(
      fakeContext(
        {},
        {
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
              calls.push(
                `cast ${spell.toString(16)} ${source.toString(16)} ${target.toString(16)}`,
              );
              return Promise.resolve(true);
            },
          },
          spellMessage: () => Promise.resolve(),
          detach: () => undefined,
        },
      ),
    );
    return { commands, calls };
  };

  it('adds and removes perks as Actor.AddPerk does, by form id', async () => {
    const { commands, calls } = setup();
    expect(await commands.run('player.addperk babe4')).toEqual([]);
    expect(await commands.run('1a2b.RemovePerk babe4')).toEqual([]);
    // A spell is no perk.
    expect(await commands.run('player.addperk 12fcd')).toEqual([
      "Item '12fcd' not found for parameter Perk.",
      'Compiled script not saved!',
    ]);
    expect(calls).toEqual(['add perk 14 babe4', 'remove perk 1a2b babe4']);
  });

  it('adds and removes spells as Actor.AddSpell does', async () => {
    const { commands, calls } = setup();
    expect(await commands.run('player.addspell 12fcd')).toEqual([]);
    expect(await commands.run('player.removespell 0x12FCD')).toEqual([]);
    expect(calls).toEqual(['add spell 14 12fcd', 'remove spell 14 12fcd']);
  });

  it('casts a spell from a reference at a target as Spell.Cast does', async () => {
    const { commands, calls } = setup();
    expect(await commands.run('player.cast 12fcd 1a2b')).toEqual([]);
    expect(await commands.run('player.cast 12fcd, player')).toEqual([]);
    expect(calls).toEqual(['cast 12fcd 14 1a2b', 'cast 12fcd 14 14']);
  });
});

describe('parseConsoleLine', () => {
  it('splits a command and its arguments, quotes keeping spaces and commas', () => {
    expect(parseConsoleLine('help "iron sword, fine" 4')).toMatchObject({
      reference: undefined,
      command: 'help',
      args: ['iron sword, fine', '4'],
    });
  });

  it('takes the reference before a dot, the command in lower case, commas as spaces', () => {
    expect(parseConsoleLine('player.SetAV luck, 75')).toMatchObject({
      reference: 'player',
      command: 'setav',
      typed: 'SetAV',
      args: ['luck', '75'],
    });
    expect(parseConsoleLine('0001A694.moveto player').reference).toBe('0001A694');
    expect(parseConsoleLine('BalgruufRef.disable').reference).toBe('BalgruufRef');
  });

  it('reports mismatched quotes', () => {
    expect(parseConsoleLine('coc "Riverwood').error).toBe('Syntax Error.  Mismatched quotes.');
  });

  it('reads form ids in hex with their load order prefix', () => {
    expect(parseFormId('f')).toBe(0xf);
    expect(parseFormId('00012EB7')).toBe(0x12eb7);
    expect(parseFormId('0200C0D9')).toBe(0x0200c0d9);
    expect(parseFormId('FE00180A')).toBe(0xfe00180a);
    expect(parseFormId('0x14')).toBe(0x14);
    expect(parseFormId('IronSword')).toBeUndefined();
    expect(parseFormId('123456789')).toBeUndefined();
  });

  it('reads numbers in decimal and axes', () => {
    expect(parseConsoleNumber('100')).toBe(100);
    expect(parseConsoleNumber('-2.5')).toBe(-2.5);
    expect(parseConsoleNumber('.5')).toBe(0.5);
    expect(parseConsoleNumber('f')).toBeUndefined();
    expect(parseAxis('Z')).toBe(2);
    expect(parseAxis('w')).toBeUndefined();
  });

  it('finds commands by their name and short name', () => {
    expect(consoleCommand('TGM')?.name).toBe('ToggleGodMode');
    expect(consoleCommand('movetoqt')?.name).toBe('MoveToQuestTarget');
    expect(consoleCommand('MoveTo')?.name).toBe('MoveToMarker');
    expect(consoleCommand('etp')).toBeUndefined();
  });
});
