// The animated face of an actor: the weights of its head parts' expression morphs (TRI:
// src/formats/nif/tri.ts) every frame. Eyes blink on their own (delay, close and open times:
// the game settings fBlinkDelayMin/Max, fBlinkDownTime, fBlinkUpTime); an expression (a mood)
// holds at a strength, a response's emotion shows over it while it is said; a spoken line
// moves the mouth, brows, eyes and lids by its lip-sync curves (src/formats/audio/lip.ts), a
// creature's line its graph's mouth (creatureSink). Morph names are FaceGen's (as the TRI files
// and the mfg console commands name them). The eyes look where the head's look-at turns the eye
// bone, by the look morphs, wandering a little by the emotion. Platform-independent.

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
const LOOK_LEFT = MODIFIER_BASE + LIP_MODIFIERS.indexOf('LookLeft');
const LOOK_RIGHT = MODIFIER_BASE + LIP_MODIFIERS.indexOf('LookRight');
const LOOK_UP = MODIFIER_BASE + LIP_MODIFIERS.indexOf('LookUp');
const LOOK_DOWN = MODIFIER_BASE + LIP_MODIFIERS.indexOf('LookDown');

/**
 * How far the eyes turn at a look morph's full weight (radians): measured on the eyes' TRI
 * (eyesmale.tri, eyesfemale.tri: LookLeft and LookRight turn the eyeballs about 29° about
 * their centres, LookUp and LookDown about 16°). The engine turns the eyes by these morphs
 * (BSFaceGenAnimationData eyesHeading, eyesPitch); TODO(M13): its own scale is not documented.
 */
export const EYE_MORPH_HEADING = (29 * Math.PI) / 180;
export const EYE_MORPH_PITCH = (16 * Math.PI) / 180;

/** The emotions the eyes' random offsets are given for (fEye*OffsetEmotion<name>). */
export const EYE_EMOTIONS = ['Neutral', 'Angry', 'Fear', 'Happy', 'Sad'] as const;
export type EyeEmotion = (typeof EYE_EMOTIONS)[number];

/** The eyes' random offset range of an emotion (radians), the fEye*OffsetEmotion* settings. */
export interface EyeOffsets {
  readonly headingMin: number;
  readonly headingMax: number;
  readonly pitchMin: number;
  readonly pitchMax: number;
}

/**
 * Skyrim.esm's values; those it does not set (pitch min of anger and happiness, pitch max of
 * sadness) are the engine's built-in ones: TODO(M13), taken as 0.
 */
export const VANILLA_EYES: Readonly<Record<EyeEmotion, EyeOffsets>> = {
  Neutral: { headingMin: -0.05, headingMax: 0.1, pitchMin: -0.025, pitchMax: 0.1 },
  Angry: { headingMin: -0.05, headingMax: 0.05, pitchMin: 0, pitchMax: 0.1 },
  Fear: { headingMin: -0.05, headingMax: 0.1, pitchMin: 0.01, pitchMax: 0.01 },
  Happy: { headingMin: -0.05, headingMax: 0.1, pitchMin: 0, pitchMax: 0.1 },
  Sad: { headingMin: -0.05, headingMax: 0.1, pitchMin: -0.015, pitchMax: 0 },
};

/** The emotion of an expression (FACE_EXPRESSIONS index) for the eyes' offsets. */
function eyeEmotion(expression: number | undefined): EyeEmotion {
  const name = expression === undefined ? '' : (FACE_EXPRESSIONS[expression] ?? '');
  if (name.endsWith('Anger') || name === 'CombatShout') return 'Angry';
  if (name.endsWith('Fear')) return 'Fear';
  if (name.endsWith('Happy')) return 'Happy';
  if (name.endsWith('Sad')) return 'Sad';
  return 'Neutral';
}

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

/**
 * The expression of a dialogue response's emotion (INFO TRDT emotion type; CommonLibSSE
 * EmotionType: neutral, anger, disgust, fear, sad, happy, surprise, puzzled). Neutral has none
 * of its own: the face keeps its mood.
 */
export const EMOTION_EXPRESSIONS: readonly (string | undefined)[] = [
  undefined,
  'DialogueAnger',
  'DialogueDisgusted',
  'DialogueFear',
  'DialogueSad',
  'DialogueHappy',
  'DialogueSurprise',
  'DialoguePuzzled',
];

/** Seconds a dialogue emotion takes to show and to go. TODO(M13): the engine's blend. */
const EMOTION_BLEND = 0.3;

/** The phoneme curves of a creature line (dragons, hagravens, rieklings). */
export const CREATURE_LIP_CURVES = 8;

/**
 * The behavior graph variables a creature's lines move, in curve order: its graph's own
 * phoneme variables (dragons' and hagravens' LipBigAah, LipDST, LipEee, LipFV, LipK, LipL,
 * LipR, LipTh; rieklings' LipAA ... LipTH), which blend its mouth's phoneme poses — not its
 * damped copies or its settings (LipAcc, LipGain). Undefined: the graph has no lip-sync. The
 * curves' order is taken to be the variables' (both list the same eight phonemes; TODO(M13):
 * not documented).
 */
export function creatureLipVariables(
  variables: readonly { readonly name: string }[],
): string[] | undefined {
  const names = variables
    .map((variable) => variable.name)
    .filter((name) => /^Lip/i.test(name) && !/Damped$|^LipAcc$|^LipGain$/i.test(name));
  return names.length === CREATURE_LIP_CURVES ? names : undefined;
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
  /** The emotion of the response being said (its expression and strength), and as shown. */
  #emotion: { index: number; strength: number } | undefined;
  readonly #emotionShown = new Float32Array(FACE_EXPRESSIONS.length);
  /** A creature line's phoneme curves now (CREATURE_LIP_CURVES). */
  readonly creature = new Float32Array(CREATURE_LIP_CURVES);
  /**
   * Where a creature's line goes: its behavior graph's lip variables (creatureLipVariables),
   * set every update while it speaks and once more, at rest, when it stops.
   */
  creatureSink: ((curves: Float32Array) => void) | undefined;
  #creatureSpeaking = false;
  readonly #eyeOffsets: Readonly<Record<EyeEmotion, EyeOffsets>>;
  /** Where the head's look turns the eyes (radians: right and up +), from the eye bone. */
  #eyesBase = { heading: 0, pitch: 0 };
  /** The eyes' random offset (eyesHeadingOffset, eyesPitchOffset) and the seconds it holds. */
  #eyesOffset = { heading: 0, pitch: 0 };
  #eyesOffsetTimer = 0;

  constructor(
    random: () => number,
    blink: BlinkSettings = VANILLA_BLINK,
    eyes: Readonly<Record<EyeEmotion, EyeOffsets>> = VANILLA_EYES,
  ) {
    this.#random = random;
    this.#blink = blink;
    this.#eyeOffsets = eyes;
    this.#untilBlink = this.#blinkDelay();
  }

  /**
   * Where the head's look-at turned the eye bone (BehaviorRuntime.eyes): the eyes follow it by
   * their look morphs; undefined: they look ahead.
   */
  lookWith(eyes: { readonly heading: number; readonly pitch: number } | undefined): void {
    this.#eyesBase = eyes ? { heading: eyes.heading, pitch: eyes.pitch } : { heading: 0, pitch: 0 };
  }

  /**
   * The eyes' heading and pitch now: the look's, and a random offset within the range of the
   * face's emotion (fEyeHeading/PitchMin/MaxOffsetEmotion*), a new one now and then.
   * TODO(M13): how often the engine picks a new offset is not documented (1 to 3 seconds).
   */
  #eyes(dt: number): { heading: number; pitch: number } {
    this.#eyesOffsetTimer -= dt;
    if (this.#eyesOffsetTimer <= 0) {
      const range = this.#eyeOffsets[eyeEmotion((this.#emotion ?? this.#expression)?.index)];
      this.#eyesOffset = {
        heading: range.headingMin + (range.headingMax - range.headingMin) * this.#random(),
        pitch: range.pitchMin + (range.pitchMax - range.pitchMin) * this.#random(),
      };
      this.#eyesOffsetTimer = 1 + 2 * this.#random();
    }
    return {
      heading: this.#eyesBase.heading + this.#eyesOffset.heading,
      pitch: this.#eyesBase.pitch + this.#eyesOffset.pitch,
    };
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

  /**
   * Shows a response's emotion (its type, EMOTION_EXPRESSIONS, and value 0..100) over the
   * face's mood while it is said, eased in; `undefined` lets it go (eased out).
   */
  showEmotion(emotion: number | undefined, value = 50): void {
    const name = emotion === undefined ? undefined : EMOTION_EXPRESSIONS[emotion];
    const index = name === undefined ? -1 : (FACE_EXPRESSIONS as readonly string[]).indexOf(name);
    this.#emotion =
      index >= 0 ? { index, strength: Math.min(1, Math.max(0, value / 100)) } : undefined;
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

    // The emotion of the response said, eased in and out; the mood gives way to it.
    const emotion = this.#emotion;
    const ease = Math.min(1, dt / EMOTION_BLEND);
    let shown = 0;
    for (let i = 0; i < this.#emotionShown.length; i++) {
      const target = emotion?.index === i ? emotion.strength : 0;
      const now = this.#emotionShown[i] ?? 0;
      const next = Math.abs(target - now) <= ease ? target : now + Math.sign(target - now) * ease;
      this.#emotionShown[i] = next;
      shown = Math.max(shown, next);
    }
    const expression = this.#expression;
    if (expression) weights[expression.index] = expression.strength * (1 - shown);
    for (let i = 0; i < this.#emotionShown.length; i++) {
      const value = this.#emotionShown[i] ?? 0;
      if (value > 0) weights[i] = Math.max(weights[i] ?? 0, value);
    }

    // The line: phonemes, then the modifiers it moves (its blinks join the face's own).
    this.headRotation.fill(0);
    this.creature.fill(0);
    const line = this.#line;
    let creature = false;
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
        } else if (lip.curves === CREATURE_LIP_CURVES) {
          // A creature line moves its graph's mouth (creatureSink), not FaceGen morphs.
          for (let c = 0; c < CREATURE_LIP_CURVES; c++) this.creature[c] = curves[c] ?? 0;
          creature = true;
        }
      }
    }
    if (creature || this.#creatureSpeaking) this.creatureSink?.(this.creature);
    this.#creatureSpeaking = creature;
    weights[BLINK_LEFT] = Math.max(weights[BLINK_LEFT] ?? 0, blink);
    weights[BLINK_RIGHT] = Math.max(weights[BLINK_RIGHT] ?? 0, blink);

    // The eyes: where the look turns them, by the look morphs (a line's own looks join them).
    const eyes = this.#eyes(dt);
    const look = (index: number, amount: number): void => {
      weights[index] = Math.max(weights[index] ?? 0, Math.min(1, Math.max(0, amount)));
    };
    look(LOOK_RIGHT, eyes.heading / EYE_MORPH_HEADING);
    look(LOOK_LEFT, -eyes.heading / EYE_MORPH_HEADING);
    look(LOOK_UP, eyes.pitch / EYE_MORPH_PITCH);
    look(LOOK_DOWN, -eyes.pitch / EYE_MORPH_PITCH);

    for (let i = 0; i < weights.length; i++) {
      if (Math.abs((weights[i] ?? 0) - (before[i] ?? 0)) > 1 / 1024) {
        this.version++;
        break;
      }
    }
  }
}
