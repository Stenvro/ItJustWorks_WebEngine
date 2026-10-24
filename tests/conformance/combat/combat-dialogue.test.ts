// Conformance: combat dialogue (engine map: Combat > Combat dialogue). Who says which combat line
// and how often.
//
// Sources: the engine's defaults: each subtype's cooldown, fCombatDialogue{Attack, Taunt, BleedOut,
// AvoidThreat, Flee, AllyKilled}{Min, Max}ElapsedTime (1..5, 3..10, 1..5, 3..5, 3..5, 3..5 s;
// Skyrim.esm: taunts 10..30), and its distance gate fCombatDialogue*DistanceMult (attack 0.33,
// power attack 0.5, bash 0.33, hit 0.5, flee 1, bleedout 0.75, avoid threat 1, death 1, group
// strategy 1, block 0.33, taunt 0.75, ally killed 0.75); the DIAL subtypes (xEdit: Attack,
// PowerAttack, Bash, Hit, Flee, Bleedout, AvoidThreat, Death, GroupStrategy, Block, Taunt,
// AllyKilled).

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS } from '../../../src/ai/combat-ai.ts';
import { LOAD_ORDER } from './settings.ts';

const settings = COMBAT_AI_DEFAULTS;

describe('combat dialogue', () => {
  it('taunts every fCombatDialogueTauntMin .. MaxElapsedTime (Skyrim.esm 10 .. 30 s)', () => {
    expect(settings.tauntMin).toBe(LOAD_ORDER.fCombatDialogueTauntMinElapsedTime);
    expect(settings.tauntMax).toBe(LOAD_ORDER.fCombatDialogueTauntMaxElapsedTime);
  });

  it.todo(
    'Attack lines every fCombatDialogueAttack{Min, Max}ElapsedTime (1 .. 5 s)  [settings]',
  );
  it.todo('Bleedout lines every 1 .. 5 s  [settings]');
  it.todo('AvoidThreat, Flee and AllyKilled lines every 3 .. 5 s  [settings]');
  it.todo('each subtype heard within its distance mult × the voice’s range  [settings]');
  it.todo('the first taunt drawn as the fight begins (original: the controller’s taunt timer)  [original]');
  it.todo('Hit and Death lines at once, PowerAttack and Bash as they start  [xEdit DIAL]');
  it.todo('GroupStrategy: the group’s leader calls the strategy  [xEdit DIAL]');
});
