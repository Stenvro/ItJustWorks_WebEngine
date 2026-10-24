// Conformance: faces (engine map: Animation and bodies > Faces): blinking, expressions, the
// emotions of dialogue and lip sync.
//
// Sources:
// - The settings: the engine's defaults (fExpressionChangePerSec 2, fExpressionStrengthAdd 1,
//   fLookDownDisableBlinkingAmt 0.25; the blink's 1.5, 4, 0.2, 0.17) and Skyrim.esm (fBlinkDelayMin
//   0.5, fBlinkDelayMax 2.5, fBlinkDownTime 0.04, fBlinkUpTime 0.14: `node tools/gmst-info.ts
//   --prefix fBlink`).
// - The 17 expressions of the FaceGen head (BSFaceGenAnimationData; CommonLibSSE
//   BSFaceGenKeyframeMultiple), the emotions of INFO TRDT (CommonLibSSE EmotionType: neutral,
//   anger, disgust, fear, sad, happy, surprise, puzzled).

import { describe, expect, it } from 'vitest';
import {
  EMOTION_EXPRESSIONS,
  EXPRESSION_DEFAULTS,
  FACE_EXPRESSIONS,
  VANILLA_BLINK,
} from '../../../src/animation/face.ts';

describe('the settings', () => {
  it('the expressions’ change rate: the engine’s defaults (Skyrim.esm sets none)', () => {
    expect(EXPRESSION_DEFAULTS).toEqual({
      fExpressionChangePerSec: 2,
      fExpressionStrengthAdd: 1,
      fLookDownDisableBlinkingAmt: 0.25,
    });
  });
  it('the blink: Skyrim.esm’s values', () => {
    expect(VANILLA_BLINK).toEqual({
      fBlinkDelayMin: 0.5,
      fBlinkDelayMax: 2.5,
      fBlinkDownTime: 0.04,
      fBlinkUpTime: 0.14,
    });
  });
});

describe('expressions and emotions (FaceGen, CommonLibSSE)', () => {
  it('17 expressions: 7 dialogue, 8 moods, 2 combat', () => {
    expect(FACE_EXPRESSIONS).toHaveLength(17);
    expect(FACE_EXPRESSIONS.filter((name) => name.startsWith('Dialogue'))).toHaveLength(7);
    expect(FACE_EXPRESSIONS.filter((name) => name.startsWith('Mood'))).toHaveLength(8);
  });
  it('a response’s emotion picks its dialogue expression; neutral keeps the mood', () => {
    expect(EMOTION_EXPRESSIONS).toEqual([
      undefined,
      'DialogueAnger',
      'DialogueDisgusted',
      'DialogueFear',
      'DialogueSad',
      'DialogueHappy',
      'DialogueSurprise',
      'DialoguePuzzled',
    ]);
  });
});

describe('faces (todo)', () => {
  it.todo(
    'a line’s expression strength from its emotion value (TRDT) by the engine’s scale  [original]',
  );
  it.todo('creature lip sync: the curves’ order against the graph’s Lip variables  [original]');
  it.todo('the eyes’ look by head tracking within the eye morphs’ range  [original]');
});
