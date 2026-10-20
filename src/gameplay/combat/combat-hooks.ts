// What combat asks of the systems milestone M11 builds (skill progression, perks, the stamina
// costs perks change), as small functions combat owns: each answers as an actor without perks
// does until its system points it at the real one (setCombatHooks). Platform-independent.

import type { WeaponCombat } from './combat-records.ts';

/** How an attack is made (what perks look at). */
export interface AttackKind {
  readonly power: boolean;
  readonly bash: boolean;
  readonly sneak: boolean;
  readonly ranged: boolean;
}

export interface CombatHooks {
  /**
   * An actor used a skill (actor value index) by `amount` (a hit: the weapon's base damage; a
   * block: the damage blocked; a sneak attack: fSneakAttackSkillUsageMelee). The skill
   * progression's useSkill(actor, skill, amount) (M11).
   */
  useSkill(actor: number, skill: number, amount: number): void;
  /** (1 + perk effects) on an attack's damage: Armsman, Barbarian, Overdraw, ... */
  damagePerkMult(attacker: number, weapon: WeaponCombat | undefined, attack: AttackKind): number;
  /** The chance (0..1) of a critical hit: Bladesman, Deep Wounds, Critical Shot, ... */
  criticalChance(attacker: number, weapon: WeaponCombat | undefined, attack: AttackKind): number;
  /** Critical damage times this. */
  criticalDamageMult(attacker: number, weapon: WeaponCombat | undefined): number;
  /** The sneak attack multiplier times this: Backstab, Assassin's Blade, Deadly Aim. */
  sneakPerkMult(attacker: number, equippedType: number): number;
  /** The blocked share times this: Shield Wall, block enchantments, potions. */
  blockPerkMult(blocker: number, shield: boolean): number;
  /** A hit's stagger times this: Power Bash, Force Without Effort. */
  staggerPerkMult(attacker: number, attack: AttackKind): number;
  /** An attack's stamina cost times this (power attack perks, Storm Bear gauntlets). */
  staminaPerkMult(attacker: number, attack: AttackKind): number;
  /** Whether the attack hits every target in its strike (Sweep). */
  sweeps(attacker: number, attack: AttackKind): boolean;
  /** Damage the target takes times this (its reduce-damage perks: Reduced Damage, ...). */
  incomingDamageMult(target: number, attacker: number | undefined): number;
}

const DEFAULT_HOOKS: CombatHooks = {
  // TODO(M11): the skill progression (its useSkill).
  useSkill: () => undefined,
  damagePerkMult: () => 1,
  criticalChance: () => 0,
  criticalDamageMult: () => 1,
  sneakPerkMult: () => 1,
  blockPerkMult: () => 1,
  staggerPerkMult: () => 1,
  staminaPerkMult: () => 1,
  sweeps: () => false,
  incomingDamageMult: () => 1,
};

let hooks: CombatHooks = DEFAULT_HOOKS;

/** The hooks combat calls now. */
export function combatHooks(): CombatHooks {
  return hooks;
}

/** Points some of combat's hooks at the systems that answer them (M11); undefined: defaults. */
export function setCombatHooks(replacement: Partial<CombatHooks> | undefined): void {
  hooks = { ...DEFAULT_HOOKS, ...replacement };
}

/** useSkill(actor, skill, amount): the skill progression's (combat's call into it). */
export function useSkill(actor: number, skill: number, amount: number): void {
  if (skill >= 0 && amount > 0) hooks.useSkill(actor, skill, amount);
}
