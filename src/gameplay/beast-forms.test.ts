import { describe, expect, it } from 'vitest';
import { beastFormOf, beastListed, beastMenuShut } from './beast-forms.ts';

const WEREWOLF_RACE = 0xcdd84;
const VAMPIRE_LORD_RACE = 0x200283a;
const NORD = 0x13746;
const defaults = (use: string): number | undefined =>
  use === 'RIWR' ? WEREWOLF_RACE : use === 'RIVR' ? VAMPIRE_LORD_RACE : undefined;

describe('the beast forms', () => {
  it('tells the form by the race, a change under way before the race changes', () => {
    expect(beastFormOf(false, WEREWOLF_RACE, defaults)).toBeUndefined();
    expect(beastFormOf(true, WEREWOLF_RACE, defaults)).toBe('werewolf');
    expect(beastFormOf(true, VAMPIRE_LORD_RACE, defaults)).toBe('vampireLord');
    expect(beastFormOf(true, NORD, defaults)).toBe('changing');
  });

  it("keeps the werewolf's item and spell menus shut, the vampire lord's inventory alone", () => {
    for (const menu of ['Inventory', 'Magic', 'Favorites']) {
      expect(beastMenuShut('werewolf', menu)).toBe(true);
      expect(beastMenuShut('changing', menu)).toBe(true);
      expect(beastMenuShut(undefined, menu)).toBe(false);
    }
    expect(beastMenuShut('vampireLord', 'Inventory')).toBe(true);
    expect(beastMenuShut('vampireLord', 'Magic')).toBe(false);
    expect(beastMenuShut('vampireLord', 'Favorites')).toBe(false);
    expect(beastMenuShut('werewolf', 'Map')).toBe(false);
  });

  it("lists the vampire lord's own spells (VampireSpells) alone", () => {
    const list = new Set([0x200cd5c]);
    expect(beastListed('vampireLord', 0x200cd5c, list)).toBe(true);
    expect(beastListed('vampireLord', 0x12fcd, list)).toBe(false);
    expect(beastListed(undefined, 0x12fcd, list)).toBe(true);
    expect(beastListed('werewolf', 0x200cd5c, list)).toBe(false);
  });
});
