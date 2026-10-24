// Conformance: combat music (engine map: Combat > Combat music). When the combat music plays.
//
// Sources: the engine's defaults: fCombatMusicUpdateTime (1 s), fCombatMusicStopTime (5 s),
// fCombatMusicNearCombatInnerRadius / OuterRadius (2500, 3500), fCombatMusicPlayerTargetedThreat
// Ratio (2), fCombatMusicGroupThreatRatioTimer (1), …GroupThreatRatioMin / Max (0.5, 2),
// fCombatMusicPlayerNearStrengthMult (1), fCombatMusicPlayerCombatStrengthCap (35000); the music
// types (MUSC: MUSCombat, MUSCombatBoss; the Default Object CombatMusic).

import { describe, it } from 'vitest';

describe('combat music', () => {
  it.todo('plays when the player is targeted and the threat ratio reaches 2  [settings]');
  it.todo('the group threat ratio between 0.5 and 2, weighed every 1 s  [settings]');
  it.todo('near combat: fights within 2500 .. 3500 of the player  [settings]');
  it.todo('weighed every fCombatMusicUpdateTime (1 s); stops 5 s after the fight  [settings]');
  it.todo('the player’s strength capped at 35000  [settings]');
  it.todo('the boss music for a location’s boss (MUSCombatBoss)  [xEdit MUSC]');
});
