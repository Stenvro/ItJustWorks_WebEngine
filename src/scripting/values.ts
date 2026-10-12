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

export function formatValue(value: Value): string {
  if (value === null) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  if (value instanceof PapyrusArray) return `[${value.items.map(formatValue).join(', ')}]`;
  const id = value.formId.toString(16).toUpperCase().padStart(8, '0');
  return value.alias >= 0
    ? `[${value.type} alias ${String(value.alias)} of ${id}]`
    : `[${value.type} ${id}]`;
}

/** Papyrus equality: strings ignore case, objects compare by identity. */
export function valuesEqual(a: Value, b: Value): boolean {
  if (a instanceof ObjectHandle && b instanceof ObjectHandle) return a.sameObject(b);
  if (typeof a === 'string' && typeof b === 'string') return a.toLowerCase() === b.toLowerCase();
  if (typeof a === 'boolean' && typeof b === 'number') return Number(a) === b;
  if (typeof a === 'number' && typeof b === 'boolean') return a === Number(b);
  return a === b;
}
