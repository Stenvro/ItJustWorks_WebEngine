import { describe, expect, it } from 'vitest';
import {
  ConsoleCommands,
  handSlot,
  placementOffset,
  type ConsoleContext,
} from './console-commands.ts';
import { parseAxis, parseConsoleLine, parseConsoleNumber, parseFormId } from './console-parse.ts';
import { conditionLine } from './console-script-functions.ts';
import { CONSOLE_COMMANDS, consoleCommand } from './console-table.ts';
import { ObjectHandle } from '../scripting/values.ts';

/** Record types by form id, as the fake forms answer. */
const TYPES = new Map([
  [0xbabe4, 'PERK'],
  [0x12fcd, 'SPEL'],
  [0x1a2b, 'ACHR'],
  [0x1234, 'REFR'],
]);

const fakeContext = (extra: Record<string, unknown>, runtime: Record<string, unknown> = {}) => {
  // The runtime given is the one the commands change (the cases read it back); forms and state
  // it brings stay its own.
  runtime.forms ??= {
    record: (formId: number) =>
      Promise.resolve(TYPES.has(formId) ? { type: TYPES.get(formId) } : undefined),
  };
  runtime.state ??= { created: new Map(), actors: new Map() };
  return {
    db: { scan: () => Promise.resolve() },
    ...extra,
    runtime,
  } as unknown as ConsoleContext;
};

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
    const controls = { movement: false, menu: false, journalTabs: false, povLocks: [1] };
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
      povLocks: [],
    });
    expect(await commands.run('dpc')).toEqual([]);
    expect(controls.menu).toBe(false);
    // The camera's switch locked as well (Toggle POV does nothing while the controls are off).
    expect(controls.povLocks).toEqual([0]);
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

  it('takes the debug text commands and, as the original, does nothing with them', async () => {
    const commands = new ConsoleCommands(fakeContext({}));
    expect(await commands.run('tdt')).toEqual([]);
    expect(await commands.run('ToggleDebugText')).toEqual([]);
    expect(await commands.run('sdt VATS 1')).toEqual([]);
    expect(await commands.run('SaveDTP')).toEqual([]);
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
    // The game's table marks the source as needed, its "(Optional)" name notwithstanding.
    expect(await commands.run('player.cast 12fcd 1a2b')).toEqual([
      'Missing parameter Source (Optional).',
      'Compiled script not saved!',
    ]);
    expect(await commands.run('player.cast 12fcd 1a2b right')).toEqual([]);
    expect(await commands.run('player.cast 12fcd, player, voice')).toEqual([]);
    expect(calls).toEqual(['cast 12fcd 14 1a2b', 'cast 12fcd 14 14']);
  });
});

describe('the game command table', () => {
  it('holds every console command and script function of the game', () => {
    expect(CONSOLE_COMMANDS.filter((info) => info.console)).toHaveLength(342);
    expect(CONSOLE_COMMANDS.filter((info) => !info.console)).toHaveLength(737);
    // A script function's place among them is its condition function index.
    expect(consoleCommand('GetIsID')).toMatchObject({ condition: 72, reference: true });
    expect(consoleCommand('GetWantBlocking')?.condition).toBe(0);
    expect(consoleCommand('pc1st')?.name).toBe('IsPC1stPerson');
    expect(consoleCommand('GetIsID')?.params[0]).toMatchObject({ name: 'ObjectID', code: 21 });
  });

  it('accepts a command whose action returns at once and does nothing', async () => {
    const commands = new ConsoleCommands(fakeContext({}));
    expect(consoleCommand('tnm')?.returnsAtOnce).toBe(true);
    expect(await commands.run('ToggleNavMesh')).toEqual([]);
    expect(await commands.run('player.IsUndead')).toEqual([]);
  });

  it("prints a script function's condition value for the reference", async () => {
    const runtime = {
      inMenuMode: true,
      world: {},
      referenceHandle: (formId: number) => new ObjectHandle(formId, 'objectreference'),
      reference: (handle: ObjectHandle) => handle.formId,
    };
    const commands = new ConsoleCommands(fakeContext({}, runtime));
    expect(await commands.run('MenuMode')).toEqual(['MenuMode >> 1.00']);
    runtime.inMenuMode = false;
    expect(await commands.run('menumode 0')).toEqual(['MenuMode >> 0.00']);
    // A reference function needs a reference.
    expect(await commands.run('GetDisabled')).toEqual(['No Reference Selected']);
  });

  /** A runtime whose natives record their calls. */
  const nativeSetup = (result: unknown = null, extra: Record<string, unknown> = {}) => {
    const calls: string[] = [];
    const show = (value: unknown): string =>
      value instanceof ObjectHandle ? value.formId.toString(16) : String(value);
    const runtime = {
      referenceHandle: (formId: number) => new ObjectHandle(formId, 'objectreference'),
      formHandle: (formId: number) => new ObjectHandle(formId, 'form'),
      native:
        (script: string, fn: string) =>
        (call: { self: ObjectHandle | null; args: readonly unknown[] }) => {
          calls.push(`${script}.${fn} ${show(call.self)} ${call.args.map(show).join(' ')}`.trim());
          return result;
        },
      ...extra,
    };
    return { calls, commands: new ConsoleCommands(fakeContext({}, runtime)) };
  };

  it('does a script function through the native the scripts call', async () => {
    const { calls, commands } = nativeSetup();
    expect(await commands.run('player.StartCombat 1a2b')).toEqual([]);
    expect(await commands.run('player.SetGhost 1')).toEqual([]);
    expect(await commands.run('1a2b.DamageAV health 10')).toEqual([]);
    expect(calls).toEqual([
      'actor.startcombat 14 1a2b',
      'actor.setghost 14 true',
      'actor.damageactorvalue 1a2b health 10',
    ]);
  });

  it('prints the reference a script function gives back, and the math functions', async () => {
    const { commands } = nativeSetup(new ObjectHandle(0x1234, 'objectreference'));
    expect(await commands.run('player.GetCombatTarget')).toEqual(['GetCombatTarget >> (00001234)']);
    expect(await commands.run('1a2b.GetSelf')).toEqual(['GetSelf >> (00001a2b)']);
    expect(await commands.run('Sqrt 16')).toEqual(['Sqrt >> 4.00']);
    expect(await commands.run('Sin 30')).toEqual(['Sin >> 0.50']);
    expect(await commands.run('Sin 0.5 1')).toEqual(['Sin >> 30.00']);
  });

  it('prints a condition value in the words the game uses for it', () => {
    expect(conditionLine('IsWeaponMagicOut', 1)).toBe('Is Weapon/Magic Out >> 1.00');
    expect(conditionLine('GetDisabled', 1)).toBe('GetDisabled >> 1');
    expect(conditionLine('GetRelativeAngle', 12.5, 2)).toBe('GetRelAng: Z >> 12.50');
    expect(conditionLine('GetIsID', 0)).toBe('GetIsID >> 0.00');
  });

  it('reads and sets INI settings, saves and loads by name', async () => {
    const ini = new Map([['fJumpHeightMin:Movement', 76]]);
    const saved: string[] = [];
    const commands = new ConsoleCommands(
      fakeContext({
        iniSetting: (name: string) => ini.get(name),
        setIniSetting: (name: string, value: number) => {
          if (!ini.has(name)) return false;
          ini.set(name, value);
          return true;
        },
        saveGame: (name: string) => {
          saved.push(`save ${name}`);
          return Promise.resolve();
        },
        loadGame: (name: string) => {
          saved.push(`load ${name}`);
          return Promise.resolve(true);
        },
      }),
    );
    expect(await commands.run('GetINI fJumpHeightMin:Movement')).toEqual([
      'INISetting fJumpHeightMin:Movement >> 76.00',
    ]);
    expect(await commands.run('SetINI fJumpHeightMin:Movement 200')).toEqual([]);
    expect(ini.get('fJumpHeightMin:Movement')).toBe(200);
    expect(await commands.run('GetINI fNothing:General')).toEqual([
      'INISetting fNothing:General >> NOT FOUND',
    ]);
    expect(await commands.run('save Before')).toEqual([]);
    expect(await commands.run('load Before')).toEqual([]);
    expect(saved).toEqual(['save Before', 'load Before']);
  });

  it('names a quest alias as a reference once the scope quest is set', async () => {
    const quest = 0x3372b;
    TYPES.set(quest, 'QUST');
    const { calls, commands } = nativeSetup(null, {
      forms: {
        record: (formId: number) =>
          Promise.resolve(
            formId === quest
              ? { type: 'QUST', editorId: 'MQ101' }
              : TYPES.has(formId)
                ? { type: TYPES.get(formId) }
                : undefined,
          ),
        quest: () => Promise.resolve({ aliases: [{ id: 3, name: 'Hadvar', location: false }] }),
      },
      state: {
        created: new Map(),
        actors: new Map(),
        quests: new Map([[quest, { aliases: new Map([[3, 0x1a2b]]) }]]),
      },
    });
    expect(await commands.run('Hadvar.SetGhost 1')).toEqual([
      "Unknown referenced object 'Hadvar'.",
    ]);
    expect(await commands.run('ssq 3372b')).toEqual(['Console Scope Quest >> MQ101 (0003372B)']);
    expect(await commands.run('Hadvar.SetGhost 1')).toEqual([]);
    expect(calls).toEqual(['actor.setghost 1a2b true']);
    expect(await commands.run('ssq')).toEqual(['Console Scope Quest >> EMPTY']);
    TYPES.delete(quest);
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
    expect(consoleCommand('inv')?.name).toBe('ShowInventory');
    expect(consoleCommand('sifh')?.name).toBe('SetIgnoreFriendlyHits');
  });
});

describe('ConsoleCommands, the rest', () => {
  it('switches the renderer and holds the world still under tfc 1', async () => {
    const shown = { lod: true, trees: true, water: true };
    let frozen = false;
    let free = false;
    const commands = new ConsoleCommands(
      fakeContext({
        toggleRenderer: (what: keyof typeof shown) => (shown[what] = !shown[what]),
        toggleFreeCamera: () => (free = !free),
        freezeWorld: (to: boolean) => (frozen = to),
      }),
    );
    expect(await commands.run('tll')).toEqual(['LOD Land -> Off']);
    expect(await commands.run('tt')).toEqual(['Trees -> Off']);
    expect(await commands.run('tws')).toEqual(['Water -> Off']);
    expect(await commands.run('tfc 1')).toEqual(['Fly Camera Is On']);
    expect(frozen).toBe(true);
    expect(await commands.run('tfc')).toEqual(['Fly Camera Is Off']);
    expect(frozen).toBe(false);
  });

  it('sets the player’s level and a base’s essential flag, and lists an inventory', async () => {
    const context = fakeContext({});
    const actors = new Map<number, { level?: number }>();
    const bases = new Map<number, { essential?: boolean }>();
    const state = {
      created: new Map(),
      actors,
      playerExperience: 120,
      actor: (id: number) => actors.get(id) ?? actors.set(id, {}).get(id),
      actorBase: (id: number) => bases.get(id) ?? bases.set(id, {}).get(id),
    };
    Object.assign(context.runtime, {
      state,
      inventory: () =>
        Promise.resolve(
          new Map([
            [0xf, 250],
            [0x1, 0],
          ]),
        ),
    });
    const commands = new ConsoleCommands(context);
    expect(await commands.run('player.setlevel 30')).toEqual([]);
    expect(actors.get(0x14)?.level).toBe(30);
    expect(state.playerExperience).toBe(0);
    expect(await commands.run('player.showinventory')).toEqual(['250 -  (0000000F)']);
  });

  it('reads a hand and PlaceAtMe’s direction', () => {
    expect(handSlot('Left')).toBe(2);
    expect(handSlot('right')).toBe(1);
    expect(handSlot('both')).toBeUndefined();
    const [x, y] = placementOffset(90, 100, 0);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(0);
    const [bx, by] = placementOffset(0, 100, 1);
    expect(bx).toBeCloseTo(0);
    expect(by).toBeCloseTo(-100);
    expect(placementOffset(0, 100, 2)[0]).toBeCloseTo(-100);
  });
});
