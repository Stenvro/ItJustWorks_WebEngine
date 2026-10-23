import { describe, expect, it } from 'vitest';
import {
  angleOff,
  detectionLevel,
  detectionLight,
  detectionReach,
  detectionSettingNames,
  detectionSkill,
  detectsAt,
  distanceAttenuation,
  eventDistance,
  eventLevel,
  inViewCone,
  loudness,
  movementNoise,
  noticesAt,
  readDetectionSettings,
  sightReach,
  SoundLevel,
  wholeLevel,
  type DetectionInput,
  type Observer,
  type Target,
} from './detection.ts';

/** The detection settings Skyrim.esm stores (`node tools/gmst-info.ts --prefix fSneak`, ...). */
const SKYRIM_ESM: Readonly<Record<string, number>> = {
  fsneakactionmult: 2,
  fsneakalertmod: 0,
  fsneakambushnontargetmod: 0,
  fsneakbasevalue: -15,
  fsneakexteriordistancemult: 2.1,
  fsneakflyingdistancemult: 3,
  fsneaklightexteriormult: 0.5,
  fsneaklightmult: 0.33,
  fsneakmaxdistance: 2500,
  fsneakperceptionskillmax: 100,
  fsneakperceptionskillmin: 0,
  fsneakrunningmult: 2,
  fsneakskillmult: 0.5,
  fsneaksleepbonus: 0,
  fsneaksleepmod: 0,
  fsneaksoundlosmult: 0.3,
  fsneaksoundsmult: 1,
  fdetectionsneaklightmod: 15,
  fplayerdetectionsneakbase: 10,
  fplayerdetectionsneakmult: 0.4,
  ilightlevelinteriormod: 25,
  ilightlevelmax: 300,
  isoundlevelsilent: 10,
};
const settings = readDetectionSettings({ number: (id) => SKYRIM_ESM[id.toLowerCase()] });

/** A guard: Sneak 25, awake, not in combat. */
const guard: Observer = {
  skill: 25,
  sleeping: false,
  inCombat: false,
  otherThanTarget: false,
  blindness: 0,
};

/** The player standing still, not sneaking (Sneak 15), in light leather (weight 20), light 50. */
const player: Target = {
  moving: false,
  running: false,
  sneaking: false,
  skill: 15,
  armourWeight: 20,
  noiseMult: 1,
  actionSound: 0,
  light: 50,
  size: 1,
  invisible: false,
};

/** The guard looking at the player 400 units away, outside. */
const facing: DetectionInput = {
  observer: guard,
  target: player,
  distance: 400,
  reach: 5250,
  exterior: true,
  lineOfSight: true,
  seen: true,
};

/** ((5250 − 400) / 5250)²: the attenuation of `facing`. */
const A = (4850 / 5250) ** 2;

const result = (input: Partial<DetectionInput>, target: Partial<Target> = {}, guardIs = {}) =>
  detectionLevel(settings, {
    ...facing,
    ...input,
    observer: { ...guard, ...guardIs },
    target: { ...player, ...target },
  });

describe('detection settings', () => {
  it("take the load order's values over the engine's built-in ones", () => {
    expect(settings.skillMult).toBe(0.5);
    expect(settings.soundLosMult).toBe(0.3);
    expect(settings.playerSneakMult).toBe(0.4);
    expect(settings.soundLevels).toEqual([100, 50, 10, 200]);
    // Not in Skyrim.esm: the engine's own.
    expect(settings.equippedWeightBase).toBe(12);
    expect(settings.viewCone).toBe(190);
    expect(settings.combatMod).toBeCloseTo(-0.4, 6);
    expect(settings.combatNonTargetDistanceMult).toBe(0.75);
    expect(settings.sizeMults).toEqual([0.5, 1, 1.5, 2]);
    const builtIn = readDetectionSettings();
    expect(builtIn.baseValue).toBe(-25);
    expect(builtIn.maxDistance).toBe(1500);
    expect(builtIn.soundLosMult).toBe(0.25);
    expect(builtIn.playerSneakMult).toBe(1);
    expect(detectionSettingNames()).toContainEqual(['fDetectionViewCone', 190]);
    expect(detectionSettingNames()).toContainEqual(['iSoundLevelVeryLoud', 200]);
  });

  it('give a sound level its loudness, an unknown one a normal one', () => {
    expect(loudness(settings, SoundLevel.loud)).toBe(100);
    expect(loudness(settings, SoundLevel.silent)).toBe(10);
    expect(loudness(settings, 7)).toBe(50);
  });

  it("count the player's Sneak as fPlayerDetectionSneakMult × skill + Base", () => {
    expect(detectionSkill(settings, 50, true)).toBe(30);
    expect(detectionSkill(settings, 50, false)).toBe(50);
  });
});

describe('reach, distance and view cone', () => {
  it('reach fSneakMaxDistance inside, fSneakExteriorDistanceMult times it outside', () => {
    expect(detectionReach(settings, false)).toBe(2500);
    expect(detectionReach(settings, true)).toBeCloseTo(5250, 6);
    expect(detectionReach(settings, true, true)).toBeCloseTo(15750, 6);
  });

  it('attenuate by the square of what is left of the reach', () => {
    expect(distanceAttenuation(settings, 0, 2500)).toBe(1);
    expect(distanceAttenuation(settings, 1250, 2500)).toBeCloseTo(0.25, 9);
    expect(distanceAttenuation(settings, 2500, 2500)).toBe(0);
    expect(distanceAttenuation(settings, 4000, 2500)).toBe(0);
  });

  it('measure the angle off the facing (clockwise from north)', () => {
    expect(angleOff(0, [0, 0], [0, 100])).toBeCloseTo(0, 9);
    expect(angleOff(0, [0, 0], [100, 0])).toBeCloseTo(Math.PI / 2, 9);
    expect(angleOff(Math.PI / 2, [0, 0], [100, 0])).toBeCloseTo(0, 9);
    expect(angleOff(0, [0, 0], [0, -100])).toBeCloseTo(Math.PI, 9);
  });

  it('narrow the line of sight beyond fDetectionLOSDistanceAngle off the facing, evenly', () => {
    const degrees = (value: number): number => (value * Math.PI) / 180;
    expect(sightReach(settings, degrees(0), 2500, false)).toBe(2500);
    expect(sightReach(settings, degrees(60), 2500, false)).toBe(2500);
    // Half way from 60° to 180°: half way from 1 to fDetectionLOSDistanceMultInterior.
    expect(sightReach(settings, degrees(120), 2500, false)).toBeCloseTo(2187.5, 6);
    expect(sightReach(settings, degrees(180), 2500, false)).toBeCloseTo(1875, 6);
    expect(sightReach(settings, degrees(180), 5000, true)).toBeCloseTo(2500, 6);
    // Seen within half of fDetectionViewCone.
    expect(inViewCone(settings, degrees(94))).toBe(true);
    expect(inViewCone(settings, degrees(96))).toBe(false);
  });
});

describe('the detection formula (the engine’s)', () => {
  it('adds the base, the attenuated sight and the skills, a whole number', () => {
    const facingIt = result({});
    expect(facingIt.attenuation).toBeCloseTo(A, 9);
    expect(facingIt.sound).toBe(0);
    // Sight: A × (light × fSneakLightExteriorMult + fDetectionSneakLightMod).
    expect(facingIt.visual).toBeCloseTo(A * (50 * 0.5 + 15), 9);
    // Skills: A × perception × fSneakSkillMult.
    expect(facingIt.skill).toBeCloseTo(A * 25 * 0.5, 9);
    expect(facingIt.level).toBe(Math.trunc(-15 + A * 40 + A * 12.5));
    expect(facingIt.level).toBe(29);
    expect(detectsAt(facingIt.level)).toBe(true);
  });

  it('weighs the light inside by fSneakLightMult', () => {
    expect(result({ exterior: false }).visual).toBeCloseTo(A * (50 * 0.33 + 15), 9);
  });

  it('sees nothing out of the view cone or the line of sight, nor one invisible', () => {
    expect(result({ seen: false }).visual).toBe(0);
    expect(result({}, { invisible: true }).visual).toBe(0);
    // Blindness takes its share; asleep the observer sees nothing.
    expect(result({}, {}, { blindness: 50 }).visual).toBeCloseTo(A * 40 * 0.5, 9);
    expect(result({}, {}, { sleeping: true }).visual).toBe(0);
    // Size: fSneakDetectionSize*.
    expect(result({}, { size: 3 }).visual).toBeCloseTo(A * 40 * 2, 9);
  });

  it("weighs the target's Sneak skill whenever it sneaks", () => {
    expect(result({}, { sneaking: true }).skill).toBeCloseTo((A * 25 - 15) * 0.5, 9);
    expect(result({}, { sneaking: false, skill: 100 }).skill).toBeCloseTo(A * 25 * 0.5, 9);
  });

  it('hears the target move: louder in heavier armour and running, less without a line of sight', () => {
    const walking = result({}, { moving: true });
    // (fSneakEquippedWeightMult × armour + fSneakEquippedWeightBase) × fSneakSoundsMult × A.
    expect(walking.sound).toBeCloseTo((0.5 * 20 + 12) * A, 9);
    expect(result({}, { moving: true, running: true }).sound).toBeCloseTo(44 * A, 9);
    expect(result({ lineOfSight: false }, { moving: true }).sound).toBeCloseTo(22 * A * 0.3, 9);
    // Muffled: silent.
    expect(result({}, { moving: true, noiseMult: movementNoise(1) }).sound).toBe(0);
    // Moving shows: × (1 + fSneakLightMoveMult), running + fSneakLightRunMult.
    expect(walking.visual).toBeCloseTo(A * 40 * 1.01, 9);
    expect(result({}, { moving: true, running: true }).visual).toBeCloseTo(A * 40 * 1.21, 9);
  });

  it("hears the target's actions: int(fSneakActionMult) × loudness", () => {
    expect(result({}, { actionSound: 50 }).sound).toBeCloseTo(2 * 50 * A, 9);
  });

  it('perceives others than its combat target less (fSneakCombatMod)', () => {
    expect(result({}, {}, { otherThanTarget: true }).skill).toBeCloseTo(A * 25 * 0.6 * 0.5, 9);
    // In combat itself: fSneakAlertMod (0 in Skyrim.esm).
    expect(result({}, {}, { inCombat: true }).skill).toBeCloseTo(A * 25 * 0.5, 9);
  });

  it('an observer in ambush hears its target without a line of sight and watches it better', () => {
    const ambush = result({ lineOfSight: false }, { moving: true }, { ambush: 'target' });
    expect(ambush.sound).toBeCloseTo(22 * A, 9);
    expect(ambush.skill).toBeCloseTo(A * 25 * 3.5 * 0.5, 9);
  });

  it('a sneaking expert is not detected in the dark where a novice in daylight would be', () => {
    const expert = result({ distance: 800 }, { sneaking: true, skill: 80, light: 0 });
    const novice = result({ distance: 800 }, { sneaking: false, light: 80, moving: true });
    expect(detectsAt(expert.level)).toBe(false);
    expect(detectsAt(novice.level)).toBe(true);
  });

  it('rounds a level as the engine does', () => {
    expect(wholeLevel(0.3)).toBe(1);
    expect(wholeLevel(1.9)).toBe(1);
    expect(wholeLevel(-0.7)).toBe(0);
    expect(wholeLevel(-1.9)).toBe(-1);
  });

  it('notices above fSneakNoticeMin (the stealth eye)', () => {
    expect(noticesAt(settings, -19)).toBe(true);
    expect(noticesAt(settings, -21)).toBe(false);
  });
});

describe('the light detection weighs', () => {
  it('takes the mods off and stops at iLightLevelMax; night eye multiplies it first', () => {
    const outside = { nightEye: false, exterior: true, ambient: 0.5 };
    expect(detectionLight(settings, 80, outside)).toBe(80);
    // Inside: the lesser of iLightLevelInteriorMod and 100 × the ambient's brightest channel.
    expect(detectionLight(settings, 80, { ...outside, exterior: false })).toBe(55);
    expect(detectionLight(settings, 80, { ...outside, exterior: false, ambient: 0.1 })).toBe(70);
    expect(detectionLight(settings, 10, { ...outside, exterior: false })).toBe(0);
    expect(detectionLight(settings, 80, { ...outside, nightEye: true })).toBe(240);
    expect(detectionLight(settings, 200, { ...outside, nightEye: true })).toBe(300);
  });
});

describe('detection events', () => {
  it('carry fDetectEventDistancePlayer from the player, fDetectEventDistanceNPC from others', () => {
    expect(eventDistance(settings, 50, true)).toBe(1536);
    expect(eventDistance(settings, 50, false)).toBe(512);
    expect(eventDistance(settings, 200, false)).toBe(1024);
  });

  it('weigh the sound and the sight of the place, not the skills', () => {
    const near = { distance: 300, exterior: false, lineOfSight: true, seen: true };
    const attenuation = (2200 / 2500) ** 2;
    const heardAndSeen = eventLevel(settings, { loudness: 100 }, { sleeping: false }, near);
    expect(heardAndSeen).toBe(
      Math.trunc(-15 + 2 * 100 * attenuation + attenuation * (225 * 0.33 + 15)),
    );
    const unseen = eventLevel(
      settings,
      { loudness: 100 },
      { sleeping: false },
      { ...near, lineOfSight: false, seen: false },
    );
    expect(unseen).toBe(Math.trunc(-15 + 2 * 100 * attenuation * 0.3));
    // Very loud: attenuated over fDetectEventSneakDistanceVeryLoud.
    const far = { ...near, distance: 2600 };
    expect(eventLevel(settings, { loudness: 100 }, { sleeping: false }, far)).toBe(-15);
    expect(eventLevel(settings, { loudness: 200 }, { sleeping: false }, far)).toBeGreaterThan(-15);
  });
});
