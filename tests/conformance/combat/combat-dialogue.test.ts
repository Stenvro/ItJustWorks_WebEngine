// Conformance: combat dialogue (engine map: Combat > Combat dialogue). Who says which combat line
// and how often.
//
// Sources: the engine's defaults: each subtype's cooldown, fCombatDialogue{Attack, Taunt, BleedOut,
// AvoidThreat, Flee, AllyKilled}{Min, Max}ElapsedTime (1..5, 3..10, 1..5, 3..5, 3..5, 3..5 s;
// Skyrim.esm: taunts 10..30), and its distance gate fCombatDialogue*DistanceMult (attack 0.33,
// power attack 0.5, bash 0.33, hit 0.5, flee 1, bleedout 0.75, avoid threat 1, death 1, group
// strategy 1, block 0.33, taunt 0.75, ally killed 0.75); the DIAL subtypes (xEdit: Attack,
// PowerAttack, Bash, Hit, Flee, Bleedout, AvoidThreat, Death, GroupStrategy, Block, Taunt,
// AllyKilled). Observed in the original (docs/ai.md, "Combat dialogue"): Attack, PowerAttack, Bash
// and Block share one timer, AllyKilled and AvoidThreat are timed per combat group; a timer runs
// out only once more than its span has passed and starts only when a line was said; the distance
// is the 3D one to the sound listener against the mult × the 3D dialogue output model's range; a
// Hit line comes always for a blow above fCombatSpeakHitThreshold, else by fCombatSpeakHitChance;
// fCombatSpeakAttackChance, PowerAttackChance and TauntChance are never read; no path of the
// engine's combat lines asks for a GroupStrategy line.

import { describe, expect, it } from 'vitest';
import { COMBAT_AI_DEFAULTS, firstTauntTime } from '../../../src/ai/combat-ai.ts';
import {
  CombatDialogue,
  COMBAT_DIALOGUE_DEFAULTS,
  COMBAT_LINE_RANGE,
  hitCallsLine,
  readCombatDialogueSettings,
  spectatorComments,
} from '../../../src/ai/combat-dialogue.ts';
import { LOAD_ORDER } from './settings.ts';

const settings = COMBAT_AI_DEFAULTS;
const near = { listener: 0 };

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

  it('Attack lines every fCombatDialogueAttack{Min, Max}ElapsedTime (1 .. 5 s), no chance  [original]', () => {
    const lines = new CombatDialogue();
    expect(lines.may(1, 'Attack', 0, near)).toBe(true);
    lines.said(1, 'Attack', 0, () => 0);
    // Its timer drawn at 1 s: not again until more than that has passed.
    expect(lines.may(1, 'Attack', 0.5, near)).toBe(false);
    expect(lines.may(1, 'Attack', 1, near)).toBe(false);
    expect(lines.may(1, 'Attack', 1.01, near)).toBe(true);
    // Another actor's timer is its own.
    expect(lines.may(2, 'Attack', 0.5, near)).toBe(true);
  });

  it('Attack, PowerAttack, Bash and Block share one timer, the Attack span  [original]', () => {
    const lines = new CombatDialogue();
    lines.said(1, 'PowerAttack', 0, () => 1);
    for (const line of ['Attack', 'PowerAttack', 'Bash', 'Block'] as const) {
      expect(lines.may(1, line, 4.9, near)).toBe(false);
      expect(lines.may(1, line, 5.1, near)).toBe(true);
    }
    // Taunt, Bleedout and Flee keep their own.
    expect(lines.may(1, 'Taunt', 1, near)).toBe(true);
    expect(lines.may(1, 'Flee', 1, near)).toBe(true);
  });

  it('a timer starts only once its line was said  [original]', () => {
    const lines = new CombatDialogue();
    // Asked and allowed, but no line found to say: the next ask is free too.
    expect(lines.may(1, 'Flee', 0, near)).toBe(true);
    expect(lines.may(1, 'Flee', 0.1, near)).toBe(true);
  });

  it('AvoidThreat, Flee and AllyKilled lines every 3 .. 5 s  [settings]', () => {
    const lines = new CombatDialogue();
    lines.said(1, 'Flee', 0, () => 1);
    expect(lines.may(1, 'Flee', 4.9, near)).toBe(false);
    expect(lines.may(1, 'Flee', 5.1, near)).toBe(true);
  });

  it('AllyKilled and AvoidThreat are timed per combat group  [original]', () => {
    const lines = new CombatDialogue();
    lines.said(1, 'AllyKilled', 0, () => 1, 7);
    // Another of group 7 waits for the group's timer; one of another group does not.
    expect(lines.may(2, 'AllyKilled', 4, { listener: 0, group: 7 })).toBe(false);
    expect(lines.may(3, 'AllyKilled', 4, { listener: 0, group: 8 })).toBe(true);
    expect(lines.may(2, 'AllyKilled', 5.1, { listener: 0, group: 7 })).toBe(true);
    // A Flee line is still each actor's own.
    lines.said(1, 'Flee', 0, () => 1, 7);
    expect(lines.may(2, 'Flee', 1, { listener: 0, group: 7 })).toBe(true);
  });

  it('each subtype heard within its distance mult × the 3D dialogue model’s range  [original]', () => {
    const lines = new CombatDialogue();
    expect(COMBAT_DIALOGUE_DEFAULTS.range).toBe(COMBAT_LINE_RANGE);
    expect(COMBAT_LINE_RANGE).toBe(3000);
    // Block 0.33 (990 units), Flee 1 (3000).
    expect(lines.may(1, 'Block', 0, { listener: 1000 })).toBe(false);
    expect(lines.may(1, 'Block', 0, { listener: 980 })).toBe(true);
    expect(lines.may(1, 'Flee', 0, { listener: 3000 })).toBe(true);
    expect(lines.may(1, 'Flee', 0, { listener: 3001 })).toBe(false);
    // Without an output model's range there is no limit.
    lines.settings = readCombatDialogueSettings();
    expect(lines.may(1, 'Block', 0, { listener: 1e7 })).toBe(true);
  });

  it('a Hit line for every blow above fCombatSpeakHitThreshold (0.1), else by fCombatSpeakHitChance (0.35)  [original]', () => {
    const gates = COMBAT_DIALOGUE_DEFAULTS;
    expect(gates.hitChance).toBe(0.35);
    expect(hitCallsLine(0.2, gates, () => 0.99)).toBe(true);
    expect(hitCallsLine(0.05, gates, () => 0.35)).toBe(true);
    expect(hitCallsLine(0.05, gates, () => 0.36)).toBe(false);
    expect(hitCallsLine(0.1, gates, () => 0.5)).toBe(false);
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
    lines.said(1, 'Bleedout', 0, () => 1);
    expect(lines.may(1, 'Bleedout', 4.9, near)).toBe(false);
    expect(lines.may(1, 'Bleedout', 5.1, near)).toBe(true);
  });

  it('the first taunt drawn as the fight begins (the controller’s taunt timer)  [original]', () => {
    expect(firstTauntTime(() => 0, settings)).toBe(settings.tauntMin);
    expect(firstTauntTime(() => 1, settings)).toBe(settings.tauntMax);
  });

  it('Hit, Death and GroupStrategy lines have no timer  [original]', () => {
    const lines = new CombatDialogue();
    for (const line of ['Hit', 'Death', 'GroupStrategy'] as const) {
      lines.said(1, line, 0, () => 1);
      expect(lines.may(1, line, 0, near)).toBe(true);
    }
  });

  it('bDisableCombatDialogue silences every line  [settings]', () => {
    const lines = new CombatDialogue();
    lines.settings = readCombatDialogueSettings(undefined, true, COMBAT_LINE_RANGE);
    expect(lines.may(1, 'Death', 0, near)).toBe(false);
  });
});
