// The combat AI's state in an actor's save (docs/formats/ess.md "Combat"): the combat
// controller and the combat objects it and the combat pathing requests point at (aim
// controllers, areas, target selectors, inventory items, magic casters, cover and target
// location searches, combat paths), each written once by id. Platform-independent.

import type { EssReader } from './ess-reader.ts';
import { pathingTypeId } from './pathing-type.ts';

/** A part of the combat data whose layout is not known: where the read stopped, and why. */
export class CombatUnknown extends Error {}

/** What the combat data needs of the stream it is read from (the movement's pathing stream). */
export interface CombatStream {
  readonly reader: EssReader;
  /** A reference id. */
  form(): number;
  /** A shared pathing request (written once by its 8-byte id). */
  request(): void;
  /** A point of a path (a position and the navmesh it is on). */
  point(): void;
}

/** What the combat controller says, as far as the engine has a use for it. */
export interface EssCombatController {
  /** The actor fighting (the controller's owner) and its target (form ids; 0: none). */
  readonly attacker: number;
  readonly target: number;
  /** The names of the entries on its blackboard (timers and what it last failed at). */
  readonly blackboard: readonly string[];
}

/** A part of a combat object's data, in the original's order. */
type Part =
  | number // bytes
  | 'form' // a reference id
  | 'object' // another combat object
  | 'request' // a shared pathing request
  | 'navmesh' // a navmesh triangle: the navmesh (a reference id), the triangle u16, a u32
  | 'point' // a path point (movement.ts)
  | 'string' // a u16-length string
  | readonly ['list', readonly Part[]]; // a vsval count, then each entry's parts

/** An AI timer (a game time and a duration) and a time stamp: 8 and 4 bytes. */
const TIMER = 8;
const STAMP = 4;

/** The combat path's own data, before its request and destination. */
const PATH: readonly Part[] = ['form', 12, TIMER, TIMER, 'object'];
/** A combat pathing search policy's state: its request and four flags. */
const SEARCH: readonly Part[] = ['request', 4];
/** A location (a point and the cell it is in), as combat writes it. */
const LOCATION: readonly Part[] = [12, 'form'];

/** The combat path destinations, by name: what each writes. */
const DESTINATIONS: Readonly<Record<string, readonly Part[]>> = {
  None: [],
  Location: [...LOCATION, 4],
  Locations: [['list', [...LOCATION, 4]]],
  Ref: ['form', ...LOCATION, 4, TIMER],
  Refs: ['form', ...LOCATION, 4, TIMER, ['list', ['form', 4]]],
};

/** The combat path requests (CombatPathT's first argument): what each writes. */
const PATH_REQUESTS: Readonly<Record<string, readonly Part[]>> = {
  Standard: ['request'],
  MultiGoal: ['request'],
  WeightedMultiGoal: ['request', ['list', [4]]],
  StraightPath: ['request'],
  RotatePath: ['request'],
  Flight: ['request'],
  Orbit: ['request', 4],
  Landing: ['request', 'form', 12],
  FlyingAttack: ['request', 'form'],
  // Where to hover: a point and seven values each.
  Hover: ['request', ['list', ['point', 28]]],
};

/** The combat paths the original has, by request and destination (its 14 templates). */
const PATHS: readonly (readonly [string, string])[] = [
  ['Standard', 'Location'],
  ['Standard', 'Ref'],
  ['MultiGoal', 'Locations'],
  ['MultiGoal', 'Refs'],
  ['WeightedMultiGoal', 'Locations'],
  ['WeightedMultiGoal', 'Refs'],
  ['StraightPath', 'Location'],
  ['RotatePath', 'Location'],
  ['Flight', 'Location'],
  ['Flight', 'Ref'],
  ['Orbit', 'Location'],
  ['Landing', 'Location'],
  ['Hover', 'None'],
  ['FlyingAttack', 'None'],
];

/** The combat paths made from a goal and a search policy, with their destination. */
const GENERIC_PATHS: readonly (readonly [string, string, string, readonly Part[]])[] = [
  ['ExitWater', 'Standard', 'None', [...SEARCH]],
  ['FindAttackLocation', 'Standard', 'None', ['object', 12, 4, ...SEARCH]],
  ['FindCover', 'Standard', 'None', ['object', ...SEARCH]],
  ['FindHideCover', 'Standard', 'None', ['object', ...SEARCH]],
  ['FindTargetLocation', 'Standard', 'Ref', ['object', ...SEARCH]],
  ['Flank', 'Flank', 'Ref', ['object', 'object', ...SEARCH, 'object', 'object']],
  ['FlankDistant', 'Standard', 'Location', [28, ...SEARCH]],
  ['Flee', 'Standard', 'None', [16, ...SEARCH]],
  ['Retreat', 'Standard', 'None', [16, ...SEARCH]],
  ['ReturnToCombatArea', 'Standard', 'Location', ['object', 12, ...SEARCH]],
  ['Search', 'Standard', 'None', ['form', ['list', [12]], 12, ...SEARCH]],
  ['SearchWander', 'Standard', 'None', ['form', 12, ...SEARCH]],
];

const AIM: readonly Part[] = [12, 'form', 12, TIMER];
const AREA: readonly Part[] = ['form', 4, 2, TIMER];
const AREA_RADIUS: readonly Part[] = [...AREA, ...LOCATION, 4];
const AREA_REFERENCE: readonly Part[] = [...AREA_RADIUS, 'form', TIMER];
const ITEM: readonly Part[] = ['form', 4, 'form', 4];
const COVER_LOCATION: readonly Part[] = [4, 'navmesh', 4, 24, 12, 12, 4, 'form', 12, 12, 12, 12];

/** The combat object classes by name: what each writes after its id and type. */
const CLASSES: Readonly<Record<string, readonly Part[]>> = {
  CombatAimController: AIM,
  CombatDisableAimController: AIM,
  CombatTrackTargetAimController: [...AIM, 5],
  CombatMeleeAimController: [...AIM, 5, 4],
  CombatProjectileAimController: [...AIM, 'form', 12, 12 * 5, 12, STAMP, 12, STAMP, 'string'],
  CombatAreaStandard: AREA_RADIUS,
  CombatAreaRadius: AREA_RADIUS,
  CombatAreaReference: AREA_REFERENCE,
  CombatAreaHoldPosition: AREA_REFERENCE,
  CombatCoverSearchResult: ['object', 'object'],
  CombatCoverLocation: COVER_LOCATION,
  CombatCoverSearchDebugData: ['object', ['list', ['navmesh', 8]]],
  CombatCoverSearch: [
    'form',
    12,
    2,
    8,
    12,
    12,
    ['list', [12]],
    'object',
    'object',
    4,
    12,
    'object',
  ],
  CombatInventoryItemMelee: [...ITEM, 4],
  CombatInventoryItemRanged: [...ITEM, 'form', 8],
  CombatInventoryItemShield: [...ITEM, 4],
  CombatInventoryItemOneHandedBlock: [...ITEM, 4],
  CombatInventoryItemTorch: [...ITEM, 4],
  CombatMagicCasterOffensive: ['object', TIMER, TIMER],
  CombatMagicCasterWard: ['object', TIMER],
  CombatMagicCasterRestore: ['object', STAMP, 8],
  CombatMagicCasterReanimate: ['object', 'object', 'form'],
  CombatTargetLocation: ['form', 'form', 16, 12],
  CombatTargetLocationSearchResult: ['object', 'object'],
  CombatTargetLocationSearch: [
    'object',
    ['list', [4]],
    ['list', [20, 12]],
    'form',
    'form',
    'form',
    12,
    16,
  ],
  CombatFlankingSearchData: [12 * 4, 4 * 7],
  CombatTargetSelectorStandard: ['form', 8, TIMER],
  CombatTargetSelectorFixed: ['form', 8],
  CombatThreat: ['form', 'form', 4, STAMP, 4, 12, 12, 8, 12, 'form'],
  ApproachTargetSpeedController: ['form', 20, TIMER],
  DiveBombSpeedController: ['form'],
  CombatDisableActionController: ['form'],
  CombatPathingDebugData: [
    'request',
    ['list', ['navmesh', 12, 'navmesh', 12]],
    ['list', ['navmesh', 12]],
    ['list', ['navmesh']],
    4,
  ],
};

/** The magic casters with no data of their own beyond their item. */
const PLAIN_CASTERS = [
  'Summon',
  'Stagger',
  'Disarm',
  'Cloak',
  'Light',
  'Invisibility',
  'BoundItem',
  'Armor',
  'TargetEffect',
  'Paralyze',
  'Script',
];
const CASTERS = [...PLAIN_CASTERS, 'Offensive', 'Ward', 'Restore', 'Reanimate'];
const MAGIC_ITEMS = ['Magic', 'Shout', 'Staff', 'Potion', 'Scroll'];

/** Every combat object class's parts, by the type id it is saved with. */
const COMBAT_TYPES = ((): Map<number, readonly [string, readonly Part[]]> => {
  const types = new Map<number, readonly [string, readonly Part[]]>();
  const add = (name: string, type: number, parts: readonly Part[]): void => {
    types.set(type >>> 0, [name, parts]);
  };
  for (const [name, parts] of Object.entries(CLASSES)) add(name, pathingTypeId(name), parts);
  for (const caster of PLAIN_CASTERS) {
    add(`CombatMagicCaster${caster}`, pathingTypeId(`CombatMagicCaster${caster}`), ['object']);
  }
  // A template's type: its name's id with its arguments' ids mixed in (exclusive or).
  const mix = (...names: string[]): number =>
    names.reduce((type, name) => type ^ pathingTypeId(name), 0);
  for (const item of MAGIC_ITEMS) {
    for (const caster of CASTERS) {
      add(
        `CombatInventoryItemMagicT<${item}, ${caster}>`,
        mix(
          'CombatInventoryItemMagicT',
          `CombatInventoryItem${item}`,
          `CombatMagicCaster${caster}`,
        ),
        [...ITEM, 20, 4],
      );
    }
  }
  for (const [request, destination] of PATHS) {
    add(
      `CombatPathT<${request}, ${destination}>`,
      mix('CombatPathT', `CombatPathRequest${request}`, `CombatPathDestination${destination}`),
      [...PATH, ...(PATH_REQUESTS[request] ?? []), ...(DESTINATIONS[destination] ?? [])],
    );
  }
  for (const [goal, search, destination, parts] of GENERIC_PATHS) {
    // Observed in the original: the generic request's own id is the hover request's name's,
    // with its goal and search policies' mixed in.
    const generic = mix(
      'CombatPathRequestHover',
      `CombatPathingGoalPolicy${goal}`,
      `CombatPathingSearchPolicy${search}`,
    );
    add(
      `CombatPathT<${goal}, ${destination}>`,
      generic ^ mix('CombatPathT', `CombatPathDestination${destination}`),
      [...PATH, 'request', ...parts, ...(DESTINATIONS[destination] ?? [])],
    );
  }
  return types;
})();

/** The combat object classes' names by type id (for messages and tests). */
export function combatTypeName(type: number): string | undefined {
  return COMBAT_TYPES.get(type >>> 0)?.[0];
}

/**
 * A combat object: a u32 id (0: none) with bit 0 set the first time the object is written, and
 * then its type and its data.
 */
export function readCombatObject(stream: CombatStream): void {
  const reader = stream.reader;
  if ((reader.u32() & 1) === 0) return;
  const type = reader.u32();
  const known = COMBAT_TYPES.get(type);
  if (!known) throw new CombatUnknown(`combat object 0x${type.toString(16)}`);
  readParts(stream, known[1]);
}

function readParts(stream: CombatStream, parts: readonly Part[]): void {
  const reader = stream.reader;
  for (const part of parts) {
    if (typeof part === 'number') reader.skip(part);
    else if (part === 'form') stream.form();
    else if (part === 'object') readCombatObject(stream);
    else if (part === 'request') stream.request();
    else if (part === 'navmesh') {
      stream.form();
      reader.skip(2 + 4);
    } else if (part === 'point') stream.point();
    else if (part === 'string') reader.wstring();
    else for (let n = reader.vsval(), i = 0; i < n; i++) readParts(stream, part[1]);
  }
}

/**
 * The blackboard's entries by name: what each key's value is (a timer, a time stamp, a
 * reference with a time stamp, a float), as the original declares its keys.
 */
const BLACKBOARD_KEYS = new Map<string, readonly Part[]>([
  ...[
    'AcquireWeaponTimer',
    'MagicDisarmRestrictionTimer',
    'MagicParalyzeRestrictionTimer',
    'MagicReanimateRestrictionTimer',
    'MagicRestoreRestrictionTimer',
    'MagicScriptRestrictionTimer',
    'MagicSummonRestrictionTimer',
  ].map((name): [string, readonly Part[]] => [name, [TIMER]]),
  ...[
    'CombatDisarmedTimeStamp',
    'CoverSearchFailedTimeStamp',
    'FindAttackLocationFailedTimeStamp',
  ].map((name): [string, readonly Part[]] => [name, [STAMP]]),
  ['LastFleeDoor', ['form', STAMP]],
  ['TargetUnreachableDistance', [4]],
]);

/**
 * Reads a combat controller's data (after the byte that says it is there): its actors, its
 * aim controllers, areas and target selectors, its combat state, inventory, blackboard and
 * behaviour tree, in the original's order.
 */
export function readCombatController(stream: CombatStream): EssCombatController {
  const reader = stream.reader;
  const attacker = stream.form();
  const target = stream.form();
  reader.u32(); // the combat group's id
  reader.skip(6 + 4); // switches (started, stopped, ignoring, inactive, ...) and a float
  reader.skip(TIMER);
  // The aim controllers, then which is current and which was before (indices, −1: none);
  // the areas and the current one; the target selectors, the current and the previous one.
  readParts(stream, [['list', ['object']], 8, ['list', ['object']], 4, ['list', ['object']]]);
  readCombatObject(stream);
  readCombatObject(stream);
  // The combat state: switches, its flee and search data, timers, the positions it saw its
  // target at (a location and a time stamp each), the forms of its group, more timers.
  readParts(stream, [6, 4, 12, 4, 2, 12, 4, 1, STAMP * 4, TIMER * 4]);
  readParts(stream, [['list', [...LOCATION, STAMP]], ['list', ['form']], 1, TIMER * 3, STAMP]);
  // The inventory: its ratings, the items by kind (seven lists), the equipped sets (two:
  // items and five values), the items it threw away with when, two form lists and a map.
  readParts(stream, [40, 1, 4, TIMER]);
  for (let i = 0; i < 7; i++) readParts(stream, [['list', ['object']]]);
  for (let i = 0; i < 2; i++) readParts(stream, [['list', ['object']], 20]);
  readParts(stream, [
    ['list', ['object', STAMP]],
    ['list', ['form']],
    ['list', ['form']],
    ['list', ['form', 4]],
  ]);
  // The blackboard: its entries by name.
  const blackboard: string[] = [];
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    const name = reader.wstring();
    const parts = BLACKBOARD_KEYS.get(name);
    if (!parts) throw new CombatUnknown(`combat blackboard key ${name}`);
    readParts(stream, parts);
    blackboard.push(name);
  }
  reader.u32();
  // The behaviour tree controller: a u32, whether a tree runs (its state follows, prefixed by
  // its size in bytes), the trees by id, then each named tree's state (its root node, the
  // nodes running, and the (u32, node) pairs).
  reader.u32();
  if (reader.u8() !== 0) reader.skip(reader.vsval());
  readParts(stream, [['list', [4]]]);
  for (let n = reader.vsval(), i = 0; i < n; i++) {
    reader.wstring();
    readParts(stream, [4, ['list', [4]], ['list', [8]]]);
  }
  return { attacker, target, blackboard };
}
