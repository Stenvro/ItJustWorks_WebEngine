import { describe, expect, it } from 'vitest';
import {
  angleOff,
  detectionLevel,
  detectionReach,
  detectionSettingNames,
  detectsAt,
  distanceAttenuation,
  eventLevel,
  loudness,
  movementNoise,
  noticesAt,
  readDetectionSettings,
  sightReach,
  SoundLevel,
  type DetectionInput,
  type Observer,
  type Target,
} from './detection.ts';

/** The detection settings Skyrim.esm stores (`node tools/gmst-info.ts --ai`). */
const SKYRIM_ESM: Readonly<Record<string, number>> = {
  fsneakactionmult: 2,
  fsneakalertmod: 0,
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
  fsneaksoundlosmult: 0.3,
  fsneaksoundsmult: 1,
  fdetectionsneaklightmod: 15,
  ilightlevelinteriormod: 25,
  ilightlevelmax: 300,
  isoundlevelsilent: 10,
};
const settings = readDetectionSettings({ number: (id) => SKYRIM_ESM[id.toLowerCase()] });

/** A guard: Sneak 25, awake, not alerted. */
const guard: Observer = {
  skill: 25,
  sleeping: false,
  alerted: false,
  combatTarget: false,
  blindness: 0,
  nightEye: false,
};

/** The player standing still, sneaking with Sneak 15, in light leather (weight 20), dim light. */
const player: Target = {
  moving: false,
  running: false,
  sneaking: true,
  inCombat: false,
  swimming: false,
  skill: 15,
  armourWeight: 20,
  noiseMult: 1,
  actionSound: 0,
  light: 20,
  size: 1,
  invisible: false,
};

/** The guard looking at the player 500 units away, inside. */
const facing: DetectionInput = {
  observer: guard,
  target: player,
  distance: 500,
  reach: 2500,
  exterior: false,
  lineOfSight: true,
  seen: true,
};

const level = (input: Partial<DetectionInput>, target: Partial<Target> = {}): number =>
  detectionLevel(settings, { ...facing, ...input, target: { ...player, ...target } }).level;

describe('detection settings', () => {
  it("take the load order's values over the engine's built-in ones", () => {
    expect(settings.skillMult).toBe(0.5);
    expect(settings.soundLosMult).toBe(0.3);
    expect(settings.soundLevels).toEqual([100, 50, 10, 200]);
    // Not in Skyrim.esm: the engine's own.
    expect(settings.equippedWeightBase).toBe(12);
    expect(settings.viewCone).toBe(190);
    expect(settings.noticeMin).toBe(-20);
    expect(settings.sizeMults).toEqual([0.5, 1, 1.5, 2]);
    const builtIn = readDetectionSettings();
    expect(builtIn.skillMult).toBe(0.4);
    expect(builtIn.soundLosMult).toBe(0.4);
    expect(detectionSettingNames()).toContainEqual(['fDetectionViewCone', 190]);
    expect(detectionSettingNames()).toContainEqual(['iSoundLevelVeryLoud', 200]);
  });

  it('give a sound level its loudness, an unknown one a normal one', () => {
    expect(loudness(settings, SoundLevel.loud)).toBe(100);
    expect(loudness(settings, SoundLevel.silent)).toBe(10);
    expect(loudness(settings, 7)).toBe(50);
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

  it('see straight ahead as far as detection reaches, aside less, behind not at all', () => {
    const degrees = (value: number): number => (value * Math.PI) / 180;
    expect(sightReach(settings, degrees(0), 2500, false)).toBe(2500);
    expect(sightReach(settings, degrees(30), 2500, false)).toBe(2500);
    // Beyond fDetectionLOSDistanceAngle's half (30°): 0.75 inside, 0.5 outside.
    expect(sightReach(settings, degrees(60), 2500, false)).toBe(1875);
    expect(sightReach(settings, degrees(60), 5000, true)).toBe(2500);
    // The view cone's edge is 95° off (190° in all).
    expect(sightReach(settings, degrees(94), 2500, false)).toBe(1875);
    expect(sightReach(settings, degrees(96), 2500, false)).toBe(0);
    expect(sightReach(settings, degrees(180), 2500, false)).toBe(0);
  });

  it('measure the angle off the way an observer faces', () => {
    // Facing north: a point to the east is a right angle off, one south half a turn.
    expect(angleOff(0, [0, 0], [100, 0])).toBeCloseTo(Math.PI / 2, 9);
    expect(angleOff(0, [0, 0], [0, -100])).toBeCloseTo(Math.PI, 9);
    // Facing east (π/2): east is straight ahead, north a right angle off.
    expect(angleOff(Math.PI / 2, [0, 0], [100, 0])).toBeCloseTo(0, 9);
    expect(angleOff(Math.PI / 2, [0, 0], [0, 100])).toBeCloseTo(Math.PI / 2, 9);
    expect(angleOff(-3, [0, 0], [0, -100])).toBeCloseTo(Math.PI - 3, 9);
  });
});

describe('the detection formula', () => {
  it('adds the base, the attenuated sound and sight, and the skills', () => {
    const result = detectionLevel(settings, facing);
    const attenuation = (2000 / 2500) ** 2;
    // Standing still: no sound. Sight: 0.33 × (15 + 20) × 1 × 1 × 1.
    const visual = 0.33 * 35;
    // The guard's perception 25, attenuated, less the player's Sneak 15, × 0.5.
    const skill = 0.5 * (25 * attenuation - 15);
    expect(result.inReach).toBe(true);
    expect(result.attenuation).toBeCloseTo(attenuation, 9);
    expect(result.sound).toBe(0);
    expect(result.visual).toBeCloseTo(visual, 9);
    expect(result.skill).toBeCloseTo(skill, 9);
    expect(result.level).toBeCloseTo(-15 + attenuation * visual + skill, 9);
    // In view in dim light, still and sneaking: noticed, not detected.
    expect(noticesAt(settings, result.level)).toBe(true);
    expect(detectsAt(settings, result.level)).toBe(false);
  });

  it('rises with the light on the target, less outside', () => {
    const dark = level({}, { light: 0 });
    const lit = level({}, { light: 100 });
    const attenuation = (2000 / 2500) ** 2;
    expect(lit - dark).toBeCloseTo(attenuation * 0.33 * 100, 9);
    // Outside: fSneakLightExteriorMult halves the light's weight (at the same attenuation).
    const outside = (light: number): number =>
      level({ exterior: true, reach: 5250, distance: 1050 }, { light });
    expect(outside(100) - outside(0)).toBeCloseTo(attenuation * 0.33 * 0.5 * 100, 9);
    // Night eye sees the light fDetectionNightEyeBonus times as bright.
    const nightEye = detectionLevel(settings, {
      ...facing,
      observer: { ...guard, nightEye: true },
    });
    expect(nightEye.visual).toBeCloseTo(0.33 * (15 + 20 * 3), 9);
  });

  it('falls with distance, and does not reach beyond the reach', () => {
    const near = level({ distance: 100 });
    const middle = level({ distance: 1000 });
    const far = level({ distance: 2000 });
    expect(near).toBeGreaterThan(middle);
    expect(middle).toBeGreaterThan(far);
    const beyond = detectionLevel(settings, { ...facing, distance: 2600 });
    expect(beyond.inReach).toBe(false);
    expect(beyond.attenuation).toBe(0);
  });

  it('sees only what is in the view cone and in the line of sight', () => {
    const behind = detectionLevel(settings, { ...facing, seen: false });
    expect(behind.visual).toBe(0);
    expect(behind.level).toBeLessThan(level({}));
    // Asleep, it does not see either.
    const asleep = detectionLevel(settings, { ...facing, observer: { ...guard, sleeping: true } });
    expect(asleep.visual).toBe(0);
    // Blind, half as well; invisible, not at all (fSneakStealthBoyMult 0).
    const blind = detectionLevel(settings, { ...facing, observer: { ...guard, blindness: 50 } });
    expect(blind.visual).toBeCloseTo(0.33 * 35 * 0.5, 9);
    expect(
      detectionLevel(settings, { ...facing, target: { ...player, invisible: true } }).visual,
    ).toBe(0);
    // A giant (extra large) is seen twice as well, a rabbit (small) half as well.
    expect(
      detectionLevel(settings, { ...facing, target: { ...player, size: 3 } }).visual,
    ).toBeCloseTo(0.33 * 35 * 2, 9);
    expect(
      detectionLevel(settings, { ...facing, target: { ...player, size: 0 } }).visual,
    ).toBeCloseTo(0.33 * 35 * 0.5, 9);
  });

  it("weighs the target's Sneak skill only while it sneaks out of combat", () => {
    // Each point of Sneak lowers the level by fSneakSkillMult.
    expect(level({}, { skill: 15 }) - level({}, { skill: 65 })).toBeCloseTo(25, 9);
    // Not sneaking (or in combat), its skill does not count.
    expect(level({}, { sneaking: false, skill: 15 })).toBeCloseTo(
      level({}, { sneaking: false, skill: 100 }),
      9,
    );
    expect(level({}, { inCombat: true, skill: 100 })).toBeCloseTo(
      level({}, { sneaking: false }),
      9,
    );
    // The observer's perception: its Sneak, attenuated, clamped to fSneakPerceptionSkillMax.
    const keen = detectionLevel(settings, { ...facing, observer: { ...guard, skill: 150 } });
    const best = detectionLevel(settings, { ...facing, observer: { ...guard, skill: 100 } });
    expect(keen.level).toBeCloseTo(best.level, 9);
    // In combat with the target its perception falls by fSneakCombatMod.
    const fighting = detectionLevel(settings, {
      ...facing,
      observer: { ...guard, combatTarget: true },
    });
    expect(fighting.skill).toBeCloseTo(0.5 * (25 * 0.6 * 0.64 - 15), 9);
  });

  it('hears the target move: louder in heavier armour and running, less unseen', () => {
    const attenuation = (2000 / 2500) ** 2;
    const walking = detectionLevel(settings, { ...facing, target: { ...player, moving: true } });
    // fSneakEquippedWeightBase + fSneakEquippedWeightMult × the armour's weight.
    expect(walking.sound).toBeCloseTo(12 + 0.5 * 20, 9);
    // Moving makes it a little easier to see too (fSneakLightMoveMult).
    expect(walking.visual).toBeCloseTo(0.33 * 35 * 1.01, 9);
    const plate = detectionLevel(settings, {
      ...facing,
      target: { ...player, moving: true, armourWeight: 60 },
    });
    expect(plate.sound).toBeCloseTo(12 + 30, 9);
    expect(plate.level - walking.level).toBeCloseTo(attenuation * 20, 9);
    const running = detectionLevel(settings, {
      ...facing,
      target: { ...player, moving: true, running: true },
    });
    expect(running.sound).toBeCloseTo(2 * 22, 9);
    expect(running.visual).toBeCloseTo(0.33 * 35 * 1.21, 9);
    // Muffled (MovementNoiseMult 0.5: the enchantment, Muffled Movement) half as loud, the Muffle
    // spell or Silence (1) silent; swimming silent.
    expect(movementNoise(0)).toBe(1);
    expect(movementNoise(0.5)).toBe(0.5);
    expect(movementNoise(1)).toBe(0);
    expect(movementNoise(1.5)).toBe(0);
    expect(
      detectionLevel(settings, {
        ...facing,
        target: { ...player, moving: true, noiseMult: movementNoise(1) },
      }).sound,
    ).toBe(0);
    expect(
      detectionLevel(settings, { ...facing, target: { ...player, moving: true, noiseMult: 0.5 } })
        .sound,
    ).toBeCloseTo(11, 9);
    expect(
      detectionLevel(settings, { ...facing, target: { ...player, moving: true, swimming: true } })
        .sound,
    ).toBe(0);
    // Without line of sight: fSneakSoundLosMult of the sound, and no sight.
    const unseen = detectionLevel(settings, {
      ...facing,
      lineOfSight: false,
      seen: false,
      target: { ...player, moving: true },
    });
    expect(unseen.sound).toBeCloseTo(22 * 0.3, 9);
    expect(unseen.visual).toBe(0);
  });

  it("hears the target's actions by their sound level", () => {
    const swing = detectionLevel(settings, {
      ...facing,
      target: { ...player, actionSound: loudness(settings, SoundLevel.normal) },
    });
    expect(swing.sound).toBeCloseTo(50 * 2, 9);
    expect(detectsAt(settings, swing.level)).toBe(true);
    const dagger = detectionLevel(settings, {
      ...facing,
      target: { ...player, actionSound: loudness(settings, SoundLevel.silent) },
    });
    expect(dagger.sound).toBeCloseTo(10 * 2, 9);
  });

  it('detects above 0, in combat with the target above iAICombatMinDetection', () => {
    expect(detectsAt(settings, 0.1)).toBe(true);
    expect(detectsAt(settings, 0)).toBe(false);
    expect(detectsAt(settings, -40)).toBe(false);
    expect(detectsAt(settings, -40, true)).toBe(true);
    expect(noticesAt(settings, -19)).toBe(true);
    expect(noticesAt(settings, -20)).toBe(false);
  });

  it('a sneaking expert is not detected in the dark where a novice in daylight would be', () => {
    const expert = level({ distance: 300 }, { skill: 100, light: 10 });
    const novice = level({ distance: 300 }, { skill: 15, light: 150, sneaking: false });
    expect(detectsAt(settings, expert)).toBe(false);
    expect(noticesAt(settings, expert)).toBe(false);
    expect(detectsAt(settings, novice)).toBe(true);
  });
});

describe('detection events', () => {
  it('carry fDetectEventDistancePlayer from the player, fDetectEventDistanceNPC from others', () => {
    const heard = (byPlayer: boolean, soundLevel: number, distance: number) =>
      eventLevel(settings, { soundLevel, byPlayer, sneaking: false }, guard, distance, true);
    expect(heard(true, SoundLevel.normal, 0).reach).toBe(1536);
    expect(heard(false, SoundLevel.normal, 0).reach).toBe(512);
    expect(heard(false, SoundLevel.veryLoud, 0).reach).toBe(1024);
    expect(
      eventLevel(
        settings,
        { soundLevel: SoundLevel.veryLoud, byPlayer: true, sneaking: true },
        guard,
        0,
        true,
      ).reach,
    ).toBe(3072);
    // A normal noise right beside it is noticed; beyond its reach it is not heard at all.
    expect(noticesAt(settings, heard(true, SoundLevel.normal, 100).level)).toBe(true);
    expect(heard(false, SoundLevel.normal, 600).level).toBe(-Infinity);
    // Louder is heard better; unheard in the line of sight less.
    expect(heard(true, SoundLevel.loud, 500).level).toBeGreaterThan(
      heard(true, SoundLevel.normal, 500).level,
    );
    expect(
      eventLevel(settings, { soundLevel: 1, byPlayer: true, sneaking: false }, guard, 500, false)
        .level,
    ).toBeLessThan(heard(true, SoundLevel.normal, 500).level);
  });
});
