// The engine's own packages, those no record holds (docs/ai.md, "The engine's own packages"):
// the engine creates one and puts it in front of the actor's package (ActorPackages.push); as
// it ends the actor's packages are chosen again. Platform-independent.
//
// Avoid Player, observed in the original (behaviour only, in our words):
// - **Its start.** The player's swing of a melee weapon, bow shot or projectile spell (the
//   actions whose comments are SwingMeleeWeapon, ShootBow, PlayerCastProjectileSpell) gives it to
//   each actor within fTriggerAvoidPlayerDistance (400) of the player that detects them and is
//   in no combat, as the comment on the action is picked.
// - **Its procedure.** While the player is within fAvoidPlayerDistance (100) of the actor, it
//   goes to a spot away from them; once they are farther, a short timer runs out and it ends.
//
// Inferred, TODO(M13): the spot's rule (here: on the player's far side, twice
// fAvoidPlayerDistance from them, turned up to 60° either way where the straight one is not
// walkable), the timer's length (AVOID_LINGER), the gait (it runs), which other conditions the
// start weighs beyond detection and combat.

import type { EngineRunner } from './package-runtime.ts';

type Vec3 = readonly [number, number, number];

const PLAYER = 0x14;
/** It looks again this often (real seconds). */
const STEP = 0.25;
/** The player this long beyond fAvoidPlayerDistance, it ends (real seconds; ours). */
const AVOID_LINGER = 1;
/** Within this of its spot it is there (units; ours). */
const ARRIVE = 32;
/** The turns tried for its spot when the straight one is not walkable (radians). */
const TURNS = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3];

/** The player's actions that start Avoid Player near them (their comments' subtypes). */
export const AVOID_PLAYER_ACTIONS: ReadonlySet<string> = new Set(['SWMW', 'FIWE', 'PCPS']);

/**
 * Whether an actor takes Avoid Player from the player's action: within
 * fTriggerAvoidPlayerDistance of them, detecting them, in no combat.
 */
export function avoidsPlayer(
  distance: number,
  detects: boolean,
  inCombat: boolean,
  trigger: number,
): boolean {
  return distance < trigger && detects && !inCombat;
}

/** The spot away from the player: on their far side, `reach` from them. */
export function awayFrom(here: Vec3, player: Vec3, reach: number, turn = 0): Vec3 {
  const dx = here[0] - player[0];
  const dy = here[1] - player[1];
  const length = Math.hypot(dx, dy);
  const [ux, uy] = length > 1e-6 ? [dx / length, dy / length] : [0, 1];
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  return [
    player[0] + (ux * cos - uy * sin) * reach,
    player[1] + (ux * sin + uy * cos) * reach,
    here[2],
  ];
}

/** Avoid Player: out of the player's way while they are near, then it ends. */
export const avoidPlayer: EngineRunner = async (run) => {
  const reach = run.settings.avoidPlayerDistance;
  let clear = 0;
  while (!run.stopped()) {
    const here = run.body.position();
    const player = run.mind.livePosition?.(PLAYER);
    if (!here || !player) return;
    if (Math.hypot(here[0] - player[0], here[1] - player[1]) >= reach) {
      clear += STEP;
      if (clear >= AVOID_LINGER) return;
      await run.wait(STEP);
      continue;
    }
    clear = 0;
    let spot: Vec3 | undefined;
    for (const turn of TURNS) {
      const point = awayFrom(here, player, reach * 2, turn);
      spot = run.mind.walkable ? run.mind.walkable(run.actor, point) : point;
      if (spot) break;
    }
    if (!spot) {
      await run.wait(STEP);
      continue;
    }
    await run.body.travel(spot, 'run', ARRIVE);
    await run.wait(STEP);
  }
};
