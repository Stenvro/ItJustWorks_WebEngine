import { describe, expect, it } from 'vitest';
import type { LipFile } from '../formats/audio/lip.ts';
import { creatureLipVariables, FACE_MORPHS, FaceAnimation, lipLeadIn } from './face.ts';

const at = (name: string): number => FACE_MORPHS.indexOf(name);

/** Blinks after 1 s (the random delay picks the minimum), closing in 0.1 s, opening in 0.2 s. */
const blink = { fBlinkDelayMin: 1, fBlinkDelayMax: 3, fBlinkDownTime: 0.1, fBlinkUpTime: 0.2 };

describe('faces', () => {
  it('blink after their delay: down, then up', () => {
    const face = new FaceAnimation(() => 0, blink);
    face.update(0.9);
    expect(face.weights[at('BlinkLeft')]).toBe(0);
    face.update(0.15); // 1.05 s: the blink started 0.05 s ago (and this frame starts it)
    face.update(0.05);
    expect(face.weights[at('BlinkLeft')]).toBeCloseTo(0.5);
    expect(face.weights[at('BlinkRight')]).toBeCloseTo(0.5);
    face.update(0.15); // 0.2 s into the blink: half way open again
    expect(face.weights[at('BlinkLeft')]).toBeCloseTo(0.5);
    face.update(0.2);
    expect(face.weights[at('BlinkLeft')]).toBe(0);
  });

  it('hold an expression and bump their version when they change', () => {
    const face = new FaceAnimation(() => 0.5, blink);
    face.setExpression('MoodHappy', 0.7);
    face.update(0.01);
    expect(face.weights[at('MoodHappy')]).toBeCloseTo(0.7);
    const version = face.version;
    face.update(0.01);
    expect(face.version).toBe(version);
    face.setExpression(undefined);
    face.update(0.01);
    expect(face.weights[at('MoodHappy')]).toBe(0);
    expect(face.version).toBeGreaterThan(version);
  });

  it("show a response's emotion over their mood, eased in and out", () => {
    const face = new FaceAnimation(() => 0.99, blink);
    face.setExpression('MoodHappy', 0.8);
    // Anger at 60: three tenths of a second to show.
    face.showEmotion(1, 60);
    face.update(0.15);
    expect(face.weights[at('DialogueAnger')]).toBeCloseTo(0.5);
    expect(face.weights[at('MoodHappy')]).toBeCloseTo(0.4);
    face.update(0.3);
    expect(face.weights[at('DialogueAnger')]).toBeCloseTo(0.6);
    // Neutral has no expression of its own: the anger goes, the mood comes back.
    face.showEmotion(0, 50);
    face.update(1);
    expect(face.weights[at('DialogueAnger')]).toBe(0);
    expect(face.weights[at('MoodHappy')]).toBeCloseTo(0.8);
  });

  it("move a creature's mouth through its graph's lip variables", () => {
    const names = creatureLipVariables(
      [
        'LipBigAah',
        'LipDST',
        'LipEee',
        'LipFV',
        'LipK',
        'LipL',
        'LipR',
        'LipTh',
        'LipAcc',
        'LipBigAahDamped',
        'LipGain',
      ].map((name) => ({ name })),
    );
    expect(names).toEqual([
      'LipBigAah',
      'LipDST',
      'LipEee',
      'LipFV',
      'LipK',
      'LipL',
      'LipR',
      'LipTh',
    ]);
    expect(creatureLipVariables([{ name: 'LipGain' }])).toBeUndefined();
    // Two frames of 8 curves: DST at 1.
    const values = new Float32Array(16);
    values[1] = 1;
    values[9] = 1;
    const lip: LipFile = { frames: 2, first: 0, phonemes: 8, curves: 8, values };
    const face = new FaceAnimation(() => 0.99, blink);
    const sunk: number[][] = [];
    face.creatureSink = (curves) => sunk.push([...curves]);
    face.speak(lip);
    face.update(0.01);
    expect(sunk[0]?.[1]).toBeCloseTo(1);
    expect(face.weights[at('Aah')]).toBe(0);
    face.update(1);
    // Once more at rest as it ends, then no more.
    expect(sunk[1]?.every((value) => value === 0)).toBe(true);
    face.update(0.01);
    expect(sunk).toHaveLength(2);
  });

  it('speak a line: phonemes and modifiers from its curves, its lead-in first', () => {
    // Two frames of 33 curves: Aah rises from 0 to 1, BrowUpLeft stays at 0.5.
    const values = new Float32Array(66);
    values[33] = 1;
    values[22] = 0.5;
    values[33 + 22] = 0.5;
    const lip: LipFile = { frames: 2, first: -1, phonemes: 16, curves: 33, values };
    expect(lipLeadIn(lip)).toBeCloseTo(1 / 30);
    const face = new FaceAnimation(() => 0.99, blink);
    face.speak(lip);
    face.update(0.5 / 30);
    expect(face.weights[at('Aah')]).toBeCloseTo(0.5);
    expect(face.weights[at('BrowUpLeft')]).toBeCloseTo(0.5);
    expect(face.speaking).toBe(true);
    face.update(1);
    expect(face.speaking).toBe(false);
    expect(face.weights[at('Aah')]).toBe(0);
  });
});
