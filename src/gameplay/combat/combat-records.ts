// What combat reads of the records: a weapon's combat data (WEAP DNAM, CRDT, its impact data
// sets, sounds and models), ammunition (AMMO DATA) and the projectile it flies as (PROJ DATA),
// what a race gives hits (RACE NAM4 the material its flesh is, NAM5 the impact data set of its
// unarmed attacks), and the killmove camera's paths and shots (CPTH, CAMS). Layouts: xEdit's
// wbDefinitionsTES5 (WEAP, AMMO, PROJ, RACE, CPTH, CAMS), UESP "Skyrim Mod:Mod File Format".
// Platform-independent. Notes: docs/ai.md ("Combat").

import { view } from '../../formats/esm/fields.ts';
import { conditionAt, type Condition } from '../../scripting/conditions.ts';
import type { GameRecord } from '../../world/record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'fields' | 'formIdAt'>;

const f32 = (data: Uint8Array | undefined, at: number, fallback = 0): number =>
  data && data.length >= at + 4 ? view(data).getFloat32(at, true) : fallback;
const u32 = (data: Uint8Array | undefined, at: number): number =>
  data && data.length >= at + 4 ? view(data).getUint32(at, true) : 0;
const i32 = (data: Uint8Array | undefined, at: number, fallback = 0): number =>
  data && data.length >= at + 4 ? view(data).getInt32(at, true) : fallback;
const u16 = (data: Uint8Array | undefined, at: number): number =>
  data && data.length >= at + 2 ? view(data).getUint16(at, true) : 0;

const formAt = (
  record: Pick<RecordSource, 'formIdAt'>,
  data: Uint8Array | undefined,
  at = 0,
): number | undefined => {
  if (!data || data.length < at + 4) return undefined;
  const formId = record.formIdAt(data, at);
  return formId === 0 ? undefined : formId;
};
const formField = (record: RecordSource, type: string): number | undefined =>
  formAt(record, record.fields.first(type));

/** WEAP DNAM flags. */
export const WeaponFlag = {
  ignoresNormalWeaponResistance: 0x1,
  cantDrop: 0x8,
  embeddedWeapon: 0x20,
  nonPlayable: 0x80,
} as const;

/** WEAP DNAM flags 2. */
export const WeaponFlag2 = {
  playerOnly: 0x1,
  npcsUseAmmo: 0x2,
  minorCrime: 0x10,
  rangeFixed: 0x20,
  notUsedInNormalCombat: 0x40,
  nonHostile: 0x1000,
  boundWeapon: 0x2000,
} as const;

/** The sounds a weapon names (SNDR). */
export interface WeaponSounds {
  /** SNAM: a bow's or crossbow's shot. */
  readonly attack: number | undefined;
  readonly attack2D: number | undefined;
  readonly attackLoop: number | undefined;
  /**
   * TNAM ("Attack Fail Sound" in xEdit): every vanilla melee weapon names its swing here
   * (IronSword: WPNSwingBladeMediumSD) and has no SNAM, so it is what weaponSwing plays.
   */
  readonly swing: number | undefined;
  readonly idle: number | undefined;
  /** NAM9 / NAM8: drawing and sheathing it. */
  readonly equip: number | undefined;
  readonly unequip: number | undefined;
}

/** A weapon as combat uses it. */
export interface WeaponCombat {
  readonly formId: number;
  readonly editorId: string;
  /** DNAM animation type (WeaponType, src/world/item-records.ts). */
  readonly animType: number;
  /** DATA: base damage, weight, value. */
  readonly damage: number;
  readonly weight: number;
  readonly value: number;
  /** DNAM: animation speed and reach multipliers. */
  readonly speed: number;
  readonly reach: number;
  readonly flags: number;
  readonly flags2: number;
  readonly rangeMin: number;
  readonly rangeMax: number;
  readonly animationAttackMult: number;
  /** The skill it uses (actor value index; −1 none) and the resistance against it (−1). */
  readonly skill: number;
  readonly resist: number;
  /** DNAM @96: how much it staggers (UESP "Weapons": swords 0.75 .. warhammers 1.25). */
  readonly stagger: number;
  /** CRDT: critical damage, chance multiplier, effect (SPEL), only on death. */
  readonly critDamage: number;
  readonly critPercentMult: number;
  readonly critEffect: number | undefined;
  readonly critEffectOnDeath: boolean;
  /** MODL: the world (third-person) model; WNAM: the first-person model's STAT. */
  readonly model: string | undefined;
  readonly firstPersonModel: number | undefined;
  /** INAM: the impact data set its hits use; BIDS: its blocks' and bashes'. */
  readonly impactDataSet: number | undefined;
  readonly blockBashImpactDataSet: number | undefined;
  /** BAMT: the material it blocks as (MaterialBlockBlade1Hand). */
  readonly blockMaterial: number | undefined;
  readonly sounds: WeaponSounds;
  /** VNAM: how loud its use is (0 loud, 1 normal, 2 silent, 3 very loud). */
  readonly soundLevel: number;
  /** ETYP: the equip slot (RightHand, BothHands, ...). */
  readonly equipSlot: number | undefined;
  readonly keywords: readonly number[];
  /** CNAM: the weapon it is made from (its template). */
  readonly template: number | undefined;
}

const keywordsOf = (record: Pick<RecordSource, 'fields' | 'formIdAt'>): number[] =>
  record.fields
    .all('KWDA')
    .flatMap((kwda) =>
      Array.from({ length: Math.floor(kwda.length / 4) }, (_, i) => record.formIdAt(kwda, i * 4)),
    );

export function parseWeaponCombat(record: RecordSource): WeaponCombat {
  const data = record.fields.first('DATA');
  const dnam = record.fields.first('DNAM');
  const crdt = record.fields.first('CRDT');
  const animType = dnam?.[0] ?? 0;
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    animType,
    value: u32(data, 0),
    weight: f32(data, 4),
    damage: u16(data, 8),
    speed: f32(dnam, 4, 1),
    reach: f32(dnam, 8, 1),
    flags: u16(dnam, 12),
    rangeMin: f32(dnam, 28),
    rangeMax: f32(dnam, 32),
    flags2: u32(dnam, 40),
    animationAttackMult: f32(dnam, 44, 1),
    skill: dnam && dnam.length >= 80 ? i32(dnam, 76) : -1,
    resist: dnam && dnam.length >= 92 ? i32(dnam, 88) : -1,
    stagger: f32(dnam, 96),
    critDamage: u16(crdt, 0),
    critPercentMult: f32(crdt, 4),
    critEffectOnDeath: (crdt?.[8] ?? 0) !== 0,
    // SSE's CRDT is 24 bytes: the effect at 16 (the original's 16 bytes: at 12).
    critEffect: formAt(record, crdt, crdt && crdt.length >= 24 ? 16 : 12),
    model: record.fields.zstring('MODL'),
    firstPersonModel: formField(record, 'WNAM'),
    impactDataSet: formField(record, 'INAM'),
    blockBashImpactDataSet: formField(record, 'BIDS'),
    blockMaterial: formField(record, 'BAMT'),
    sounds: {
      attack: formField(record, 'SNAM'),
      attack2D: formField(record, 'XNAM'),
      attackLoop: formField(record, 'NAM7'),
      swing: formField(record, 'TNAM'),
      idle: formField(record, 'UNAM'),
      equip: formField(record, 'NAM9'),
      unequip: formField(record, 'NAM8'),
    },
    soundLevel: record.fields.u32('VNAM') ?? 1,
    equipSlot: formField(record, 'ETYP'),
    keywords: keywordsOf(record),
    template: formField(record, 'CNAM'),
  };
}

/** AMMO DATA flags. */
export const AmmoFlag = {
  ignoresNormalWeaponResistance: 0x1,
  nonPlayable: 0x2,
  /** An arrow (not a crossbow's bolt). */
  nonBolt: 0x4,
} as const;

/** AMMO: an arrow or bolt. */
export interface AmmoCombat {
  readonly formId: number;
  readonly editorId: string;
  /** DATA: the projectile it flies as (PROJ). */
  readonly projectile: number | undefined;
  readonly flags: number;
  readonly damage: number;
  readonly weight: number;
  /** MODL: its model (the quiver's, with the single arrow "Arrow:0" beside it). */
  readonly model: string | undefined;
  readonly keywords: readonly number[];
}

export function parseAmmo(record: RecordSource): AmmoCombat {
  const data = record.fields.first('DATA');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    projectile: formAt(record, data, 0),
    flags: u32(data, 4),
    damage: f32(data, 8),
    // SSE's DATA has the weight at 16 (the original's ends with the value).
    weight: f32(data, 16),
    model: record.fields.zstring('MODL'),
    keywords: keywordsOf(record),
  };
}

/** PROJ DATA flags. */
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
  rotation: 0x800,
} as const;

/** PROJ DATA types. */
export const ProjectileType = {
  missile: 0x1,
  lobber: 0x2,
  beam: 0x4,
  flame: 0x8,
  cone: 0x10,
  barrier: 0x20,
  arrow: 0x40,
} as const;

/** PROJ: how a projectile flies. */
export interface ProjectileCombat {
  readonly formId: number;
  readonly editorId: string;
  readonly flags: number;
  readonly type: number;
  /** Times the world's gravity (arrows: 0.35). */
  readonly gravity: number;
  /** Game units per second (arrows: 3600 .. 5400). */
  readonly speed: number;
  /** How far it flies before it is gone (game units). */
  readonly range: number;
  readonly light: number | undefined;
  readonly tracerChance: number;
  readonly explosion: number | undefined;
  /** Its sound in flight (SNDR). */
  readonly sound: number | undefined;
  readonly fadeDuration: number;
  /** The push it gives what it hits. */
  readonly impactForce: number;
  readonly collisionRadius: number;
  /** Seconds it lives (0: until it has flown its range). */
  readonly lifetime: number;
  readonly decal: number | undefined;
  readonly collisionLayer: number | undefined;
  /** MODL: what flies (an arrow's flight model, its tracer). */
  readonly model: string | undefined;
  /** VNAM: how loud it is. */
  readonly soundLevel: number;
}

export function parseProjectile(record: RecordSource): ProjectileCombat {
  const data = record.fields.first('DATA');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    flags: u16(data, 0),
    type: u16(data, 2),
    gravity: f32(data, 4),
    speed: f32(data, 8),
    range: f32(data, 12),
    light: formAt(record, data, 16),
    tracerChance: f32(data, 24),
    explosion: formAt(record, data, 36),
    sound: formAt(record, data, 40),
    fadeDuration: f32(data, 48),
    impactForce: f32(data, 52),
    collisionRadius: f32(data, 72),
    lifetime: f32(data, 76),
    decal: formAt(record, data, 84),
    collisionLayer: formAt(record, data, 88),
    model: record.fields.zstring('MODL'),
    soundLevel: record.fields.u32('VNAM') ?? 1,
  };
}

/** What a race gives hits: what its flesh is and what its unarmed blows do to others. */
export interface RaceHits {
  readonly formId: number;
  /** DATA @96, @100: its unarmed damage and reach. */
  readonly unarmedDamage: number;
  readonly unarmedReach: number;
  /** DATA @52: its mass (staggers). */
  readonly mass: number;
  /** NAM4: the material it is (blood: MaterialSkin, bone for skeletons, ...). */
  readonly material: number | undefined;
  /** NAM5: the impact data set of its unarmed attacks. */
  readonly impactDataSet: number | undefined;
  /** GNAM: its body part data (BPTD). */
  readonly bodyParts: number | undefined;
  /** NAM7: the decapitation effect (ARTO). */
  readonly decapitationFx: number | undefined;
}

export function parseRaceHits(record: RecordSource): RaceHits {
  const data = record.fields.first('DATA');
  return {
    formId: record.formId,
    unarmedDamage: f32(data, 96),
    unarmedReach: f32(data, 100),
    mass: f32(data, 52, 1),
    material: formField(record, 'NAM4'),
    impactDataSet: formField(record, 'NAM5'),
    bodyParts: formField(record, 'GNAM'),
    decapitationFx: formField(record, 'NAM7'),
  };
}

/** CAMS DATA action, location and target (xEdit). */
export const CameraAction = { shoot: 0, fly: 1, hit: 2, zoom: 3 } as const;
export const CameraSubject = { attacker: 0, projectile: 1, target: 2, leadActor: 3 } as const;
/** CAMS DATA flags. */
export const CameraShotFlag = {
  positionFollowsLocation: 0x1,
  rotationFollowsTarget: 0x2,
  dontFollowBone: 0x4,
  firstPersonCamera: 0x8,
  noTracer: 0x10,
  startAtTimeZero: 0x20,
} as const;

/** CAMS: one shot of a kill camera. */
export interface CameraShot {
  readonly formId: number;
  readonly editorId: string;
  /** MODL: the camera's animated path (meshes\cameras\*.nif). */
  readonly model: string | undefined;
  readonly action: number;
  readonly location: number;
  readonly target: number;
  readonly flags: number;
  /** How fast time runs for the player, the target and the world during the shot. */
  readonly playerTimeMult: number;
  readonly targetTimeMult: number;
  readonly globalTimeMult: number;
  readonly maxTime: number;
  readonly minTime: number;
  readonly targetPercentBetweenActors: number;
  readonly nearTargetDistance: number;
  /** MNAM: the image-space modifier during it. */
  readonly imageSpaceModifier: number | undefined;
}

export function parseCameraShot(record: RecordSource): CameraShot {
  const data = record.fields.first('DATA');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    model: record.fields.zstring('MODL'),
    action: u32(data, 0),
    location: u32(data, 4),
    target: u32(data, 8),
    flags: u32(data, 12),
    playerTimeMult: f32(data, 16, 1),
    targetTimeMult: f32(data, 20, 1),
    globalTimeMult: f32(data, 24, 1),
    maxTime: f32(data, 28),
    minTime: f32(data, 32),
    targetPercentBetweenActors: f32(data, 36),
    nearTargetDistance: f32(data, 40),
    imageSpaceModifier: formField(record, 'MNAM'),
  };
}

/** CPTH: a node of the kill cameras' tree, its conditions and its shots. */
export interface CameraPathRecord {
  readonly formId: number;
  readonly editorId: string;
  readonly conditions: readonly Condition[];
  /** ANAM: the path above it and the one before it among its siblings. */
  readonly parent: number | undefined;
  readonly previous: number | undefined;
  /** DATA: 0/128 default, 1/129 zoom disabled, 2/130 the shot list; bit 7: shots optional. */
  readonly zoom: number;
  readonly shots: readonly number[];
}

export function parseCameraPath(record: RecordSource): CameraPathRecord {
  const anam = record.fields.first('ANAM');
  const conditions: Condition[] = [];
  record.fields.list.forEach((field, index) => {
    if (field.type !== 'CTDA') return;
    const condition = conditionAt(record.fields.list, index, record);
    if (condition) conditions.push(condition);
  });
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    conditions,
    parent: formAt(record, anam, 0),
    previous: formAt(record, anam, 4),
    zoom: record.fields.first('DATA')?.[0] ?? 0,
    shots: record.fields
      .all('SNAM')
      .map((data) => record.formIdAt(data))
      .filter((formId) => formId !== 0),
  };
}
