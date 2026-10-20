// The perk effects combat asks for that no system answers yet (the perk entry points:
// Calculate My Critical Hit Chance, Mod Sneak Attack Mult, Mod Percent Blocked, Mod Stagger,
// Mod Incoming Damage, Sweep), as small functions combat owns: each answers as an actor without
// perks does until the perk system points it at its entry points (setCombatHooks). Weapon
// damage perks are the equip system's (its weapon damage), stamina costs the skill
// progression's. TODO(M11): the perks' entry points. Platform-independent.

/** How an attack is made (what perks look at). */
export interface AttackKind {
  readonly power: boolean;
  readonly bash: boolean;
  readonly sneak: boolean;
  readonly ranged: boolean;
}

export interface CombatHooks {
  /** The chance (0..1) of a critical hit: Bladesman, Deep Wounds, Critical Shot, ... */
  criticalChance(attacker: number, weapon: number | undefined, attack: AttackKind): number;
  /** Critical damage times this. */
  criticalDamageMult(attacker: number, weapon: number | undefined): number;
  /** The sneak attack multiplier times this: Backstab, Assassin's Blade, Deadly Aim. */
  sneakPerkMult(attacker: number, equippedType: number): number;
  /** The blocked share times this: Shield Wall, block enchantments, potions. */
  blockPerkMult(blocker: number, shield: boolean): number;
  /** A hit's stagger times this: Power Bash, Force Without Effort. */
  staggerPerkMult(attacker: number, attack: AttackKind): number;
  /** Whether the attack hits every target in its strike (Sweep). */
  sweeps(attacker: number, attack: AttackKind): boolean;
  /** Damage the target takes times this (its reduce-damage perks: Reduced Damage, ...). */
  incomingDamageMult(target: number, attacker: number | undefined): number;
}

const DEFAULT_HOOKS: CombatHooks = {
  criticalChance: () => 0,
  criticalDamageMult: () => 1,
  sneakPerkMult: () => 1,
  blockPerkMult: () => 1,
  staggerPerkMult: () => 1,
  sweeps: () => false,
  incomingDamageMult: () => 1,
};

let hooks: CombatHooks = DEFAULT_HOOKS;

/** The hooks combat calls now. */
export function combatHooks(): CombatHooks {
  return hooks;
}

/** Points some of combat's hooks at the perk system's answers; undefined: the defaults. */
export function setCombatHooks(replacement: Partial<CombatHooks> | undefined): void {
  hooks = { ...DEFAULT_HOOKS, ...replacement };
}
