// The console's commands as the game registers them (observed in the original: the table is
// src/shell/console-functions.ts): a name, a short name, whether it is a reference function (it
// acts on the reference before the dot, or the one selected), its parameters, each with the name
// the game's messages use ("Item 'x' not found for parameter ObjectID.") and its type, and
// whether its action returns at once or it has a condition function. The game has 342 console
// commands and 737 script functions the console runs; src/shell/console-commands.ts runs them.
// The help texts are the engine's own words. Platform-independent.

import { ITEM_TYPES } from '../world/item-records.ts';
import { FUNCTION_TABLE } from './console-functions.ts';

/** What a parameter takes. */
export type ConsoleParamType =
  | { readonly kind: 'string' }
  | { readonly kind: 'int' }
  | { readonly kind: 'float' }
  | { readonly kind: 'axis' }
  | { readonly kind: 'actorValue' }
  | { readonly kind: 'sex' }
  /** A casting source: Left, Right, Voice or Instant (0..3). */
  | { readonly kind: 'castingSource' }
  /** A placed reference: by editor id, form id, or "player". */
  | { readonly kind: 'reference' }
  /** A base form of these record types (any type when empty): by editor id or form id. */
  | { readonly kind: 'form'; readonly types: readonly string[] };

export interface ConsoleParam {
  readonly name: string;
  readonly type: ConsoleParamType;
  readonly optional?: boolean;
  /** The game's script parameter type. */
  readonly code: number;
}

export interface ConsoleCommandInfo {
  readonly name: string;
  readonly short?: string;
  /** A reference function: it acts on a reference (the one before the dot, or selected). */
  readonly reference: boolean;
  readonly params: readonly ConsoleParam[];
  /** The engine's words for it ('' where it has none). */
  readonly help: string;
  /** A console command (help lists it apart from the script functions). */
  readonly console: boolean;
  /** Its action returns at once: accepted, it does nothing (observed in the original). */
  readonly returnsAtOnce: boolean;
  /** It has no action the console can run (a condition function only). */
  readonly noAction: boolean;
  /** Its condition function's index (CTDA), for a script function that has one. */
  readonly condition?: number;
}

/** Record types of what a container holds (an item, a form list or leveled list of them). */
export const INVENTORY_TYPES = [...ITEM_TYPES, 'FLST', 'LVLI'] as const;
/** Record types PlaceAtMe places. */
export const PLACEABLE_TYPES = [
  ...ITEM_TYPES,
  'NPC_',
  'LVLN',
  'LVLI',
  'ACTI',
  'TACT',
  'STAT',
  'MSTT',
  'FURN',
  'DOOR',
  'CONT',
  'TREE',
  'FLOR',
  'IDLM',
  'EXPL',
  'HAZD',
  'ARTO',
] as const;
const MAGIC_TYPES = ['SPEL', 'SCRL', 'ENCH', 'ALCH', 'INGR'] as const;

const string = { kind: 'string' } as const;
const int = { kind: 'int' } as const;
const reference = { kind: 'reference' } as const;
const form = (...types: string[]): ConsoleParamType => ({ kind: 'form', types });
const anyForm = form();

/**
 * The game's script parameter types (its numbering) as the console reads them: the record types
 * each takes are xEdit's for the condition parameter of the same type (wbConditionFunctions, the
 * two numberings matched function by function); the rest by the parameter's own name.
 */
const PARAM_TYPES: Readonly<Record<number, ConsoleParamType>> = {
  0: string,
  1: int,
  2: { kind: 'float' },
  3: form(...INVENTORY_TYPES),
  4: reference,
  5: { kind: 'actorValue' },
  6: reference,
  7: form(...MAGIC_TYPES),
  8: { kind: 'axis' },
  9: form('CELL'),
  10: string,
  11: form(...MAGIC_TYPES),
  12: form('SNDR', 'SOUN'),
  13: form('DIAL'),
  14: form('QUST'),
  15: form('RACE'),
  16: form('CLAS'),
  17: form('FACT'),
  18: { kind: 'sex' },
  19: form('GLOB'),
  20: form('FURN', 'FLST'),
  21: anyForm,
  22: string,
  23: int,
  24: reference,
  25: form('NPC_'),
  26: reference,
  27: form('WRLD', 'FLST'),
  28: int,
  29: form('PACK'),
  30: form('CSTY'),
  31: form('MGEF'),
  32: int,
  33: form('WTHR'),
  35: form('NPC_', 'FACT'),
  36: form('EFSH'),
  37: form('FLST'),
  39: form('PERK'),
  40: int,
  41: string,
  42: form('IMAD'),
  43: form('IMGS'),
  46: int,
  47: int,
  48: int,
  49: form('VTYP', 'FLST'),
  50: form('ECZN'),
  51: form('IDLE'),
  52: form('MESG'),
  53: form(...INVENTORY_TYPES),
  54: int,
  55: form('EQUP'),
  56: anyForm,
  57: form('MUSC'),
  58: int,
  59: form('KYWD'),
  60: form('LCRT'),
  61: form('LCTN'),
  62: anyForm,
  63: int,
  64: form('SHOU'),
  65: form('WOOP'),
  67: form('SCEN'),
  68: { kind: 'castingSource' },
  69: form('ASTP'),
  70: int,
  71: int,
  72: int,
  73: int,
  74: int,
  76: string,
  77: form('RFCT'),
  78: int,
  79: form('SNCT'),
  80: int,
  81: form('ENCH', 'MGEF', 'WOOP'),
  82: form('REGN'),
  83: form('AACT'),
};

/** The engine's own help texts. */
const HELP: Readonly<Record<string, string>> = {
  ToggleAI: 'Turn an actor’s AI, or all AI, off and on.',
  ToggleSky: 'Turn the sky off and on.',
  ToggleCollision: 'Turn the player’s collision off and on (fly through the world).',
  ToggleMenus: 'Hide and show the menus and HUD.',
  ToggleDebugText: 'Show the debug text pages on the screen.',
  SetDebugText: 'Choose the debug text page shown.',
  SaveDebugTextPages: 'Save the debug text pages to the INI file.',
  Help: 'List the commands, settings, globals and forms that match a word.',
  PickRefByID: 'Select a reference for the console.',
  ToggleLODLand: 'Turn the distant land, objects, trees and water off and on.',
  CenterOnCell: 'Go to a cell by its editor id.',
  SetGameSetting: 'Set a game setting.',
  CenterOnExterior: 'Go to an exterior cell of this worldspace by its grid.',
  ToggleDetection: 'Turn the actors’ detection off and on.',
  ToggleTrees: 'Turn the trees off and on.',
  SetCameraFOV: 'Set the field of view (degrees; the world’s, then first person’s).',
  ToggleGodMode: 'Turn god mode on and off.',
  CenterOnWorld: 'Go to a cell of a worldspace by its grid.',
  ToggleGrass: 'Turn the grass off and on.',
  PlayerSpellBook: 'Give the player every spell, shout and word of power.',
  MoveToQuestTarget: 'Take the player to a target of a quest.',
  ToggleWaterSystem: 'Turn the water off and on.',
  ToggleCombatAI: 'Turn all combat AI off and on.',
  ToggleFlyCam: 'Turn the free camera on and off (1: the world stands still).',
  ToggleFogOfWar: 'Turn the local map’s fog of war off and on.',
  QuitGame: 'Quit the game.',
  ToggleImmortalMode: 'Turn immortal mode on and off (damage, but no death).',
  ClearConsole: 'Clear the console.',
  GetDistance: 'The distance to a reference.',
  AddItem: 'Add items to a container.',
  SetEssential: 'Make an actor essential (1) or not (0).',
  GetLocked: 'Whether it is locked.',
  ShowInventory: 'List what it holds.',
  DuplicateAllItems: 'Put a copy of everything it holds in another container.',
  SetIgnoreFriendlyHits: 'Make the actor ignore (1) or not ignore (0) friendly hits.',
  SetCrimeGold: 'Set the bounty with a crime faction (where the player is, without one).',
  PayCrimeGold: 'Pay the bounty with a crime faction (where the player is, without one).',
  AddToFaction: 'Add the actor to a faction.',
  RemoveFromFaction: 'Take the actor out of a faction.',
  SetFactionRank: 'Set the actor’s rank in a faction (-1: out of it).',
  GetFactionRank: 'The actor’s faction rank.',
  SetRelationshipRank: 'Set the relationship rank with another actor (-4 archnemesis .. 4 lover).',
  GetRelationshipRank: 'The relationship rank with another actor.',
  GetPos: 'Its position on an axis.',
  SetPos: 'Set its position on an axis.',
  GetAngle: 'Its angle about an axis (degrees).',
  SetAngle: 'Set its angle about an axis (degrees).',
  Activate: 'Activate it (by the player, or by a reference).',
  GetActorValue: 'An actor value.',
  SetActorValue: 'Set an actor value’s base.',
  ModActorValue: 'Change an actor value by an amount.',
  ForceActorValue: 'Make an actor value’s current value an amount.',
  RestoreActorValue: 'Restore a damaged actor value.',
  AddSpell: 'Teach an actor a spell.',
  RemoveSpell: 'Take a spell from an actor.',
  Cast: 'Cast a spell at a reference.',
  Enable: 'Enable it.',
  Disable: 'Disable it.',
  PlaceAtMe: 'Place new references of a base object at it.',
  GetDead: 'Whether the actor is dead.',
  GetItemCount: 'How many of an item it holds.',
  StartQuest: 'Start a quest.',
  StopQuest: 'Stop a quest.',
  GetQuestRunning: 'Whether a quest runs.',
  SetStage: 'Set a quest’s stage.',
  GetStage: 'A quest’s current stage.',
  GetLevel: 'The actor’s level.',
  RemoveItem: 'Remove items from a container.',
  EnablePlayerControls: 'Give the player their controls back.',
  DisablePlayerControls: 'Take the player’s controls.',
  CompleteQuest: 'Complete a quest.',
  Lock: 'Lock it (at a lock level).',
  UnLock: 'Unlock it.',
  KillActor: 'Kill the actor (by a killer).',
  ResurrectActor: 'Bring a dead actor back to life.',
  MoveToMarker: 'Move it to a reference (offset by x, y, z).',
  AdvancePCSkill: 'Give the player skill usage.',
  AdvancePCLevel: 'Give the player the experience to their next level.',
  ShowRaceMenu: 'Open the race menu; with a race, make it the player’s.',
  RemoveAllItems: 'Remove all items (into a container).',
  EquipItem: 'Make the actor equip an item.',
  UnequipItem: 'Make the actor unequip an item.',
  SetWeather: 'Make a weather active, with a change.',
  GetGameSetting: 'A game setting’s value.',
  ShowQuestObjectives: 'List the quests’ objectives (or a quest’s).',
  ForceWeather: 'Make a weather active at once.',
  IncrementPCSkill: 'Raise a skill of the player by one.',
  SetOwnership: 'Give it an owner (the player without one).',
  SetLevel: 'Set the actor’s level.',
  SetScale: 'Set its scale.',
  KillAllActors: 'Kill every actor around the player.',
  ReleaseWeatherOverride: 'Let the regions choose the weather again.',
  AddPerk: 'Give an actor a perk.',
  RemovePerk: 'Take a perk from an actor.',
  SetObjectiveCompleted: 'Set an objective completed (1) or not (0).',
  SetObjectiveDisplayed: 'Show an objective (1) or hide it (0).',
  CompleteAllObjectives: 'Complete all of a quest’s objectives.',
  MarkForDelete: 'Delete it.',
  OpenActorContainer: 'Open the actor’s inventory as a container.',
  ResetQuest: 'Reset a quest to its start.',
  SexChange: 'Change the player’s sex.',
  ShowAllMapMarkers: 'Show (1) or hide (0) the map markers (1 travel; 1 the hidden ones too).',
  ShowQuestStages: 'List a quest’s stages.',
  UnlockWord: 'Unlock a word of power.',
  TeachWord: 'Teach the player a word of power.',
  AddShout: 'Give an actor a shout.',
  RemoveShout: 'Take a shout from an actor.',
};

function readTable(): ConsoleCommandInfo[] {
  const commands: ConsoleCommandInfo[] = [];
  let condition = 0;
  for (const line of FUNCTION_TABLE.trim().split('\n')) {
    const [name = '', short = '', flags = '', params = ''] = line.split('|');
    const isConsole = flags.includes('c');
    const hasCondition = flags.includes('k');
    commands.push({
      name,
      ...(short !== '' && { short }),
      reference: flags.includes('r'),
      params:
        params === ''
          ? []
          : params.split(',').map((param): ConsoleParam => {
              const colon = param.indexOf(':');
              const head = param.slice(0, colon);
              const optional = head.endsWith('?');
              const code = Number(optional ? head.slice(0, -1) : head);
              return {
                name: param.slice(colon + 1),
                type: PARAM_TYPES[code] ?? anyForm,
                code,
                ...(optional && { optional }),
              };
            }),
      help: HELP[name] ?? '',
      console: isConsole,
      returnsAtOnce: flags.includes('0'),
      noAction: flags.includes('x'),
      ...(!isConsole && hasCondition && { condition }),
    });
    if (!isConsole) condition++;
  }
  return commands;
}

export const CONSOLE_COMMANDS: readonly ConsoleCommandInfo[] = readTable();

/** The commands by lower-case name and short name (the first of a name wins, as in the game). */
const BY_NAME = new Map<string, ConsoleCommandInfo>();
for (const info of CONSOLE_COMMANDS) {
  const name = info.name.toLowerCase();
  if (!BY_NAME.has(name)) BY_NAME.set(name, info);
  const short = info.short?.toLowerCase();
  if (short !== undefined && !BY_NAME.has(short)) BY_NAME.set(short, info);
}

/** A command by its name or short name (any case). */
export function consoleCommand(name: string): ConsoleCommandInfo | undefined {
  return BY_NAME.get(name.toLowerCase());
}
