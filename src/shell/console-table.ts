// The console's commands as the game registers them (observed in the original; UESP
// "Skyrim:Console" lists them too): a name, a short name, whether it is a reference function
// (it acts on the reference before the dot, or the one selected), and its parameters, each with
// the name the game's messages use ("Item 'x' not found for parameter ObjectID."), its type
// and whether it may be left out. The game has some 450 console commands and 740 script
// functions the console runs; this table holds those the engine runs (src/shell/
// console-commands.ts), and a few it knows but cannot do yet, which say so. The help texts
// are the engine's own words. Platform-independent.
//
// TODO(M13): the rest of the game's commands (its debug renderers, memory and profiling tools,
// Bethesda.net, ...): typed now, they are "not found".

import { ITEM_TYPES } from '../world/item-records.ts';

/** What a parameter takes. */
export type ConsoleParamType =
  | { readonly kind: 'string' }
  | { readonly kind: 'int' }
  | { readonly kind: 'float' }
  | { readonly kind: 'axis' }
  | { readonly kind: 'actorValue' }
  | { readonly kind: 'sex' }
  /** A placed reference: by editor id, form id, or "player". */
  | { readonly kind: 'reference' }
  /** A base form of these record types: by editor id or form id. */
  | { readonly kind: 'form'; readonly types: readonly string[] };

export interface ConsoleParam {
  readonly name: string;
  readonly type: ConsoleParamType;
  readonly optional?: boolean;
}

export interface ConsoleCommandInfo {
  readonly name: string;
  readonly short?: string;
  /** A reference function: it acts on a reference (the one before the dot, or selected). */
  readonly reference: boolean;
  readonly params: readonly ConsoleParam[];
  readonly help: string;
  /** A console command (help lists it apart from the script functions). */
  readonly console: boolean;
}

const string = { kind: 'string' } as const;
const int = { kind: 'int' } as const;
const float = { kind: 'float' } as const;
const axis = { kind: 'axis' } as const;
const actorValue = { kind: 'actorValue' } as const;
const reference = { kind: 'reference' } as const;
const form = (...types: string[]): ConsoleParamType => ({ kind: 'form', types });

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

const p = (name: string, type: ConsoleParamType, optional = false): ConsoleParam => ({
  name,
  type,
  ...(optional && { optional }),
});

const command = (
  console: boolean,
  name: string,
  short: string | undefined,
  isReference: boolean,
  params: readonly ConsoleParam[],
  help: string,
): ConsoleCommandInfo => ({
  name,
  ...(short !== undefined && { short }),
  reference: isReference,
  params,
  help,
  console,
});
const c = command.bind(undefined, true);
const s = command.bind(undefined, false);

export const CONSOLE_COMMANDS: readonly ConsoleCommandInfo[] = [
  // --- Console commands -----------------------------------------------------------------------
  c(
    'ToggleAI',
    'TAI',
    false,
    [p('Actor (optional)', reference, true)],
    'Turn an actor’s AI, or all AI, off and on.',
  ),
  c('ToggleSky', 'TS', false, [], 'Turn the sky off and on.'),
  c(
    'ToggleCollision',
    'TCL',
    false,
    [],
    'Turn the player’s collision off and on (fly through the world).',
  ),
  c('ToggleMenus', 'TM', false, [], 'Hide and show the menus and HUD.'),
  c(
    'Help',
    undefined,
    false,
    [
      p('String (Optional)', string, true),
      p('Integer (Optional)', int, true),
      p('String (Optional)', string, true),
    ],
    'List the commands, settings, globals and forms that match a word.',
  ),
  c(
    'PickRefByID',
    'PRID',
    false,
    [p('ObjectReferenceID', reference, true)],
    'Select a reference for the console.',
  ),
  c(
    'ToggleLODLand',
    'TLL',
    false,
    [
      p('String (Optional)', string, true),
      p('String (Optional)', string, true),
      p('String (Optional)', string, true),
      p('String (Optional)', string, true),
    ],
    'Turn the distant land, objects, trees and water off and on.',
  ),
  c('CenterOnCell', 'COC', false, [p('String', string)], 'Go to a cell by its editor id.'),
  c(
    'SetGameSetting',
    'SetGS',
    false,
    [p('String', string), p('String', string)],
    'Set a game setting.',
  ),
  c(
    'CenterOnExterior',
    'COE',
    false,
    [p('Integer', int), p('Integer', int)],
    'Go to an exterior cell of this worldspace by its grid.',
  ),
  c('ToggleDetection', 'TDETECT', false, [], 'Turn the actors’ detection off and on.'),
  c('ToggleTrees', 'TT', false, [], 'Turn the trees off and on.'),
  c(
    'SetCameraFOV',
    'FOV',
    false,
    [p('Float (Optional)', float, true), p('Float (Optional)', float, true)],
    'Set the field of view (degrees; the world’s, then first person’s).',
  ),
  c('ToggleGodMode', 'TGM', false, [], 'Turn god mode on and off.'),
  c(
    'CenterOnWorld',
    'COW',
    false,
    [p('WorldSpace', form('WRLD')), p('Cell X', int), p('Cell Y', int)],
    'Go to a cell of a worldspace by its grid.',
  ),
  c('ToggleGrass', 'TG', false, [], 'Turn the grass off and on.'),
  c('PlayerSpellBook', 'psb', false, [], 'Give the player every spell, shout and word of power.'),
  c(
    'MoveToQuestTarget',
    'movetoqt',
    false,
    [p('Quest', form('QUST')), p('Integer (Optional)', int, true)],
    'Take the player to a target of a quest.',
  ),
  c('ToggleWaterSystem', 'TWS', false, [], 'Turn the water off and on.'),
  c('ToggleCombatAI', 'tcai', false, [], 'Turn all combat AI off and on.'),
  c(
    'ToggleFlyCam',
    'tfc',
    false,
    [p('Integer (Optional)', int, true)],
    'Turn the free camera on and off (1: the world stands still).',
  ),
  c('ToggleFogOfWar', 'TFOW', false, [], 'Turn the local map’s fog of war off and on.'),
  c('QuitGame', 'qqq', false, [], 'Quit the game.'),
  c(
    'ToggleImmortalMode',
    'TIM',
    false,
    [],
    'Turn immortal mode on and off (damage, but no death).',
  ),
  c('GetSelectedRef', 'GSR', false, [], 'Print the reference selected.'),
  c('ClearConsole', 'clear', false, [], 'Clear the console.'),
  // --- Script functions -----------------------------------------------------------------------
  s(
    'GetDistance',
    undefined,
    true,
    [p('ObjectReferenceID', reference)],
    'The distance to a reference.',
  ),
  s(
    'AddItem',
    undefined,
    true,
    [p('ObjectID', form(...INVENTORY_TYPES)), p('Count', int), p('Flag (Optional)', int, true)],
    'Add items to a container.',
  ),
  s(
    'SetEssential',
    undefined,
    false,
    [p('Actor Base', form('NPC_')), p('Integer (Optional)', int, true)],
    'Make an actor essential (1) or not (0).',
  ),
  s('GetLocked', undefined, true, [], 'Whether it is locked.'),
  s('GetPos', undefined, true, [p('Axis', axis)], 'Its position on an axis.'),
  s(
    'SetPos',
    undefined,
    true,
    [p('Axis', axis), p('Float', float)],
    'Set its position on an axis.',
  ),
  s('GetAngle', undefined, true, [p('Axis', axis)], 'Its angle about an axis (degrees).'),
  s(
    'SetAngle',
    undefined,
    true,
    [p('Axis', axis), p('Float', float)],
    'Set its angle about an axis (degrees).',
  ),
  s(
    'Activate',
    undefined,
    true,
    [p('ObjectReferenceID', reference, true), p('Integer (Optional)', int, true)],
    'Activate it (by the player, or by a reference).',
  ),
  s('GetActorValue', 'GetAV', true, [p('Actor Value', actorValue)], 'An actor value.'),
  s(
    'SetActorValue',
    'SetAV',
    true,
    [p('Actor Value', actorValue), p('Amount', float)],
    'Set an actor value’s base.',
  ),
  s(
    'ModActorValue',
    'ModAV',
    true,
    [p('Actor Value', actorValue), p('Amount', float)],
    'Change an actor value by an amount.',
  ),
  s(
    'ForceActorValue',
    'ForceAV',
    true,
    [p('Actor Value', actorValue), p('Amount', float)],
    'Make an actor value’s current value an amount.',
  ),
  s(
    'RestoreActorValue',
    'RestoreAV',
    true,
    [p('Actor Value', actorValue), p('Amount', float)],
    'Restore a damaged actor value.',
  ),
  s('AddSpell', undefined, true, [p('Spell Item', form('SPEL'))], 'Teach an actor a spell.'),
  s('RemoveSpell', undefined, true, [p('Spell Item', form('SPEL'))], 'Take a spell from an actor.'),
  s(
    'Cast',
    undefined,
    true,
    [
      p('Magic Item', form(...MAGIC_TYPES)),
      p('ObjectReferenceID', reference),
      p('Source (Optional)', string, true),
    ],
    'Cast a spell at a reference.',
  ),
  s('Enable', undefined, true, [p('Integer (Optional)', int, true)], 'Enable it.'),
  s('Disable', undefined, true, [p('Integer (Optional)', int, true)], 'Disable it.'),
  s(
    'PlaceAtMe',
    undefined,
    true,
    [
      p('ObjectID', form(...PLACEABLE_TYPES)),
      p('Count', int, true),
      p('Distance', int, true),
      p('Direction', int, true),
    ],
    'Place new references of a base object at it.',
  ),
  s('GetDead', undefined, true, [], 'Whether the actor is dead.'),
  s(
    'GetItemCount',
    undefined,
    true,
    [p('ObjectID', form(...INVENTORY_TYPES))],
    'How many of an item it holds.',
  ),
  s('StartQuest', undefined, false, [p('Quest', form('QUST'))], 'Start a quest.'),
  s('StopQuest', undefined, false, [p('Quest', form('QUST'))], 'Stop a quest.'),
  s('GetQuestRunning', 'GetQR', false, [p('Quest', form('QUST'))], 'Whether a quest runs.'),
  s(
    'SetStage',
    undefined,
    false,
    [p('Quest', form('QUST')), p('Stage', int)],
    'Set a quest’s stage.',
  ),
  s('GetStage', undefined, false, [p('Quest', form('QUST'))], 'A quest’s current stage.'),
  s('GetLevel', undefined, true, [], 'The actor’s level.'),
  s(
    'RemoveItem',
    undefined,
    true,
    [p('ObjectID', form(...INVENTORY_TYPES)), p('Count', int), p('Flag (Optional)', int, true)],
    'Remove items from a container.',
  ),
  s('EnablePlayerControls', 'epc', false, [], 'Give the player their controls back.'),
  s('DisablePlayerControls', 'dpc', false, [], 'Take the player’s controls.'),
  s('CompleteQuest', undefined, false, [p('Quest', form('QUST'))], 'Complete a quest.'),
  s(
    'Lock',
    undefined,
    true,
    [p('Integer (Optional)', int, true), p('Integer (Optional)', int, true)],
    'Lock it (at a lock level).',
  ),
  s('UnLock', undefined, true, [p('Integer (Optional)', int, true)], 'Unlock it.'),
  s(
    'KillActor',
    'kill',
    true,
    [
      p('Actor (optional)', reference, true),
      p('Integer (Optional)', int, true),
      p('Integer (Optional)', int, true),
    ],
    'Kill the actor (by a killer).',
  ),
  s(
    'ResurrectActor',
    'resurrect',
    true,
    [p('Integer (Optional)', int, true)],
    'Bring a dead actor back to life.',
  ),
  s(
    'MoveToMarker',
    'MoveTo',
    true,
    [
      p('ObjectReferenceID', reference),
      p('Float (Optional)', float, true),
      p('Float (Optional)', float, true),
      p('Float (Optional)', float, true),
    ],
    'Move it to a reference (offset by x, y, z).',
  ),
  s(
    'AdvancePCSkill',
    'AdvSkill',
    false,
    [p('Actor Value', actorValue), p('Amount', float)],
    'Give the player skill usage.',
  ),
  s('AdvancePCLevel', 'AdvLevel', false, [], 'Give the player the experience to their next level.'),
  s(
    'ShowRaceMenu',
    'SetPlayerRace',
    false,
    [p('Race (optional)', form('RACE'), true)],
    'Open the race menu; with a race, make it the player’s.',
  ),
  s(
    'RemoveAllItems',
    undefined,
    true,
    [
      p('Container (optional)', reference, true),
      p('Ownership Added (optional)', int, true),
      p('No Message Flag (optional)', int, true),
    ],
    'Remove all items (into a container).',
  ),
  s(
    'EquipItem',
    'EquipObject',
    true,
    [p('ObjectID', form(...ITEM_TYPES)), p('Flag', int, true), p('Hand (Optional)', string, true)],
    'Make the actor equip an item.',
  ),
  s(
    'UnequipItem',
    'UnEquipObject',
    true,
    [p('ObjectID', form(...ITEM_TYPES)), p('Flag', int, true), p('Hand (Optional)', string, true)],
    'Make the actor unequip an item.',
  ),
  s(
    'SetWeather',
    'sw',
    false,
    [p('Weather ID', form('WTHR')), p('Integer (Optional)', int, true)],
    'Make a weather active, with a change.',
  ),
  s('GetGameSetting', 'GetGS', false, [p('String', string)], 'A game setting’s value.'),
  s(
    'ShowQuestObjectives',
    'SQO',
    false,
    [p('Quest', form('QUST'), true)],
    'List the quests’ objectives (or a quest’s).',
  ),
  s(
    'ForceWeather',
    'fw',
    false,
    [p('Weather ID', form('WTHR')), p('Integer (Optional)', int, true)],
    'Make a weather active at once.',
  ),
  s(
    'IncrementPCSkill',
    'IncPCS',
    false,
    [p('Actor Value', actorValue)],
    'Raise a skill of the player by one.',
  ),
  s(
    'SetOwnership',
    undefined,
    true,
    [p('Owner(optional)', form('NPC_', 'FACT'), true)],
    'Give it an owner (the player without one).',
  ),
  s(
    'SetLevel',
    undefined,
    true,
    [
      p('Integer', int),
      p('Integer (Optional)', int, true),
      p('Integer (Optional)', int, true),
      p('Integer (Optional)', int, true),
    ],
    'Set the actor’s level.',
  ),
  s('SetScale', undefined, true, [p('Float', float)], 'Set its scale.'),
  s(
    'KillAllActors',
    'killall',
    false,
    [p('Actor (optional)', reference, true)],
    'Kill every actor around the player.',
  ),
  s('ReleaseWeatherOverride', 'rwo', false, [], 'Let the regions choose the weather again.'),
  s('AddPerk', undefined, true, [p('Perk', form('PERK'))], 'Give an actor a perk.'),
  s('RemovePerk', undefined, true, [p('Perk', form('PERK'))], 'Take a perk from an actor.'),
  s(
    'SetObjectiveCompleted',
    undefined,
    false,
    [p('Quest', form('QUST')), p('Integer', int), p('State', int)],
    'Set an objective completed (1) or not (0).',
  ),
  s(
    'SetObjectiveDisplayed',
    undefined,
    false,
    [p('Quest', form('QUST')), p('Integer', int), p('State', int)],
    'Show an objective (1) or hide it (0).',
  ),
  s(
    'CompleteAllObjectives',
    undefined,
    false,
    [p('Quest', form('QUST'))],
    'Complete all of a quest’s objectives.',
  ),
  s('MarkForDelete', undefined, true, [], 'Delete it.'),
  s(
    'OpenActorContainer',
    undefined,
    true,
    [p('Integer (Optional)', int, true)],
    'Open the actor’s inventory as a container.',
  ),
  s('ResetQuest', undefined, false, [p('Quest', form('QUST'))], 'Reset a quest to its start.'),
  s(
    'SexChange',
    undefined,
    false,
    [p('Sex', { kind: 'sex' }, true), p('Integer (Optional)', int, true)],
    'Change the player’s sex.',
  ),
  s(
    'ShowAllMapMarkers',
    'tmm',
    false,
    [p('Integer', int), p('Integer (Optional)', int, true), p('Integer (Optional)', int, true)],
    'Show (1) or hide (0) the map markers (1 travel; 1 the hidden ones too).',
  ),
  s('ShowQuestStages', 'SQS', false, [p('Quest', form('QUST'))], 'List a quest’s stages.'),
  s('UnlockWord', undefined, false, [p('Word Of Power', form('WOOP'))], 'Unlock a word of power.'),
  s(
    'TeachWord',
    undefined,
    false,
    [p('Word Of Power', form('WOOP'))],
    'Teach the player a word of power.',
  ),
  s('AddShout', undefined, true, [p('Shout', form('SHOU'))], 'Give an actor a shout.'),
  s('RemoveShout', undefined, true, [p('Shout', form('SHOU'))], 'Take a shout from an actor.'),
];

/** The commands by lower-case name and short name. */
const BY_NAME = new Map<string, ConsoleCommandInfo>();
for (const info of CONSOLE_COMMANDS) {
  BY_NAME.set(info.name.toLowerCase(), info);
  if (info.short) BY_NAME.set(info.short.toLowerCase(), info);
}

/** A command by its name or short name (any case). */
export function consoleCommand(name: string): ConsoleCommandInfo | undefined {
  return BY_NAME.get(name.toLowerCase());
}
