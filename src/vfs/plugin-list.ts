// The user's plugin list: what the original keeps in %LOCALAPPDATA%\Skyrim Special
// Edition\Plugins.txt (one plugin per line in load order, `*` = active). The browser cannot reach
// that file, so the shell's plugin screen edits this list and keeps it as Plugins.txt text; the
// user can also import their own Plugins.txt. See docs/formats/load-order.md.

import { asciiLowerCase } from '../formats/text.ts';
import { IMPLICIT_MASTERS } from './load-order.ts';

export interface PluginListEntry {
  readonly name: string;
  readonly active: boolean;
}

export interface PluginScreenEntry extends PluginListEntry {
  /**
   * Loaded by the game itself (an implicit master or a Creation in Skyrim.ccc): always active,
   * in its fixed place; Plugins.txt cannot move or disable it.
   */
  readonly fixed: boolean;
}

function lines(text: string | undefined): string[] {
  return (text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** Plugins.txt as the original reads it: the line order, `*Name` active, `Name` inactive. */
export function parsePluginsTxt(text: string): PluginListEntry[] {
  const seen = new Set<string>();
  const entries: PluginListEntry[] = [];
  for (const line of lines(text)) {
    const active = line.startsWith('*');
    const name = (active ? line.slice(1) : line).trim();
    const key = asciiLowerCase(name);
    if (name === '' || seen.has(key)) continue;
    seen.add(key);
    entries.push({ name, active });
  }
  return entries;
}

/** The list as Plugins.txt text (the fixed plugins left out, as the original writes it). */
export function formatPluginsTxt(entries: readonly PluginScreenEntry[]): string {
  const body = entries
    .filter((entry) => !entry.fixed)
    .map((entry) => `${entry.active ? '*' : ''}${entry.name}`);
  return ['# This file keeps track of the plugins in Data (* = active).', ...body, ''].join('\r\n');
}

/**
 * The plugin screen's list of every plugin in Data: the game's own first (implicit masters, then
 * Skyrim.ccc's Creations, both only if present), then the user's Plugins.txt in its order (only
 * plugins present), then plugins Data has that the list does not name, inactive and by name
 * (the original activates a new plugin only when the user does).
 */
export function pluginScreenList(input: {
  readonly present: readonly string[];
  readonly ccc?: string | undefined;
  readonly pluginsTxt?: string | undefined;
}): PluginScreenEntry[] {
  const present = new Map(input.present.map((name) => [asciiLowerCase(name), name]));
  const placed = new Set<string>();
  const result: PluginScreenEntry[] = [];
  const add = (name: string, active: boolean, fixed: boolean): void => {
    const key = asciiLowerCase(name);
    const actual = present.get(key);
    if (actual === undefined || placed.has(key)) return;
    placed.add(key);
    result.push({ name: actual, active, fixed });
  };
  for (const name of IMPLICIT_MASTERS) add(name, true, true);
  for (const name of lines(input.ccc)) add(name, true, true);
  for (const entry of parsePluginsTxt(input.pluginsTxt ?? '')) add(entry.name, entry.active, false);
  const rest = [...present.values()].sort((a, b) =>
    asciiLowerCase(a).localeCompare(asciiLowerCase(b)),
  );
  for (const name of rest) add(name, false, false);
  return result;
}

/**
 * Moves the plugin at `index` by `delta` places among the user's plugins (the fixed ones keep
 * their places). Returns a new list, or the same one if it cannot move.
 */
export function movePlugin(
  list: readonly PluginScreenEntry[],
  index: number,
  delta: number,
): readonly PluginScreenEntry[] {
  const target = index + delta;
  const entry = list[index];
  const other = list[target];
  if (!entry || !other || entry.fixed || other.fixed) return list;
  const moved = [...list];
  moved[index] = other;
  moved[target] = entry;
  return moved;
}
