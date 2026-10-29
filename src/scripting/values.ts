// Papyrus runtime values. Ints and floats are both JS numbers: every opcode says which
// arithmetic it does, and casts truncate.

/** A form (or a quest alias), seen as a given script or native type. */
export class ObjectHandle {
  /** Global form id; for an alias, the quest. */
  readonly formId: number;
  /** Quest alias id, or -1 for a plain form. */
  readonly alias: number;
  /** Static type, lowercase: a script name ("byohhousescript") or native type ("quest"). */
  readonly type: string;

  constructor(formId: number, type: string, alias = -1) {
    this.formId = formId;
    this.alias = alias;
    this.type = type.toLowerCase();
  }

  /** The same object seen as another type. */
  as(type: string): ObjectHandle {
    return new ObjectHandle(this.formId, type, this.alias);
  }

  get key(): string {
    return `${this.formId.toString(16)}:${String(this.alias)}`;
  }

  sameObject(other: ObjectHandle): boolean {
    return this.formId === other.formId && this.alias === other.alias;
  }
}

/** Papyrus arrays are reference types. */
export class PapyrusArray {
  readonly items: Value[];

  constructor(items: Value[]) {
    this.items = items;
  }
}

export type Value = null | boolean | number | string | ObjectHandle | PapyrusArray;

const PRIMITIVES = new Set(['int', 'float', 'bool', 'string', 'none', 'var']);

export const isArrayType = (type: string): boolean => type.endsWith('[]');
export const elementType = (type: string): string => type.slice(0, -2);
export const isObjectType = (type: string): boolean =>
  !isArrayType(type) && !PRIMITIVES.has(type.toLowerCase());

/** The value a variable of a type starts with. */
export function defaultValue(type: string): Value {
  switch (type.toLowerCase()) {
    case 'int':
    case 'float':
      return 0;
    case 'bool':
      return false;
    case 'string':
      return '';
    default:
      return null;
  }
}

export function truthy(value: Value): boolean {
  if (value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return value.length > 0;
  if (value instanceof PapyrusArray) return value.items.length > 0;
  return true;
}

/** The base scripts' names as declared, for an object's string without its script loaded. */
const BASE_TYPES = new Map(
  [
    'Action',
    'Activator',
    'ActiveMagicEffect',
    'Actor',
    'ActorBase',
    'ActorValueInfo',
    'Alias',
    'Ammo',
    'Apparatus',
    'Armor',
    'ArmorAddon',
    'Art',
    'AssociationType',
    'Book',
    'Cell',
    'Class',
    'ColorForm',
    'CombatStyle',
    'ConstructibleObject',
    'Container',
    'Door',
    'EffectShader',
    'Enchantment',
    'EncounterZone',
    'EquipSlot',
    'Explosion',
    'Faction',
    'Flora',
    'Form',
    'FormList',
    'Furniture',
    'GlobalVariable',
    'Hazard',
    'HeadPart',
    'Idle',
    'ImageSpaceModifier',
    'ImpactDataSet',
    'Ingredient',
    'Key',
    'Keyword',
    'LeveledActor',
    'LeveledItem',
    'LeveledSpell',
    'Light',
    'Location',
    'LocationAlias',
    'LocationRefType',
    'MagicEffect',
    'Message',
    'MiscObject',
    'MusicType',
    'ObjectReference',
    'Outfit',
    'Package',
    'Perk',
    'Potion',
    'Projectile',
    'Quest',
    'Race',
    'ReferenceAlias',
    'Scene',
    'Scroll',
    'Shout',
    'SoulGem',
    'Sound',
    'SoundCategory',
    'SoundDescriptor',
    'Spell',
    'Static',
    'TalkingActivator',
    'TextureSet',
    'Topic',
    'TopicInfo',
    'TreeObject',
    'VisualEffect',
    'VoiceType',
    'Weapon',
    'Weather',
    'WordOfPower',
    'WorldSpace',
  ].map((name) => [name.toLowerCase(), name]),
);
/** A type's name as declared: a base script's, else the name as the handle keeps it. */
export const displayType = (type: string): string => BASE_TYPES.get(type) ?? type;
/** What an object is without the host's records: no editor ID, the form's (or quest's) id. */
export function describeHandle(handle: ObjectHandle): string {
  const id = handle.formId.toString(16).toUpperCase().padStart(8, '0');
  return handle.alias >= 0 ? `alias ${String(handle.alias)} on quest  (${id})` : ` (${id})`;
}

export function formatValue(value: Value): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (value instanceof PapyrusArray) return `[${value.items.map(formatValue).join(', ')}]`;
  // As the original prints it without the records (PapyrusVm.objectText gives the editor ID
  // where the original keeps one, and a script's name as declared).
  return `[${displayType(value.type)} <${describeHandle(value)}>]`;
}

/**
 * A float as Papyrus prints it (a cast to string, a concatenation): its single-precision value
 * with six decimals, "1.500000", "-0.000000", "100.000000" (observed in the original: C's %f).
 * Infinities and NaN as the C runtime prints them ("inf", "-inf", "nan").
 */
export function floatText(value: number): string {
  const single = Math.fround(value);
  if (Number.isNaN(single)) return 'nan';
  if (!Number.isFinite(single)) return single > 0 ? 'inf' : '-inf';
  const sign = single < 0 || Object.is(single, -0) ? '-' : '';
  const magnitude = Math.abs(single);
  // toFixed turns to exponents from 1e21 on; a float that large is a whole number.
  if (magnitude >= 1e21) return `${sign}${BigInt(magnitude).toString()}.000000`;
  return `${sign}${magnitude.toFixed(6)}`;
}

/** Papyrus equality: strings ignore case, objects compare by identity. */
export function valuesEqual(a: Value, b: Value): boolean {
  if (a instanceof ObjectHandle && b instanceof ObjectHandle) return a.sameObject(b);
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (typeof a === 'boolean' && typeof b === 'number') return Number(a) === b;
  if (typeof a === 'number' && typeof b === 'boolean') return a === Number(b);
  return a === b;
}
