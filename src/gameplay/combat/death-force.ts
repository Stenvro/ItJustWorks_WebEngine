// The push a killing blow gives the ragdoll (docs/ai.md, "The death push"), observed in the
// original. Platform-independent: the stage pushes (src/shell/actor-combat.ts).

import type { CombatSettings } from './combat-settings.ts';

type DeathForceSettings = Pick<
  CombatSettings,
  | 'deathForceDamageMin'
  | 'deathForceDamageMax'
  | 'deathForceForceMin'
  | 'deathForceForceMax'
  | 'deathForceRangedDamageMin'
  | 'deathForceRangedDamageMax'
  | 'deathForceRangedForceMin'
  | 'deathForceRangedForceMax'
  | 'deathForceSpellImpactMult'
>;

/**
 * The push of a blow of some damage: fDeathForce{Ranged}ForceMin to Max as the damage's size
 * goes from fDeathForce{Ranged}DamageMin to Max (held at both ends).
 */
export function deathForce(damage: number, ranged: boolean, s: DeathForceSettings): number {
  const [dMin, dMax, fMin, fMax] = ranged
    ? [
        s.deathForceRangedDamageMin,
        s.deathForceRangedDamageMax,
        s.deathForceRangedForceMin,
        s.deathForceRangedForceMax,
      ]
    : [s.deathForceDamageMin, s.deathForceDamageMax, s.deathForceForceMin, s.deathForceForceMax];
  const t = Math.min(1, Math.max(0, (Math.abs(damage) - dMin) / Math.max(1e-6, dMax - dMin)));
  return fMin + (fMax - fMin) * t;
}

/**
 * The push of an aimed fire-and-forget spell's projectile whose damage kills its target, or
 * that hits one already dead. Observed in the original: on a corpse it pushes at once with the
 * ranged push of the spell's damage times fDeathForceSpellImpactMult. On the living, the
 * projectile keeps that push on its target, and the death that follows pushes again with the
 * ranged push of the kept number (taken as a damage) times fDeathForceSpellImpactMult: the
 * engine's way, kept as it is. The push is then divided by the mass term as a blow's is.
 */
export function spellDeathForce(
  damage: number,
  alreadyDead: boolean,
  s: DeathForceSettings,
): number {
  const mult = s.deathForceSpellImpactMult;
  const kept = deathForce(damage, true, s) * mult;
  return alreadyDead ? kept : deathForce(kept, true, s) * mult;
}
