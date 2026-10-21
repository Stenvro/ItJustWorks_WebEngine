// What combat's perks look at and the rules that turn the perk system's answers into combat's
// numbers. The perks themselves are the perk system's (src/scripting/runtime/perk-engine.ts):
// combat (src/shell/actor-combat.ts) asks its entry points for each hit (Calculate Weapon
// Damage, Mod Attack Damage through the equip system's weapon damage, Mod Power Attack Damage,
// Mod Bashing Damage, Calculate My Critical Hit Chance / Damage, Mod Enemy Critical Hit Chance,
// Mod Sneak Attack Mult, Mod Percent Blocked, Mod Shield Deflect Arrow Chance, Mod Target
// Damage Resistance, Mod Incoming Damage, Mod Target / Incoming Stagger, Set Sweep Attack, the
// spells they apply) and for the stamina of power attacks. Platform-independent.

/** How an attack is made (what perks look at). */
export interface AttackKind {
  readonly power: boolean;
  readonly bash: boolean;
  readonly sneak: boolean;
  readonly ranged: boolean;
}

/**
 * The chance (0..1) of a critical hit: the attacker's perks' chance in percent (Calculate My
 * Critical Hit Chance: Bladesman, Critical Shot, Critical Charge; 0 without) times the
 * weapon's critical multiplier (CRDT % Mult), times what the target's perks leave of it (Mod
 * Enemy Critical Hit Chance; 1: all). TODO(M13): whether the engine has a base chance without
 * perks (UESP: critical hits come from the perks).
 */
export function criticalHitChance(perkPercent: number, critMult: number, enemyMult = 1): number {
  return Math.min(1, Math.max(0, (perkPercent / 100) * critMult * enemyMult));
}
