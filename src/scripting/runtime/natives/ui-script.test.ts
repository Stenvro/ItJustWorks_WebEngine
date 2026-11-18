import { describe, expect, it } from 'vitest';
import type { NativeCall, NativeFunction } from '../../papyrus-vm.ts';
import { ObjectHandle, PapyrusArray, type Value } from '../../values.ts';
import type { MenuMovie, ScriptRuntime } from '../runtime.ts';
import { menuMovie } from '../../../ui/menu-movies.ts';
import { registerUiScript } from './ui-script.ts';

/** The UI script's natives over one open menu whose movie records what it is told. */
function setup() {
  const values = new Map<string, unknown>([['_root.Menu_mc.count', 3.75]]);
  const invoked: unknown[][] = [];
  const movie: MenuMovie = {
    get: (path) => values.get(path),
    set: (path, value) => values.set(path, value),
    invoke: (path, ...args) => invoked.push([path, ...args]),
  };
  const runtime = {
    menuMovie: (name: string) => (name === 'InventoryMenu' ? movie : undefined),
  } as unknown as ScriptRuntime;
  const natives = new Map<string, NativeFunction>();
  registerUiScript((name, fn) => natives.set(name, fn), runtime);
  const call = (name: string, ...args: Value[]): unknown =>
    natives.get(name)?.({ args, self: null } as unknown as NativeCall);
  return { call, values, invoked };
}

describe("SKSE's UI script", () => {
  it('reads an open menu by its path as the script type asks, a closed one as the default', () => {
    const { call } = setup();
    expect(call('ui.getfloat', 'InventoryMenu', '_root.Menu_mc.count')).toBe(3.75);
    expect(call('ui.getint', 'InventoryMenu', '_root.Menu_mc.count')).toBe(3);
    expect(call('ui.getbool', 'InventoryMenu', '_root.Menu_mc.count')).toBe(true);
    expect(call('ui.getstring', 'InventoryMenu', '_root.Menu_mc.count')).toBe('3.75');
    expect(call('ui.getint', 'MagicMenu', '_root.Menu_mc.count')).toBe(0);
    expect(call('ui.getstring', 'MagicMenu', '_root.x')).toBe('');
  });

  it('sets values and calls functions in the movie, arrays item by item', () => {
    const { call, values, invoked } = setup();
    call('ui.setint', 'InventoryMenu', '_root.Menu_mc.count', 7.9);
    expect(values.get('_root.Menu_mc.count')).toBe(7);
    call('ui.setstring', 'InventoryMenu', '_root.Menu_mc.title', 'Iron');
    expect(values.get('_root.Menu_mc.title')).toBe('Iron');
    call('ui.invoke', 'InventoryMenu', '_root.Menu_mc.Refresh');
    call('ui.invokebool', 'InventoryMenu', '_root.Menu_mc.Show', true);
    call('ui.invokestringa', 'InventoryMenu', '_root.Menu_mc.Fill', new PapyrusArray(['a', 'b']));
    call('ui.invokeform', 'InventoryMenu', '_root.Menu_mc.Item', new ObjectHandle(0x12eb7, 'form'));
    call('ui.invoke', 'MagicMenu', '_root.Menu_mc.Refresh');
    expect(invoked).toEqual([
      ['_root.Menu_mc.Refresh'],
      ['_root.Menu_mc.Show', true],
      ['_root.Menu_mc.Fill', 'a', 'b'],
      ['_root.Menu_mc.Item', { formId: 0x12eb7 }],
    ]);
  });

  it("knows each menu's movie by the menu's name", () => {
    expect(menuMovie('InventoryMenu')).toBe('inventorymenu.swf');
    expect(menuMovie('journal menu')).toBe('quest_journal.swf');
    expect(menuMovie('HUD Menu')).toBe('hudmenu.swf');
    expect(menuMovie('NoSuchMenu')).toBeUndefined();
  });
});
