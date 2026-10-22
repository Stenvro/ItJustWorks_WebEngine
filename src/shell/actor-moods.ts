// The expressions on the faces of the actors of the loaded area and the player's (docs/
// animation.md, "Faces"; the rule: src/ai/moods.ts): every frame each face holds a script's
// override (SetExpressionOverride: ScriptWorld.expressionOverrides), else CombatShout while it
// shouts and CombatAnger in combat, else its AI's mood (the Mood actor value, read again every
// MOOD_SECONDS: scripts set it).

import { faceExpression } from '../ai/moods.ts';
import type { FaceAnimation } from '../animation/face.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ActorValue } from '../world/actor-values.ts';
import type { GameSession } from './game-session.ts';

/** How often an actor's Mood actor value is read again (seconds). */
const MOOD_SECONDS = 2;

/** A face of the loaded area: whose it is and its animation. */
export interface MoodFace {
  readonly reference: number;
  readonly face: FaceAnimation | undefined;
}

export class ActorMoods {
  readonly #session: GameSession;
  /** Each actor's Mood actor value and when it was read. */
  readonly #moods = new Map<number, { mood: number; at: number }>();
  readonly #reading = new Set<number>();
  #clock = 0;

  constructor(session: GameSession) {
    this.#session = session;
  }

  /** Sets every face's expression for this frame. */
  frame(faces: Iterable<MoodFace>, seconds: number): void {
    this.#clock += seconds;
    const runtime = this.#session.scriptsReady;
    if (!runtime) return;
    const overrides = this.#session.scriptWorld.expressionOverrides;
    for (const { reference, face } of faces) {
      if (!face) continue;
      const combat = runtime.world.combat?.(reference);
      const shown = faceExpression({
        override: overrides.get(reference),
        shouting: runtime.casting.isShouting(reference),
        inCombat: combat?.inCombat === true,
        mood: this.#mood(runtime, reference),
      });
      face.setExpression(shown.expression, shown.strength);
    }
  }

  /** An actor's Mood actor value (neutral until read). */
  #mood(runtime: ScriptRuntime, reference: number): number {
    const kept = this.#moods.get(reference);
    if ((!kept || this.#clock - kept.at > MOOD_SECONDS) && !this.#reading.has(reference)) {
      this.#reading.add(reference);
      void runtime.actors
        .value(reference, ActorValue.mood)
        .then((value) => {
          this.#moods.set(reference, { mood: Math.round(value.current), at: this.#clock });
        })
        .catch(() => {
          this.#moods.set(reference, { mood: 0, at: this.#clock });
        })
        .finally(() => this.#reading.delete(reference));
    }
    return kept?.mood ?? 0;
  }

  /** An actor left: what was kept of it goes. */
  forget(reference: number): void {
    this.#moods.delete(reference);
  }
}
