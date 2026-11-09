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
// - The eyes' settings: Skyrim.esm's fTrackSpeed 5 and fEye*OffsetEmotion* (`node tools/gmst-info.ts
//   --prefix fEye`); the load order has none of an earlier game's eye range settings (fTrackEyeXY,
//   fTrackEyeZ). The eyes' look morphs: the eye TRIs (`node tools/tri-info.ts <tri>`).
// - Creature lip sync: the dragons', hagravens' and rieklings' graphs' Lip variables
//   (dragonproject.hkx, hagravenproject.hkx, rieklingproject.hkx) and their lines' eight curves
//   (`node tools/lip-info.ts <line>`).

import { beforeAll, describe, expect, it } from 'vitest';
import {
  creatureLipVariables,
  CREATURE_LIP_CURVES,
  CREATURE_LIP_PHONEMES,
  EMOTION_EXPRESSIONS,
  EXPRESSION_DEFAULTS,
  EYE_EMOTIONS,
  EYE_MORPH_HEADING,
  EYE_MORPH_PITCH,
  eyeOffsetSetting,
  FACE_EXPRESSIONS,
  FACE_MORPHS,
  FaceAnimation,
  VANILLA_BLINK,
  VANILLA_EYES,
} from '../../../src/animation/face.ts';
import { parseLip } from '../../../src/formats/audio/lip.ts';
import { loadBehaviorFiles, loadCharacterInfo } from '../../../src/formats/hkx/behavior.ts';
import { parseTri } from '../../../src/formats/nif/tri.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { GameSettings } from '../../../src/world/game-settings.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { hasGamedata, openGameFolder } from '../../../tools/gamedata-path.ts';

describe('the settings', () => {
  it('the expressions’ change rate: the engine’s defaults (Skyrim.esm sets none)', () => {
    expect(EXPRESSION_DEFAULTS).toEqual({
      fExpressionChangePerSec: 2,
      fExpressionStrengthAdd: 1,
      fLookDownDisableBlinkingAmt: 0.25,
      fTrackSpeed: 2,
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
  // Open: the engine's scale from an eye turn to a look morph's weight is not documented, no
  // game setting gives it (the eyes read fTrackSpeed alone; the load order has no fTrackEye*
  // range), and the eye TRIs' look morphs are no rigid turn that would give it. The mechanics
  // below run on an inferred estimate (EYE_MORPH_HEADING, EYE_MORPH_PITCH; TODO(M13)).
  it.todo('the eyes’ look by head tracking within the eye morphs’ range  [original]');
});

// The eyes (BSFaceGenAnimationData eyesHeading, eyesPitch): head tracking's look-at turns them
// (BehaviorRuntime.eyes), and they show it by the eye TRI's look morphs, a morph at full weight
// at its estimated turn and held there beyond it (inferred, TODO(M13)). They wander a little
// within their emotion's offsets (fEye*OffsetEmotion*: Skyrim.esm's; 0 where it sets none,
// TODO(M13)).

const STILL = { headingMin: 0, headingMax: 0, pitchMin: 0, pitchMax: 0 };
const NO_WANDER = { Neutral: STILL, Angry: STILL, Fear: STILL, Happy: STILL, Sad: STILL };
const morph = (name: string): number => FACE_MORPHS.indexOf(name);

describe('the eyes’ look by the look morphs (inferred scale)', () => {
  /** A face whose eyes go straight where the look turns them (radians). */
  const looking = (heading: number, pitch: number): Float32Array => {
    const face = new FaceAnimation(() => 0.5, { ...VANILLA_BLINK, fTrackSpeed: 100 }, NO_WANDER);
    face.lookWith({ heading, pitch });
    face.update(0.5);
    return face.weights;
  };

  it('a look half way to a morph’s turn is half that morph, the other side’s none', () => {
    const right = looking(EYE_MORPH_HEADING / 2, 0);
    expect(right[morph('LookRight')]).toBeCloseTo(0.5, 3);
    expect(right[morph('LookLeft')]).toBe(0);
    const down = looking(0, -EYE_MORPH_PITCH / 2);
    expect(down[morph('LookDown')]).toBeCloseTo(0.5, 3);
    expect(down[morph('LookUp')]).toBe(0);
  });

  it('beyond a morph’s turn the morph holds at full weight', () => {
    const far = looking(-2 * EYE_MORPH_HEADING, 2 * EYE_MORPH_PITCH);
    expect(far[morph('LookLeft')]).toBe(1);
    expect(far[morph('LookUp')]).toBe(1);
  });
});

describe.skipIf(!hasGamedata())('the eye settings of the load order (data)', () => {
  let settings: GameSettings;
  /** The look morphs of each eye TRI. */
  const looks = new Map<string, string[]>();

  beforeAll(async () => {
    const vfs = await Vfs.mount(openGameFolder());
    const db = await RecordDatabase.open(vfs);
    try {
      settings = await GameSettings.read(db);
      for (const eyes of ['eyesmale', 'eyesfemale', 'eyeskhajiit', 'eyesargonian', 'eyeschild']) {
        const tri = parseTri(
          await vfs.read(`meshes\\actors\\character\\character assets\\${eyes}.tri`),
        );
        looks.set(
          eyes,
          tri.morphs.map((m) => m.name).filter((name) => name.startsWith('Look')),
        );
      }
    } finally {
      await db.close();
      await vfs.close();
    }
  }, 600_000);

  it('has no eye range setting of an earlier game (fTrackEyeXY, fTrackEyeZ), fTrackSpeed 5', () => {
    expect(settings.number('fTrackEyeXY')).toBeUndefined();
    expect(settings.number('fTrackEyeZ')).toBeUndefined();
    expect(settings.number('fTrackSpeed')).toBe(5);
  });

  it('the people’s and the Khajiit’s eyes carry the four look morphs; Argonian and child eyes none', () => {
    const four = ['LookDown', 'LookLeft', 'LookRight', 'LookUp'];
    for (const eyes of ['eyesmale', 'eyesfemale', 'eyeskhajiit'])
      expect([...(looks.get(eyes) ?? [])].sort()).toEqual(four);
    // The face drives them by these names.
    for (const name of four) expect(morph(name)).toBeGreaterThanOrEqual(0);
    expect(looks.get('eyesargonian')).toEqual([]);
    expect(looks.get('eyeschild')).toEqual([]);
  });

  it('sets the emotions’ eye offsets but three', () => {
    const unset: string[] = [];
    for (const emotion of EYE_EMOTIONS) {
      for (const axis of ['Heading', 'Pitch'] as const) {
        for (const bound of ['Min', 'Max'] as const) {
          const name = eyeOffsetSetting(emotion, axis, bound);
          const value = settings.number(name);
          if (value === undefined) {
            unset.push(name);
            continue;
          }
          const own = VANILLA_EYES[emotion];
          const expected =
            axis === 'Heading'
              ? bound === 'Min'
                ? own.headingMin
                : own.headingMax
              : bound === 'Min'
                ? own.pitchMin
                : own.pitchMax;
          expect(value).toBeCloseTo(expected, 5);
        }
      }
    }
    expect(unset.sort()).toEqual([
      'fEyePitchMaxOffsetEmotionSad',
      'fEyePitchMinOffsetEmotionAngry',
      'fEyePitchMinOffsetEmotionHappy',
    ]);
  });
});

// Creature lip sync: a creature line's eight curves (dragons, hagravens, rieklings) move its
// graph's phoneme variables, curve by curve in the phonemes' order by name (BigAah, DST, Eee,
// FV, K, L, R, Th: as the people's phonemes and modifiers are ordered), each variable matched by
// the phoneme it names, whatever its place among the graph's variables.

describe('creature lip sync (data order)', () => {
  it('matches the variables by phoneme, not by their order in the graph', () => {
    const shuffled = ['LipTh', 'LipGain', 'LipR', 'LipBigAah', 'LipL', 'LipK', 'LipFV', 'LipEee'];
    expect(creatureLipVariables([...shuffled, 'LipDST'].map((name) => ({ name })))).toEqual([
      'LipBigAah',
      'LipDST',
      'LipEee',
      'LipFV',
      'LipK',
      'LipL',
      'LipR',
      'LipTh',
    ]);
  });

  it('the rieklings’ names (LipAA, LipEE, LipFF, LipTH) name the same phonemes', () => {
    const riekling = ['LipTH', 'LipAA', 'LipDST', 'LipEE', 'LipFF', 'LipK', 'LipL', 'LipR'];
    expect(creatureLipVariables(riekling.map((name) => ({ name })))).toEqual([
      'LipAA',
      'LipDST',
      'LipEE',
      'LipFF',
      'LipK',
      'LipL',
      'LipR',
      'LipTH',
    ]);
  });

  it('a graph missing a phoneme has no lip sync', () => {
    expect(creatureLipVariables(['LipBigAah', 'LipDST'].map((name) => ({ name })))).toBe(undefined);
  });
});

describe.skipIf(!hasGamedata())('creature lip sync of the load order (data)', () => {
  const projects = new Map<string, string[] | undefined>();
  let curves: Float32Array[] = [];

  beforeAll(async () => {
    const vfs = await Vfs.mount(openGameFolder());
    const read = (path: string): Promise<Uint8Array> => vfs.read(path);
    for (const project of [
      'meshes\\actors\\dragon\\dragonproject.hkx',
      'meshes\\actors\\hagraven\\hagravenproject.hkx',
      'meshes\\actors\\dlc02\\riekling\\rieklingproject.hkx',
    ]) {
      const behavior = (await loadCharacterInfo(project, read)).behavior ?? '';
      const { root } = await loadBehaviorFiles(project, behavior, read);
      projects.set(project, creatureLipVariables(root.variables));
    }
    // Paarthurnax: "Hurt him while he is grounded!"
    const fuz = await read('sound\\voice\\skyrim.esm\\cruniquepaarthurnax\\mq206__000c64f9_1.fuz');
    const lipSize = new DataView(fuz.buffer, fuz.byteOffset, fuz.byteLength).getUint32(8, true);
    const lip = parseLip(fuz.subarray(12, 12 + lipSize));
    expect(lip.curves).toBe(CREATURE_LIP_CURVES);
    curves = [];
    for (let frame = 0; frame < lip.frames; frame++) {
      const at = frame * lip.curves;
      curves.push(lip.values.slice(at, at + CREATURE_LIP_CURVES));
    }
    await vfs.close();
  }, 600_000);

  it('the dragons’, hagravens’ and rieklings’ graphs name all eight phonemes', () => {
    expect(projects.get('meshes\\actors\\dragon\\dragonproject.hkx')).toEqual([
      'LipBigAah',
      'LipDST',
      'LipEee',
      'LipFV',
      'LipK',
      'LipL',
      'LipR',
      'LipTh',
    ]);
    expect(projects.get('meshes\\actors\\hagraven\\hagravenproject.hkx')).toEqual(
      projects.get('meshes\\actors\\dragon\\dragonproject.hkx'),
    );
    expect(projects.get('meshes\\actors\\dlc02\\riekling\\rieklingproject.hkx')).toEqual([
      'LipAA',
      'LipDST',
      'LipEE',
      'LipFF',
      'LipK',
      'LipL',
      'LipR',
      'LipTH',
    ]);
  });

  it('a line’s curves are in that order: “while” is its one L, it has no Th, its R comes first', () => {
    const curve = (phoneme: string): number =>
      CREATURE_LIP_PHONEMES.indexOf(phoneme as (typeof CREATURE_LIP_PHONEMES)[number]);
    const runs = (index: number): number => {
      let count = 0;
      let on = false;
      for (const frame of curves) {
        const active = (frame[index] ?? 0) > 0.05;
        if (active && !on) count++;
        on = active;
      }
      return count;
    };
    expect(runs(curve('L'))).toBe(1);
    expect(runs(curve('Th'))).toBe(0);
    // "Hurt": past the breath's DST, the R is the first other curve that rises.
    const firstOf = (index: number): number =>
      curves.findIndex((frame) => (frame[index] ?? 0) > 0.05);
    const others = [0, 2, 3, 4, 5, 7].map(firstOf).filter((frame) => frame >= 0);
    expect(firstOf(curve('R'))).toBeLessThan(Math.min(...others));
  });
});
