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
import { COMBAT_AI_DEFAULTS, firstTauntTime } from '../../../src/ai/combat-ai.ts';
import { CombatGroups, type CombatGroupWorld } from '../../../src/ai/combat-groups.ts';
import {
  CombatDialogue,
  COMBAT_DIALOGUE_DEFAULTS,
  COMBAT_LINE_RANGE,
  readCombatDialogueSettings,
  spectatorComments,
} from '../../../src/ai/combat-dialogue.ts';
import { LOAD_ORDER } from './settings.ts';

const settings = COMBAT_AI_DEFAULTS;

describe('combat dialogue', () => {
  it('taunts every fCombatDialogueTauntMin .. MaxElapsedTime (Skyrim.esm 10 .. 30 s)', () => {
    expect(settings.tauntMin).toBe(LOAD_ORDER.fCombatDialogueTauntMinElapsedTime);
    expect(settings.tauntMax).toBe(LOAD_ORDER.fCombatDialogueTauntMaxElapsedTime);
  });

  it('the gates read Skyrim.esm’s taunt span and the engine’s others', () => {
    expect(COMBAT_DIALOGUE_DEFAULTS.lines.Taunt.cooldownMin).toBe(10);
    expect(COMBAT_DIALOGUE_DEFAULTS.lines.Attack.cooldownMax).toBe(5);
    expect(COMBAT_DIALOGUE_DEFAULTS.lines.Flee.cooldownMin).toBe(3);
  });

  it('Attack lines every fCombatDialogueAttack{Min, Max}ElapsedTime (1 .. 5 s), by fCombatSpeakAttackChance', () => {
    const lines = new CombatDialogue();
    const sure = { listener: 0, random: () => 0 };
    expect(lines.may(1, 'Attack', 0, sure)).toBe(true);
    // Its cooldown drawn at 1 s (random 0): not again before.
    expect(lines.may(1, 'Attack', 0.5, sure)).toBe(false);
    expect(lines.may(1, 'Attack', 1, sure)).toBe(true);
    // Another actor's own cooldown; the chance (0.1) fails at 0.5.
    expect(lines.may(2, 'Attack', 0, { listener: 0, random: () => 0.5 })).toBe(false);
  });

  it('AvoidThreat, Flee and AllyKilled lines every 3 .. 5 s  [settings]', () => {
    const lines = new CombatDialogue();
    const late = { listener: 0, random: () => 1 };
    expect(lines.may(1, 'Flee', 0, late)).toBe(true);
    expect(lines.may(1, 'Flee', 4.9, late)).toBe(false);
    expect(lines.may(1, 'Flee', 5, late)).toBe(true);
  });

  it('each subtype heard within its distance mult × the line’s range  [settings]', () => {
    const lines = new CombatDialogue();
    const random = (): number => 0;
    // Block 0.33, Flee 1.
    expect(lines.may(1, 'Block', 0, { listener: 0.4 * COMBAT_LINE_RANGE, random })).toBe(false);
    expect(lines.may(1, 'Flee', 0, { listener: 0.9 * COMBAT_LINE_RANGE, random })).toBe(true);
  });

  it('a Hit line only for a blow of fCombatSpeakHitThreshold (0.1) of its health', () => {
    const lines = new CombatDialogue();
    expect(lines.may(1, 'Hit', 0, { listener: 0, blow: 0.05, random: () => 0 })).toBe(false);
    expect(lines.may(1, 'Hit', 0, { listener: 0, blow: 0.2, random: () => 0 })).toBe(true);
  });

  it('a spectator comments on a fight by fAISocialchanceForConversation (10 %; inside its Interior twin)  [original]', () => {
    const chances = readCombatDialogueSettings((name) =>
      name === 'fAISocialchanceForConversationInterior' ? 40 : undefined,
    );
    expect(COMBAT_DIALOGUE_DEFAULTS.spectatorChance).toBe(10);
    expect(spectatorComments(chances, false, () => 0.09)).toBe(true);
    expect(spectatorComments(chances, false, () => 0.1)).toBe(false);
    expect(spectatorComments(chances, true, () => 0.39)).toBe(true);
  });

  it('Bleedout lines every 1 .. 5 s  [settings]', () => {
    const lines = new CombatDialogue();
    const late = { listener: 0, random: () => 1 };
    expect(lines.may(1, 'Bleedout', 0, late)).toBe(true);
    expect(lines.may(1, 'Bleedout', 4.9, late)).toBe(false);
    expect(lines.may(1, 'Bleedout', 5, late)).toBe(true);
  });

  it('the first taunt drawn as the fight begins (the controller’s taunt timer)  [original]', () => {
    expect(firstTauntTime(() => 0, settings)).toBe(settings.tauntMin);
    expect(firstTauntTime(() => 1, settings)).toBe(settings.tauntMax);
  });

  it('Hit and Death lines at once, PowerAttack and Bash as they start  [xEdit DIAL]', () => {
    const lines = new CombatDialogue();
    const sure = { listener: 0, blow: 1, random: () => 0 };
    // No cooldown of their own: again and again as they come.
    expect(lines.may(1, 'Hit', 0, sure)).toBe(true);
    expect(lines.may(1, 'Hit', 0, sure)).toBe(true);
    expect(lines.may(1, 'Death', 0, sure)).toBe(true);
    expect(lines.may(1, 'Death', 0, sure)).toBe(true);
    expect(lines.may(1, 'PowerAttack', 0, sure)).toBe(true);
    expect(lines.may(1, 'Bash', 0, sure)).toBe(true);
  });

  // The original's subtype and its distance mult are all that is found of it (the gate above has
  // them); when it is said is inferred (combat-groups.ts #strategies): as two or more of a group
  // come to attack one target, the group's longest member that does not flee calls it.
  it('GroupStrategy: the group’s leader calls the strategy  [xEdit DIAL] (inferred)', () => {
    const groups = new CombatGroups();
    const targets = new Map<number, number>([[1, 9]]);
    const fleeing = new Set<number>();
    const calls: [number, number][] = [];
    const world: CombatGroupWorld = {
      combatTarget: (member) => targets.get(member),
      fleeing: (member) => fleeing.has(member),
      position: () => [0, 0, 0],
      present: () => true,
      detects: () => true,
      sneaking: () => false,
      invisible: () => false,
      sees: () => true,
      callStrategy: (leader, target) => calls.push([leader, target]),
    };
    groups.join(1, []);
    groups.join(2, [1]);
    groups.addTarget(1, 9);
    // One attacks it: no strategy yet.
    groups.update(world, 0);
    expect(calls).toEqual([]);
    // A second takes it on: the leader (the group's first) calls it, once.
    targets.set(2, 9);
    groups.update(world, 1);
    groups.update(world, 2);
    expect(calls).toEqual([[1, 9]]);
    // It ends as one turns away; begun again, the leader that flees leaves the call to the next.
    targets.delete(2);
    groups.update(world, 3);
    targets.set(2, 9);
    fleeing.add(1);
    groups.update(world, 4);
    expect(calls).toEqual([
      [1, 9],
      [2, 9],
    ]);
    expect(COMBAT_DIALOGUE_DEFAULTS.lines.GroupStrategy.distanceMult).toBe(1);
  });
});
