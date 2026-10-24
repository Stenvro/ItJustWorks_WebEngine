import { describe, expect, it } from 'vitest';
import {
  actorPrompt,
  crosshairTakes,
  objectPrompt,
  type ActorPromptFacts,
} from './activation-prompt.ts';

const verb = (setting: string): { setting: string } => ({ setting });

describe('crosshairTakes', () => {
  it('takes named references but never statics, static collections or fixed lights', () => {
    expect(crosshairTakes('ACTI', 'Lever')).toBe(true);
    expect(crosshairTakes('ACTI', '')).toBe(false);
    expect(crosshairTakes('STAT', 'Cart')).toBe(false);
    expect(crosshairTakes('SCOL', 'Wall')).toBe(false);
    expect(crosshairTakes('LIGH', 'Torch')).toBe(false);
    expect(crosshairTakes('LIGH', 'Torch', true)).toBe(true);
  });
});

describe('objectPrompt', () => {
  it('shows nothing for an unnamed cart, a static or an unnamed activator', () => {
    expect(objectPrompt({ baseType: 'STAT', name: '' })).toBeUndefined();
    expect(objectPrompt({ baseType: 'STAT', name: 'Hand Cart' })).toBeUndefined();
    expect(objectPrompt({ baseType: 'ACTI', name: '' })).toBeUndefined();
    expect(objectPrompt({ baseType: 'MSTT', name: '' })).toBeUndefined();
  });

  it('gives an activator its own verb, else Activate', () => {
    expect(objectPrompt({ baseType: 'ACTI', name: 'Lever' })?.verb).toEqual(verb('sActivate'));
    expect(
      objectPrompt({ baseType: 'ACTI', name: 'Iron Ore Vein', activateText: 'Mine' })?.verb,
    ).toEqual({
      text: 'Mine',
    });
    const ash = objectPrompt({ baseType: 'ACTI', name: 'Ash Pile', ashPile: { empty: true } });
    expect(ash).toEqual({ verb: verb('sSearch'), name: 'Ash Pile', detail: 'sEmpty' });
  });

  it('opens and closes doors, names load doors after where they lead', () => {
    expect(objectPrompt({ baseType: 'DOOR', name: 'Door' })?.verb).toEqual(verb('sOpen'));
    expect(objectPrompt({ baseType: 'DOOR', name: 'Door', open: true })?.verb).toEqual(
      verb('sClose'),
    );
    expect(
      objectPrompt({ baseType: 'DOOR', name: 'Door', destination: 'Whiterun', open: true }),
    ).toEqual({ verb: verb('sOpen'), name: 'Whiterun' });
  });

  it('unlocks a locked door unless the player holds its key; its level under the name', () => {
    const lock = { level: 'sLockLevelNameAverage', playerHasKey: false };
    expect(objectPrompt({ baseType: 'DOOR', name: 'Door', lock })).toEqual({
      verb: verb('sUnlock'),
      name: 'Door',
      detail: 'sLockLevelNameAverage',
    });
    expect(
      objectPrompt({ baseType: 'DOOR', name: 'Door', lock: { ...lock, playerHasKey: true } })?.verb,
    ).toEqual(verb('sOpen'));
  });

  it('searches containers: steal from, unlock, empty, take all, the owner shown', () => {
    expect(objectPrompt({ baseType: 'CONT', name: 'Chest' })).toEqual({
      verb: verb('sSearch'),
      name: 'Chest',
    });
    expect(objectPrompt({ baseType: 'CONT', name: 'Barrel', empty: true })?.detail).toBe('sEmpty');
    const owned = objectPrompt({
      baseType: 'CONT',
      name: 'Chest',
      crime: true,
      shownOwner: 'Belethor',
    });
    expect(owned).toEqual({ verb: verb('sStealFrom'), name: "Belethor's Chest", crime: true });
    const lock = { level: 'sLockLevelNameEasy', playerHasKey: true };
    // A container's key does not change its verb.
    expect(objectPrompt({ baseType: 'CONT', name: 'Chest', lock })).toEqual({
      verb: verb('sUnlock'),
      name: 'Chest',
      detail: 'sLockLevelNameEasy',
    });
    expect(objectPrompt({ baseType: 'CONT', name: 'Chest', favor: true })?.verb).toEqual(
      verb('sTakeAll'),
    );
  });

  it('reads books, takes spell tomes', () => {
    expect(objectPrompt({ baseType: 'BOOK', name: 'The Buying Game', crime: true })?.verb).toEqual(
      verb('sRead'),
    );
    expect(
      objectPrompt({
        baseType: 'BOOK',
        name: 'Spell Tome: Flames',
        teachesSpell: true,
        crime: true,
      }),
    ).toEqual({ verb: verb('sSteal'), name: 'Spell Tome: Flames', crime: true });
  });

  it('harvests flora and trees while they have their ingredient', () => {
    expect(
      objectPrompt({ baseType: 'FLOR', name: 'Lavender', activateText: 'Harvest' }),
    ).toBeUndefined();
    expect(
      objectPrompt({
        baseType: 'FLOR',
        name: 'Lavender',
        activateText: 'Harvest',
        harvestable: true,
      })?.verb,
    ).toEqual({ text: 'Harvest' });
    expect(
      objectPrompt({ baseType: 'FLOR', name: 'Lavender', harvestable: true, crime: true })?.verb,
    ).toEqual(verb('sSteal'));
    expect(objectPrompt({ baseType: 'TREE', name: 'Juniper', harvestable: true })?.verb).toEqual(
      verb('sHarvest'),
    );
  });

  it('sleeps, sits or uses furniture by its first marker; workbenches are used', () => {
    const furniture = (firstMarker: 'sit' | 'sleep' | 'lean' | undefined, extra = {}) => ({
      firstMarker,
      workbench: false,
      special: false,
      ...extra,
    });
    expect(
      objectPrompt({ baseType: 'FURN', name: 'Bed', furniture: furniture('sleep'), crime: true }),
    ).toEqual({
      verb: verb('sFurnitureSleep'),
      name: 'Bed',
      nameSuffix: 'sOwned',
    });
    expect(
      objectPrompt({ baseType: 'FURN', name: 'Chair', furniture: furniture('sit') })?.verb,
    ).toEqual(verb('sSit'));
    expect(
      objectPrompt({
        baseType: 'FURN',
        name: 'Throne',
        furniture: furniture('sit', { special: true }),
      })?.verb,
    ).toEqual(verb('sUse'));
    expect(
      objectPrompt({
        baseType: 'FURN',
        name: 'Anvil',
        furniture: furniture('sit', { workbench: true }),
      })?.verb,
    ).toEqual(verb('sUse'));
  });

  it('takes items, a stack with its count; owned ones are stolen', () => {
    expect(objectPrompt({ baseType: 'AMMO', name: 'Iron Arrow', count: 12 })).toEqual({
      verb: verb('sTake'),
      name: 'Iron Arrow (12)',
    });
    expect(objectPrompt({ baseType: 'MISC', name: 'Ladle', crime: true, count: 1 })).toEqual({
      verb: verb('sSteal'),
      name: 'Ladle',
      crime: true,
    });
    expect(objectPrompt({ baseType: 'PROJ', name: 'Arrow' })).toBeUndefined();
    expect(objectPrompt({ baseType: 'PROJ', name: 'Arrow', pickUp: true })?.verb).toEqual(
      verb('sTake'),
    );
  });
});

describe('actorPrompt', () => {
  const person: ActorPromptFacts = {
    name: 'Lucan',
    dead: false,
    sneaking: false,
    pickpocketable: true,
    teammate: false,
    talks: true,
  };
  const horse: ActorPromptFacts = { ...person, name: 'Horse', pickpocketable: false, talks: false };

  it('searches the dead, a horse too; empty under one with nothing', () => {
    expect(actorPrompt({ ...horse, dead: true })?.verb).toEqual(verb('sSearch'));
    expect(actorPrompt({ ...person, dead: true, empty: true })?.detail).toBe('sEmpty');
  });

  it('talks to those that may talk, nothing to creatures', () => {
    expect(actorPrompt(person)?.verb).toEqual(verb('sTalk'));
    expect(actorPrompt({ ...horse, name: 'Wolf' })).toBeUndefined();
    expect(actorPrompt({ ...person, name: '' })).toBeUndefined();
  });

  it('rides or steals a mount', () => {
    expect(actorPrompt({ ...horse, rideable: true })?.verb).toEqual(verb('sRide'));
    expect(actorPrompt({ ...horse, rideable: true, stealsRide: true })?.verb).toEqual(
      verb('sSteal'),
    );
  });

  it('pickpockets sneaking, but talks to a teammate and offers nothing on a creature', () => {
    expect(actorPrompt({ ...person, sneaking: true })?.verb).toEqual(verb('sPickpocket'));
    expect(actorPrompt({ ...person, sneaking: true, teammate: true })?.verb).toEqual(verb('sTalk'));
    expect(actorPrompt({ ...horse, name: 'Wolf', sneaking: true })).toBeUndefined();
  });

  it('names a summon after its commander, without a verb', () => {
    expect(actorPrompt({ ...horse, name: 'Flame Atronach', commander: 'Ulfric' })).toEqual({
      verb: { text: '' },
      name: "Ulfric's Flame Atronach",
    });
    expect(
      actorPrompt({ ...horse, name: 'Flame Atronach', commander: 'Ulfric', possessive: false })
        ?.name,
    ).toBe('Ulfric - Flame Atronach');
  });
});
