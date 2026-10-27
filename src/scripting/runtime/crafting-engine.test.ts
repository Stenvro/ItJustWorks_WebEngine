import { describe, expect, it } from 'vitest';
import { CraftingEngine } from './crafting-engine.ts';
import { GameState } from './game-state.ts';
import type { ScriptRuntime } from './runtime.ts';

const PLAYER = 0x14;
const GRAND_GEM = 0x2e4ff;

describe('partial souls in soul gems (ExtraSoul)', () => {
  it('keeps a smaller soul in an empty gem, counted against the gems that are empty', () => {
    const state = new GameState();
    state.inventories.set(PLAYER, new Map([[GRAND_GEM, 3]]));
    const crafting = new CraftingEngine({ state } as unknown as ScriptRuntime);
    crafting.addSoul(PLAYER, GRAND_GEM, 1);
    crafting.addSoul(PLAYER, GRAND_GEM, 2);
    crafting.addSoul(PLAYER, GRAND_GEM, 2);
    expect(crafting.partialSouls(PLAYER, GRAND_GEM)).toBe(3);
    expect(crafting.partialSoul(PLAYER, GRAND_GEM)).toBe(2);
    // A gem taken without the engine knowing which (a script's RemoveItem) takes a soul along.
    state.inventories.get(PLAYER)?.set(GRAND_GEM, 1);
    expect(crafting.partialSouls(PLAYER, GRAND_GEM)).toBe(1);
  });
});
