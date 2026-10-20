// Projectiles (PROJ) and explosions (EXPL): what a spell, a staff, a shout or a bow sends
// flying and what bursts where it lands. A magic effect names both (MGEF DATA @72, @76); a
// projectile may name its own explosion. Layouts after xEdit's wbDefinitionsTES5 (PROJ DATA,
// 92 bytes: flags, type, gravity, speed, range, light, muzzle flash light, tracer chance,
// proximity and timer of the alternative trigger, explosion, sound, muzzle flash duration, fade
// duration, impact force, countdown and disable sounds, default weapon source, cone spread,
// collision radius, lifetime, relaunch interval, decal data, collision layer; MODL, NAM1 the
// muzzle flash model, VNAM its sound level; EXPL DATA, 52 bytes: light, sounds, impact data set,
// placed object, spawn projectile, force, damage, radius, image-space radius, vertical offset
// mult, flags, sound level; EITM the enchantment or spell it applies, MNAM its image-space
// modifier, MODL its model) and CommonLibSSE (BGSProjectileData, BGSExplosionData).
// Platform-independent. Notes: docs/formats/esm.md ("Projectiles and explosions").

import { view } from '../formats/esm/fields.ts';
import type { GameRecord } from './record-db.ts';

type RecordSource = Pick<
  GameRecord,
  'formId' | 'editorId' | 'fields' | 'formIdAt' | 'formIdField' | 'text'
>;

/** PROJ DATA flags (xEdit). */
export const ProjectileFlag = {
  hitscan: 0x1,
  explosion: 0x2,
  altTrigger: 0x4,
  muzzleFlash: 0x8,
  canBeDisabled: 0x20,
  canBePickedUp: 0x40,
  supersonic: 0x80,
  pinsLimbs: 0x100,
  passThroughSmallTransparent: 0x200,
  disableCombatAimCorrection: 0x400,
} as const;

/** PROJ DATA types (xEdit; CommonLibSSE BGSProjectileData::Type). */
export const ProjectileType = {
  missile: 0x1,
  lobber: 0x2,
  beam: 0x4,
  flame: 0x8,
  cone: 0x10,
  barrier: 0x20,
  arrow: 0x40,
} as const;

/** The types' names, for tools and logs. */
export function projectileTypeName(type: number): string {
  const entry = Object.entries(ProjectileType).find(([, bit]) => bit === type);
  return entry?.[0] ?? `0x${type.toString(16)}`;
}

export interface ProjectileRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly flags: number;
  readonly type: number;
  /** Times the world's gravity (0: it flies straight). */
  readonly gravity: number;
  /** Game units per second. */
  readonly speed: number;
  /** Game units it flies before it fades (or bursts). */
  readonly range: number;
  /** LIGH: the light it carries, and its muzzle flash's. */
  readonly light: number | undefined;
  readonly muzzleFlashLight: number | undefined;
  readonly tracerChance: number;
  /** The alternative trigger: it bursts within this of an actor, or after this many seconds. */
  readonly proximity: number;
  readonly timer: number;
  /** EXPL: what bursts where it lands (with the Explosion flag). */
  readonly explosion: number | undefined;
  /** SNDR: the sound it makes while it flies. */
  readonly sound: number | undefined;
  readonly muzzleFlashDuration: number;
  readonly fadeDuration: number;
  /** How hard it pushes what it hits. */
  readonly impactForce: number;
  readonly countdownSound: number | undefined;
  readonly disableSound: number | undefined;
  readonly defaultWeaponSource: number | undefined;
  /** Cone projectiles: the cone's half angle (degrees, as xEdit names "Cone Spread"). */
  readonly coneSpread: number;
  /** Units: how thick it is against what it hits. */
  readonly collisionRadius: number;
  /** Seconds it lives at most (0: its range decides). */
  readonly lifetime: number;
  /** Seconds between the sprays of a flame or a beam held (concentration). */
  readonly relaunchInterval: number;
  readonly decal: number | undefined;
  readonly collisionLayer: number | undefined;
  /** MODL: what is drawn of it; NAM1: its muzzle flash. */
  readonly model: string | undefined;
  readonly muzzleFlashModel: string | undefined;
  /** VNAM: how loud for detection (0 loud, 1 normal, 2 silent, 3 very loud). */
  readonly soundLevel: number;
}

export function parseProjectile(record: RecordSource): ProjectileRecord {
  const data = record.fields.first('DATA');
  const d = data ? view(data) : undefined;
  const f32 = (at: number): number =>
    d && data && data.length >= at + 4 ? d.getFloat32(at, true) : 0;
  const form = (at: number): number | undefined => {
    if (!data || data.length < at + 4) return undefined;
    const formId = record.formIdAt(data, at);
    return formId === 0 ? undefined : formId;
  };
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    flags: d && data && data.length >= 2 ? d.getUint16(0, true) : 0,
    type: d && data && data.length >= 4 ? d.getUint16(2, true) : 0,
    gravity: f32(4),
    speed: f32(8),
    range: f32(12),
    light: form(16),
    muzzleFlashLight: form(20),
    tracerChance: f32(24),
    proximity: f32(28),
    timer: f32(32),
    explosion: form(36),
    sound: form(40),
    muzzleFlashDuration: f32(44),
    fadeDuration: f32(48),
    impactForce: f32(52),
    countdownSound: form(56),
    disableSound: form(60),
    defaultWeaponSource: form(64),
    coneSpread: f32(68),
    collisionRadius: f32(72),
    lifetime: f32(76),
    relaunchInterval: f32(80),
    decal: form(84),
    collisionLayer: form(88),
    model: record.fields.zstring('MODL'),
    muzzleFlashModel: record.fields.zstring('NAM1'),
    soundLevel: record.fields.u32('VNAM') ?? 1,
  };
}

/** EXPL DATA flags (xEdit). */
export const ExplosionFlag = {
  alwaysUsesWorldOrientation: 0x2,
  knockDownAlways: 0x4,
  knockDownByFormula: 0x8,
  ignoreLosCheck: 0x10,
  pushSourceRefOnly: 0x20,
  ignoreImageSpaceSwap: 0x40,
  chain: 0x80,
  noControllerVibration: 0x100,
} as const;

export interface ExplosionRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly light: number | undefined;
  /** SNDR: its sounds (the second where the first is silent: the engine plays both). */
  readonly sound: number | undefined;
  readonly sound2: number | undefined;
  /** IPDS: the impact on the surfaces it bursts against. */
  readonly impactDataSet: number | undefined;
  /** What it leaves (a hazard, an object). */
  readonly placedObject: number | undefined;
  /** PROJ: what it sends flying in turn. */
  readonly spawnProjectile: number | undefined;
  /** How hard it pushes what is within its radius. */
  readonly force: number;
  /** Health it takes from actors within its radius (traps' explosions). */
  readonly damage: number;
  /** Units. */
  readonly radius: number;
  /** Units: how far from it its image-space modifier shows. */
  readonly imageSpaceRadius: number;
  readonly verticalOffsetMult: number;
  readonly flags: number;
  readonly soundLevel: number;
  /** EITM: the enchantment or spell it puts on actors within its radius. */
  readonly enchantment: number | undefined;
  readonly imageSpaceModifier: number | undefined;
  readonly model: string | undefined;
}

export function parseExplosion(record: RecordSource): ExplosionRecord {
  const data = record.fields.first('DATA');
  const d = data ? view(data) : undefined;
  const f32 = (at: number): number =>
    d && data && data.length >= at + 4 ? d.getFloat32(at, true) : 0;
  const u32 = (at: number): number =>
    d && data && data.length >= at + 4 ? d.getUint32(at, true) : 0;
  const form = (at: number): number | undefined => {
    if (!data || data.length < at + 4) return undefined;
    const formId = record.formIdAt(data, at);
    return formId === 0 ? undefined : formId;
  };
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    light: form(0),
    sound: form(4),
    sound2: form(8),
    impactDataSet: form(12),
    placedObject: form(16),
    spawnProjectile: form(20),
    force: f32(24),
    damage: f32(28),
    radius: f32(32),
    imageSpaceRadius: f32(36),
    verticalOffsetMult: f32(40),
    flags: u32(44),
    soundLevel: u32(48),
    enchantment: record.formIdField('EITM'),
    imageSpaceModifier: record.formIdField('MNAM'),
    model: record.fields.zstring('MODL'),
  };
}
