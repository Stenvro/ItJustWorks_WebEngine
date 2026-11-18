import { describe, expect, it } from 'vitest';
import {
  characterIdOfEssName,
  characterKey,
  drawCharacterId,
  moddedLoadOrder,
  moddedOfEssName,
  namedCharacterId,
} from './character-id.ts';

describe("a save's character", () => {
  it('reads the id an original save file name carries', () => {
    expect(characterIdOfEssName('Save1_51FF9A07_0_507269736F6E6572_Tamriel_000005_1_1.ess')).toBe(
      0x51ff9a07,
    );
    expect(characterIdOfEssName('Quicksave.ess')).toBeUndefined();
  });

  it('draws an id that is not 0 and not one already used', () => {
    const draws = [0, 0.5, 0.75];
    const random = (): number => draws.shift() ?? 0.25;
    expect(drawCharacterId(new Set([0x80000000]), random)).toBe(0xc0000000);
  });

  it('keeps the id while the name is its own or the player was never named', () => {
    expect(namedCharacterId(7, undefined, 'Lydia')).toBe(7);
    expect(namedCharacterId(7, 'Lydia', 'Lydia')).toBe(7);
    expect(namedCharacterId(7, 'Lydia', 'Ralof', () => 0.5)).toBe(0x80000000);
    expect(namedCharacterId(undefined, undefined, 'Lydia', () => 0.5)).toBe(0x80000000);
  });

  it('groups saves made before the id by the player name', () => {
    expect(characterKey({ playerName: 'Lydia' })).toBe('name:Lydia');
    expect(characterKey({ playerName: 'Lydia', characterId: 0xab })).toBe('id:ab');
  });

  it("keeps a character's saves made with mods apart, as the file name says", () => {
    expect(moddedOfEssName('Save1_51FF9A07_1_507269736F6E6572_Tamriel_000005_1_1.ess')).toBe(true);
    expect(moddedOfEssName('Save1_51FF9A07_0_507269736F6E6572_Tamriel_000005_1_1.ess')).toBe(false);
    expect(moddedOfEssName('Quicksave.ess')).toBeUndefined();
    expect(characterKey({ playerName: 'Lydia', characterId: 0xab, modded: true })).toBe(
      'id:ab:modded',
    );
    expect(characterKey({ playerName: 'Lydia', characterId: 0xab, modded: false })).toBe('id:ab');
    // Mods are the plugins of plugins.txt; the game's masters and Creations are not.
    expect(moddedLoadOrder([{ source: 'implicit' }, { source: 'Skyrim.ccc' }])).toBe(false);
    expect(moddedLoadOrder([{ source: 'implicit' }, { source: 'plugins.txt' }])).toBe(true);
  });
});
