// The animated face of an actor: the weights of its head parts' expression morphs (TRI:
// src/formats/nif/tri.ts) every frame. Eyes blink on their own (delay, close and open times:
// the game settings fBlinkDelayMin/Max, fBlinkDownTime, fBlinkUpTime); an expression (a mood
// or a dialogue emotion) holds at a strength; a spoken line moves the mouth, brows, eyes and
// lids by its lip-sync curves (src/formats/audio/lip.ts). Morph names are FaceGen's (as the
// TRI files and the mfg console commands name them). Platform-independent.

import {
  LIP_MODIFIERS,
  LIP_PHONEMES,
  LIP_RATE,
  lipDuration,
  sampleLip,
  type LipFile,
} from '../formats/audio/lip.ts';

/** Expressions in the game's order (mfg expression ids 0..16). */
export const FACE_EXPRESSIONS = [
  'DialogueAnger',
  'DialogueFear',
  'DialogueHappy',
  'DialogueSad',
  'DialogueSurprise',
  'DialoguePuzzled',
  'DialogueDisgusted',
  'MoodNeutral',
  'MoodAnger',
  'MoodFear',
  'MoodHappy',
  'MoodSad',
  'MoodSurprise',
  'MoodPuzzled',
  'MoodDisgusted',
  'CombatAnger',
  'CombatShout',
] as const;

/** Every morph a face animates: expressions, modifiers (mfg 0..13), phonemes (mfg 0..15). */
export const FACE_MORPHS: readonly string[] = [
  ...FACE_EXPRESSIONS,
  ...LIP_MODIFIERS,
  ...LIP_PHONEMES,
];

const MODIFIER_BASE = FACE_EXPRESSIONS.length;
const PHONEME_BASE = MODIFIER_BASE + LIP_MODIFIERS.length;
const BLINK_LEFT = MODIFIER_BASE + LIP_MODIFIERS.indexOf('BlinkLeft');
const BLINK_RIGHT = MODIFIER_BASE + LIP_MODIFIERS.indexOf('BlinkRight');

/** Blink timing (seconds), the game settings of the same names. */
export interface BlinkSettings {
  readonly fBlinkDelayMin: number;
  readonly fBlinkDelayMax: number;
  readonly fBlinkDownTime: number;
  readonly fBlinkUpTime: number;
}

/** Skyrim.esm's values. */
export const VANILLA_BLINK: BlinkSettings = {
  fBlinkDelayMin: 0.5,
  fBlinkDelayMax: 2.5,
  fBlinkDownTime: 0.04,
  fBlinkUpTime: 0.14,
};

/** Seconds a line's curves start before its audio (its lead-in frames). */
export function lipLeadIn(lip: LipFile): number {
  return Math.max(0, -lip.first) / LIP_RATE;
}

/** What a face shows, for the renderer: FACE_MORPHS weights, bumped `version` on change. */
export interface FaceWeights {
  readonly weights: Float32Array;
  readonly version: number;
}

/** A face's morph weights, moved by blinking, its expression and the line it speaks. */
export class FaceAnimation implements FaceWeights {
  readonly weights = new Float32Array(FACE_MORPHS.length);
  version = 0;
  /** The head's pitch, roll and yaw of the line being spoken (radians). */
  readonly headRotation = new Float32Array(3);
  readonly #blink: BlinkSettings;
  readonly #random: () => number;
  /** Seconds to the next blink, or into the current one (negative: closing/opening). */
  #untilBlink: number;
  #blinking = -1;
  #expression: { index: number; strength: number } | undefined;
  #line: { lip: LipFile; time: number } | undefined;
  readonly #curves = new Float32Array(64);
  readonly #previous = new Float32Array(FACE_MORPHS.length);

  constructor(random: () => number, blink: BlinkSettings = VANILLA_BLINK) {
    this.#random = random;
    this.#blink = blink;
    this.#untilBlink = this.#blinkDelay();
  }

  #blinkDelay(): number {
    const { fBlinkDelayMin: min, fBlinkDelayMax: max } = this.#blink;
    return min + (max - min) * this.#random();
  }

  /** Holds an expression (FACE_EXPRESSIONS name or index) at a strength 0..1; none clears. */
  setExpression(expression: string | number | undefined, strength = 1): void {
    const index =
      typeof expression === 'string'
        ? FACE_EXPRESSIONS.findIndex((name) => name.toLowerCase() === expression.toLowerCase())
        : (expression ?? -1);
    this.#expression =
      index >= 0 && index < FACE_EXPRESSIONS.length
        ? { index, strength: Math.min(1, Math.max(0, strength)) }
        : undefined;
  }

  /**
   * Speaks a line: its curves play from now, its lead-in first; its audio starts
   * lipLeadIn(lip) seconds later.
   */
  speak(lip: LipFile): void {
    this.#line = { lip, time: -lipLeadIn(lip) };
  }

  /** Whether a line is being spoken. */
  get speaking(): boolean {
    return this.#line !== undefined;
  }

  stopSpeaking(): void {
    this.#line = undefined;
  }

  /** Advances the face by `dt` seconds. */
  update(dt: number): void {
    const weights = this.weights;
    const before = this.#previous;
    before.set(weights);
    weights.fill(0);

    // Blinking: a delay, then the lids close (down time) and open (up time).
    let blink = 0;
    if (this.#blinking >= 0) {
      this.#blinking += dt;
      const { fBlinkDownTime: down, fBlinkUpTime: up } = this.#blink;
      if (this.#blinking < down) blink = this.#blinking / Math.max(down, 1e-3);
      else if (this.#blinking < down + up) blink = 1 - (this.#blinking - down) / Math.max(up, 1e-3);
      else {
        this.#blinking = -1;
        this.#untilBlink = this.#blinkDelay();
      }
    } else {
      this.#untilBlink -= dt;
      if (this.#untilBlink <= 0) this.#blinking = 0;
    }

    const expression = this.#expression;
    if (expression) weights[expression.index] = expression.strength;

    // The line: phonemes, then the modifiers it moves (its blinks join the face's own).
    this.headRotation.fill(0);
    const line = this.#line;
    if (line) {
      line.time += dt;
      const lip = line.lip;
      if (line.time > lipDuration(lip)) {
        this.#line = undefined;
      } else {
        const curves = this.#curves;
        sampleLip(lip, line.time, curves);
        if (lip.curves >= LIP_PHONEMES.length + LIP_MODIFIERS.length) {
          for (let p = 0; p < LIP_PHONEMES.length; p++) weights[PHONEME_BASE + p] = curves[p] ?? 0;
          for (let m = 0; m < LIP_MODIFIERS.length; m++) {
            weights[MODIFIER_BASE + m] = curves[LIP_PHONEMES.length + m] ?? 0;
          }
          const head = LIP_PHONEMES.length + LIP_MODIFIERS.length;
          for (let k = 0; k < 3; k++) this.headRotation[k] = curves[head + k] ?? 0;
        }
        // TODO(M10): creature lines (8 curves: dragons, rieklings) move jaws, not FaceGen.
      }
    }
    weights[BLINK_LEFT] = Math.max(weights[BLINK_LEFT] ?? 0, blink);
    weights[BLINK_RIGHT] = Math.max(weights[BLINK_RIGHT] ?? 0, blink);

    for (let i = 0; i < weights.length; i++) {
      if (Math.abs((weights[i] ?? 0) - (before[i] ?? 0)) > 1 / 1024) {
        this.version++;
        break;
      }
    }
  }
}
