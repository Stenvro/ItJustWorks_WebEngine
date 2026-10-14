// Reading native arguments and making return values. Platform-independent.

import type { NativeFunction } from '../../papyrus-vm.ts';
import { formatValue, ObjectHandle, PapyrusArray, type Value } from '../../values.ts';

/** Registers a native by lowercase "script.function". */
export type Register = (name: string, fn: NativeFunction) => void;

export const num = (value: Value | undefined, fallback = 0): number =>
  typeof value === 'number' ? value : typeof value === 'boolean' ? Number(value) : fallback;
export const int = (value: Value | undefined, fallback = 0): number =>
  Math.trunc(num(value, fallback));
export const bool = (value: Value | undefined, fallback = false): boolean =>
  value === undefined ? fallback : value === true || (typeof value === 'number' && value !== 0);
export const str = (value: Value | undefined): string =>
  value === undefined ? '' : typeof value === 'string' ? value : formatValue(value);
export const handle = (value: Value | undefined): ObjectHandle | undefined =>
  value instanceof ObjectHandle ? value : undefined;
export const formOf = (value: Value | undefined): number | undefined =>
  value instanceof ObjectHandle && value.alias < 0 ? value.formId : undefined;

/** A form as a script object (None for no form). */
export const object = (formId: number | undefined, type: string): Value =>
  formId === undefined || formId === 0 ? null : new ObjectHandle(formId, type);

export const array = (items: Value[]): PapyrusArray => new PapyrusArray(items);
