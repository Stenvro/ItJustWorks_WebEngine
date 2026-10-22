// Destruction's rules (docs/gameplay.md, "Destruction"): a destructible object's health (its
// base's DEST health) falls by the damage it takes; each stage (DSTD, in the record's order,
// their health percents falling) is reached as the health falls to its percent of the whole.
// The current stage number counts the stages reached (0 undamaged, n: the stage of index n−1;
// what GetCurrentDestructionStage returns: CW's barricades with four stages test < 4 for
// "not yet down", their scripts' OnDestructionStageChanged 1 for the first). A stage with Cap
// Damage stops the blow that reaches it at its percent; while the current stage Ignores
// External Damage, weapons, spells and explosions do nothing (only scripts' DamageObject and
// its own self damage per second take it on); a destroyed object takes no external damage.
// Platform-independent.

import {
  DestructionStageFlag,
  type DestructionData,
  type DestructionStage,
} from '../world/destruction-records.ts';

/** Where a destructible object stands: its health left and its stage number (0 undamaged). */
export interface DestructionStanding {
  readonly health: number;
  readonly stage: number;
}

export interface DestructionStep extends DestructionStanding {
  /** The stage numbers reached by this damage, in order (each one's index + 1). */
  readonly reached: readonly number[];
}

export interface DamageKind {
  /** Weapons, spells, explosions (not a script's DamageObject, not self damage). */
  readonly external: boolean;
  /** Already destroyed (IsDestroyed). */
  readonly destroyed?: boolean;
  /** BlowUp: on through every stage left, past their damage caps. */
  readonly blowUp?: boolean;
}

/** Its full health (DEST health; one where a record has none, so its stages still work). */
export function maxDestructionHealth(data: DestructionData): number {
  return data.health > 0 ? data.health : 1;
}

/** The stage of a stage number (undefined: undamaged, or past the record's stages). */
export function stageOf(data: DestructionData, stage: number): DestructionStage | undefined {
  return stage > 0 ? data.stages[stage - 1] : undefined;
}

/** The health at or below which a stage is reached. */
export function stageThreshold(data: DestructionData, stage: DestructionStage): number {
  return (stage.healthPercent / 100) * maxDestructionHealth(data);
}

/** Damage taken: the health left, the stage now and the stages reached on the way. */
export function damageDestructible(
  data: DestructionData,
  standing: DestructionStanding,
  damage: number,
  kind: DamageKind,
): DestructionStep {
  const unchanged = { health: standing.health, stage: standing.stage, reached: [] };
  if (!(damage > 0) && !kind.blowUp) return unchanged;
  const current = stageOf(data, standing.stage);
  const ignoresExternal =
    kind.destroyed === true ||
    (current !== undefined && (current.flags & DestructionStageFlag.ignoreExternalDamage) !== 0);
  if (kind.external && !kind.blowUp && ignoresExternal) return unchanged;
  let health = kind.blowUp ? 0 : Math.max(0, standing.health - damage);
  let stage = standing.stage;
  const reached: number[] = [];
  for (let index = standing.stage; index < data.stages.length; index++) {
    const next = data.stages[index];
    if (!next) break;
    const threshold = stageThreshold(data, next);
    // Reached as the health falls to its percent (a tiny margin for float percents).
    if (health > threshold + 1e-6) break;
    stage = index + 1;
    reached.push(stage);
    if (kind.blowUp) continue;
    // Cap Damage: the blow stops here; a stage ignoring external damage takes no more of it.
    const stops =
      (next.flags & DestructionStageFlag.capDamage) !== 0 ||
      (kind.external && (next.flags & DestructionStageFlag.ignoreExternalDamage) !== 0);
    if (stops) {
      health = Math.max(health, threshold);
      break;
    }
  }
  return { health, stage, reached };
}

/**
 * A debris' pieces (DSTD debris count of them), each one of the debris' models chosen by their
 * percentages as weights (IceWraithDebris' add up to 100; IceFormDebris lists each piece at
 * 100: TODO(M13): whether the engine instead throws each model by its percentage as a chance
 * per count). `random` in [0, 1).
 */
export function debrisPieces<T extends { readonly percentage: number }>(
  models: readonly T[],
  count: number,
  random: () => number,
): T[] {
  const total = models.reduce((sum, model) => sum + Math.max(0, model.percentage), 0);
  if (total <= 0 || count <= 0) return [];
  const pieces: T[] = [];
  for (let i = 0; i < count; i++) {
    let pick = random() * total;
    for (const model of models) {
      pick -= Math.max(0, model.percentage);
      if (pick < 0) {
        pieces.push(model);
        break;
      }
    }
  }
  return pieces;
}
