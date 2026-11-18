// SKSE's UI script beyond IsMenuOpen: values of an open menu's movie read and set by their
// paths, and its functions called, by the menu's name ("InventoryMenu", "_root.Menu_mc.x"):
// GetBool/Int/Float/String/Number, SetBool/Int/Float/String/Number, Invoke and its one-argument
// and array forms. A menu that is not open reads as its type's default and takes nothing, as
// SKSE's do (UI.psc). Platform-independent. Notes: docs/ui.md ("The menu stack").

import { PapyrusArray, type Value } from '../../values.ts';
import type { ScriptRuntime } from '../runtime.ts';
import { str, type Register } from './args.ts';

/** A movie's value as a script type takes it. */
const asBool = (value: unknown): boolean =>
  value === true || (typeof value === 'number' && value !== 0);
const asNumber = (value: unknown): number => {
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};
const asString = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean'
      ? String(value)
      : '';

/** A script value as the movie takes it (an array's items, a form's id). */
function toMovie(value: Value | undefined): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof PapyrusArray) return value.items.map(toMovie);
  if (typeof value === 'object') return value.formId;
  return value;
}

export function registerUiScript(n: Register, runtime: ScriptRuntime): void {
  const movie = (name: Value | undefined) => runtime.menuMovie?.(str(name));
  const getters: readonly [string, (value: unknown) => Value][] = [
    ['getbool', asBool],
    ['getint', (value) => Math.trunc(asNumber(value))],
    ['getfloat', asNumber],
    ['getnumber', asNumber],
    ['getstring', asString],
  ];
  for (const [name, convert] of getters) {
    n(`ui.${name}`, ({ args }) => convert(movie(args[0])?.get(str(args[1]))));
  }
  for (const name of ['setbool', 'setint', 'setfloat', 'setnumber', 'setstring']) {
    n(`ui.${name}`, ({ args }) => {
      const value = args[2];
      movie(args[0])?.set(
        str(args[1]),
        name === 'setint' && typeof value === 'number' ? Math.trunc(value) : toMovie(value),
      );
      return null;
    });
  }
  n('ui.invoke', ({ args }) => {
    movie(args[0])?.invoke(str(args[1]));
    return null;
  });
  for (const type of ['bool', 'int', 'float', 'number', 'string']) {
    n(`ui.invoke${type}`, ({ args }) => {
      movie(args[0])?.invoke(str(args[1]), toMovie(args[2]));
      return null;
    });
    // The array forms pass each item as an argument of its own.
    n(`ui.invoke${type}a`, ({ args }) => {
      const items = args[2] instanceof PapyrusArray ? args[2].items.map(toMovie) : [];
      movie(args[0])?.invoke(str(args[1]), ...items);
      return null;
    });
  }
  // A form passed as an object of its form id (SKSE makes one of the form).
  n('ui.invokeform', ({ args }) => {
    const form = args[2];
    const formId =
      form !== null && typeof form === 'object' && !(form instanceof PapyrusArray)
        ? form.formId
        : 0;
    movie(args[0])?.invoke(str(args[1]), { formId });
    return null;
  });
}
