import { describe, expect, it } from 'vitest';
import { followWithHud, MenuFlag, MenuName, MenuStack } from './menu-stack.ts';

describe('menu stack', () => {
  it('keeps the menus open by name, bottom to top, and tells its listeners', () => {
    const stack = new MenuStack();
    const told: string[] = [];
    stack.listeners.add((event) => told.push(`${event.opening ? '+' : '-'}${event.name}`));
    expect(stack.open('inventorymenu')).toBe(true);
    expect(stack.open(MenuName.book)).toBe(true);
    expect(stack.open(MenuName.book)).toBe(false);
    expect(stack.open('No Such Menu')).toBe(false);
    expect(stack.names).toEqual([MenuName.inventory, MenuName.book]);
    expect(stack.top).toBe(MenuName.book);
    expect(stack.close(MenuName.inventory)).toBe(true);
    expect(stack.isOpen(MenuName.book)).toBe(true);
    expect(told).toEqual(['+InventoryMenu', '+Book Menu', '-InventoryMenu']);
  });

  it('answers the flags of the menus open', () => {
    const stack = new MenuStack();
    expect(stack.pausesGame).toBe(false);
    const closeCrafting = stack.hold(MenuName.crafting);
    // The crafting menu does not pause the game; it uses the cursor.
    expect(stack.pausesGame).toBe(false);
    expect(stack.usesCursor).toBe(true);
    expect(stack.pauseMenuDisabled).toBe(true);
    closeCrafting();
    closeCrafting();
    expect(stack.names).toEqual([]);
    stack.open(MenuName.journal);
    expect(stack.pausesGame).toBe(true);
    expect(stack.freezesFrame).toBe(true);
    expect(stack.any(MenuFlag.pausesGame | MenuFlag.allowSaving)).toBe(true);
  });

  it('allows saving only while every menu open allows it', () => {
    const stack = new MenuStack();
    expect(stack.savingAllowed).toBe(true);
    stack.open(MenuName.tween);
    expect(stack.savingAllowed).toBe(true);
    stack.open(MenuName.inventory);
    expect(stack.savingAllowed).toBe(false);
    stack.close(MenuName.inventory);
    stack.open(MenuName.map);
    expect(stack.savingAllowed).toBe(false);
  });

  it('lets an autosave wait until the menus allow saving (the map closes after fast travel)', async () => {
    const stack = new MenuStack();
    await stack.whenSavingAllowed();
    stack.open(MenuName.map);
    stack.open(MenuName.loading);
    let allowed = false;
    const waiting = stack.whenSavingAllowed().then(() => {
      allowed = true;
    });
    stack.close(MenuName.loading);
    await Promise.resolve();
    expect(allowed).toBe(false);
    stack.close(MenuName.map);
    await waiting;
    expect(allowed).toBe(true);
  });

  it("registers a mod's own menu with its flags", () => {
    const stack = new MenuStack();
    stack.register('My Mod Menu', { flags: MenuFlag.pausesGame | MenuFlag.usesCursor });
    expect(stack.open('my mod menu')).toBe(true);
    expect(stack.names).toEqual(['My Mod Menu']);
    expect(stack.pausesGame).toBe(true);
  });

  it('puts the HUD in each menu’s mode and hides it behind those that hide it', () => {
    const stack = new MenuStack();
    const calls: string[] = [];
    followWithHud(stack, {
      mode: (name, on) => calls.push(`${name} ${String(on)}`),
      shown: (on) => calls.push(`shown ${String(on)}`),
    });
    stack.open(MenuName.book);
    stack.close(MenuName.book);
    stack.open(MenuName.map);
    stack.close(MenuName.map);
    stack.open(MenuName.crafting);
    stack.close(MenuName.crafting);
    stack.open(MenuName.stats);
    stack.open(MenuName.lockpicking);
    stack.close(MenuName.stats);
    stack.close(MenuName.lockpicking);
    expect(calls).toEqual([
      'BookMode true',
      'BookMode false',
      'WorldMapMode true',
      'WorldMapMode false',
      'InventoryMode true',
      'InventoryMode false',
      'shown false',
      'shown true',
    ]);
  });
});
