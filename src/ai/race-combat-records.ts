// What a race and an actor base give combat and movement besides their look and stats: the
// attack data (ATKD / ATKE: one entry per attack animation event, with its damage, chance,
// angles, stagger, attack type and recovery), the race whose attacks an actor or race uses
// (ATKR), a race's default movement types (WKMV .. SPMV) and movement overrides (MTYP / SPED),
// the equipment it can use (VNAM), the DATA fields of movement and AI (acceleration, turning,
// aim tolerance, flight radius, size, the biped objects, mount offsets, Flags 2), and an
// NPC_'s override package lists (SPOR, OCOR, GWOR, ECOR), default package list (DPLT) and
// combat style (ZNAM). Layouts: xEdit's wbDefinitionsTES5 (RACE, NPC_, wbAttackData),
// CommonLibSSE (TESRace.h RACE_DATA, BGSAttackData.h, BGSOverridePackCollection.h), UESP
// "Skyrim Mod:Mod File Format/RACE". Platform-independent.
// Notes: docs/formats/esm.md ("Actors").

import { view, zstring } from '../formats/esm/fields.ts';
import { parseMovementType, type MovementType } from '../world/movement.ts';
import type { GameRecord } from '../world/record-db.ts';

type RecordSource = Pick<GameRecord, 'formId' | 'editorId' | 'flags' | 'fields' | 'formIdAt'>;

const formAt = (
  record: Pick<RecordSource, 'formIdAt'>,
  data: Uint8Array | undefined,
  offset = 0,
): number | undefined => {
  if (!data || data.length < offset + 4) return undefined;
  const formId = record.formIdAt(data, offset);
  return formId === 0 ? undefined : formId;
};
const formField = (record: RecordSource, type: string): number | undefined =>
  formAt(record, record.fields.first(type));

/**
 * ATKD flags (xEdit, UESP; CommonLibSSE names 0x8 kChargeAttack and adds 0x20
 * kContinuousAttack).
 */
export const AttackFlag = {
  ignoreWeapon: 0x1,
  bashAttack: 0x2,
  powerAttack: 0x4,
  leftAttack: 0x8,
  rotatingAttack: 0x10,
  continuousAttack: 0x20,
  /** "Override Data" (xEdit, CommonLibSSE kOverrideData). */
  overrideData: 0x80000000,
} as const;

/** ATKD (44 bytes) and the ATKE after it. */
export interface AttackData {
  /** ATKE: the behavior graph event that starts the attack ("attackStart", "bashStart", ...). */
  readonly event: string;
  readonly damageMult: number;
  readonly attackChance: number;
  /** SPEL or SHOU cast with the attack. */
  readonly spell: number | undefined;
  /** AttackFlag. */
  readonly flags: number;
  /** Degrees: how far off the attacker's facing the target may be for it to start the attack. */
  readonly attackAngle: number;
  /** Degrees: the arc the strike hits in. */
  readonly strikeAngle: number;
  readonly stagger: number;
  /** KYWD: the attack type (WeapTypeSword, ...). */
  readonly attackType: number | undefined;
  readonly knockdown: number;
  readonly recoveryTime: number;
  readonly staminaMult: number;
}

/** The ATKD / ATKE pairs of a RACE or NPC_, in record order (an ATKE right after its ATKD). */
export function parseAttacks(record: Pick<RecordSource, 'fields' | 'formIdAt'>): AttackData[] {
  const attacks: AttackData[] = [];
  let event = false;
  for (const { type, data } of record.fields.list) {
    if (type !== 'ATKE') event = false;
    if (type === 'ATKD' && data.length >= 44) {
      const v = view(data);
      attacks.push({
        event: '',
        damageMult: v.getFloat32(0, true),
        attackChance: v.getFloat32(4, true),
        spell: formAt(record, data, 8),
        flags: v.getUint32(12, true),
        attackAngle: v.getFloat32(16, true),
        strikeAngle: v.getFloat32(20, true),
        stagger: v.getFloat32(24, true),
        attackType: formAt(record, data, 28),
        knockdown: v.getFloat32(32, true),
        recoveryTime: v.getFloat32(36, true),
        staminaMult: v.getFloat32(40, true),
      });
      event = true;
    } else if (type === 'ATKE' && event) {
      const last = attacks.at(-1);
      if (last) attacks[attacks.length - 1] = { ...last, event: zstring(data) };
      event = false;
    }
  }
  return attacks;
}

/** RACE DATA flags AI and movement read (the look's are RaceFlag in world/actor-records.ts). */
export const RaceAiFlag = {
  immobile: 0x200,
  notPushable: 0x400,
  noCombatInWater: 0x800,
  noRotatingToHeadTrack: 0x1000,
  useHeadTrackAnims: 0x8000,
  regenHpInCombat: 0x80000,
  cantOpenDoors: 0x100000,
  allowPcDialogue: 0x200000,
  noKnockdowns: 0x400000,
  allowPickpocket: 0x800000,
  alwaysUseProxyController: 0x1000000,
  canPickupItems: 0x10000000,
  canDualWield: 0x40000000,
  avoidsRoads: 0x80000000,
} as const;

/** RACE DATA Flags 2 (at 124). */
export const RaceFlag2 = {
  useAdvancedAvoidance: 0x1,
  nonHostile: 0x2,
  allowMountedCombat: 0x10,
} as const;

/** RACE DATA size (at 64). */
export const RaceSize = { small: 0, medium: 1, large: 2, extraLarge: 3 } as const;

/** RACE record header flags. */
export const RaceRecordFlag = {
  /** Bit 19: "Critter?" (xEdit), kCritter "?" (CommonLibSSE). */
  critter: 0x80000,
} as const;

/** RACE VNAM: the equipment its members can use (bits 13+ are set in the data, unused). */
export const EquipmentFlag = {
  handToHandMelee: 0x1,
  oneHandSword: 0x2,
  oneHandDagger: 0x4,
  oneHandAxe: 0x8,
  oneHandMace: 0x10,
  twoHandSword: 0x20,
  twoHandAxe: 0x40,
  bow: 0x80,
  staff: 0x100,
  spell: 0x200,
  shield: 0x400,
  torch: 0x800,
  crossbow: 0x1000,
} as const;

/** WKMV .. SPMV: the race's movement type (MOVT) for each way of moving. */
export interface RaceMovementTypes {
  readonly walk: number | undefined;
  readonly run: number | undefined;
  readonly swim: number | undefined;
  readonly fly: number | undefined;
  readonly sneak: number | undefined;
  readonly sprint: number | undefined;
}

/** MTYP + SPED: a movement type's speeds as this race has them instead of the MOVT's. */
export interface RaceMovementOverride {
  readonly movementType: number;
  readonly speeds: Pick<MovementType, 'walk' | 'run' | 'rotateInPlace' | 'rotateWhileMoving'>;
}

type Vec3 = readonly [number, number, number];

/** DATA 128..163 (164-byte DATA only; xEdit's defaults otherwise). */
export interface RaceMountData {
  readonly mountOffset: Vec3;
  readonly dismountOffset: Vec3;
  readonly mountCameraOffset: Vec3;
}

export interface RaceCombat {
  readonly formId: number;
  readonly editorId: string;
  /** The record header's flags (RaceRecordFlag). */
  readonly recordFlags: number;
  /** DATA flags (RaceAiFlag; the look's RaceFlag). */
  readonly flags: number;
  /** DATA @56, @60: units per second². */
  readonly accelerationRate: number;
  readonly decelerationRate: number;
  /** DATA @64: RaceSize. */
  readonly size: number;
  /** DATA @68, @72, @80, @104: biped slots (30 head .. 61 FX01); undefined: none (−1). */
  readonly headBipedObject: number | undefined;
  readonly hairBipedObject: number | undefined;
  readonly shieldBipedObject: number | undefined;
  readonly bodyBipedObject: number | undefined;
  /** DATA @76: the health fraction (0..1) below which it counts as injured. */
  readonly injuredHealthPct: number;
  /** DATA @108. */
  readonly aimAngleTolerance: number;
  /** DATA @112 (UESP: unknown; xEdit, CommonLibSSE: flight radius). */
  readonly flightRadius: number;
  /** DATA @116, @120. */
  readonly angularAccelerationRate: number;
  readonly angularTolerance: number;
  /** DATA @124: RaceFlag2. */
  readonly flags2: number;
  readonly mount: RaceMountData;
  /** ATKR: the race whose attack data it uses. */
  readonly attackRace: number | undefined;
  readonly attacks: readonly AttackData[];
  readonly movementTypes: RaceMovementTypes;
  readonly movementOverrides: readonly RaceMovementOverride[];
  /** VNAM: EquipmentFlag. */
  readonly equipment: number;
}

/** xEdit's defaults of the mount data a 128-byte DATA leaves out. */
const MOUNT_DEFAULTS: RaceMountData = {
  mountOffset: [-63.479, 0, 0],
  dismountOffset: [-50, 0, 65],
  mountCameraOffset: [0, -300, 0],
};

const bipedSlot = (value: number): number | undefined => (value < 0 ? undefined : value + 30);

export function parseRaceCombat(record: RecordSource): RaceCombat {
  const data = record.fields.first('DATA');
  const d = data && data.length >= 128 ? view(data) : undefined;
  const f = (offset: number): number => d?.getFloat32(offset, true) ?? 0;
  const biped = (offset: number): number | undefined =>
    d ? bipedSlot(d.getInt32(offset, true)) : undefined;
  const vec = (offset: number): Vec3 => [f(offset), f(offset + 4), f(offset + 8)];
  const movementOverrides: RaceMovementOverride[] = [];
  let movementType: number | undefined;
  for (const { type, data: value } of record.fields.list) {
    if (type === 'MTYP') {
      movementType = formAt(record, value);
    } else if (type === 'SPED' && movementType !== undefined) {
      const sped = parseMovementType({
        formId: movementType,
        fields: { first: (field) => (field === 'SPED' ? value : undefined) },
      });
      movementOverrides.push({
        movementType,
        speeds: {
          walk: sped.walk,
          run: sped.run,
          rotateInPlace: sped.rotateInPlace,
          rotateWhileMoving: sped.rotateWhileMoving,
        },
      });
      movementType = undefined;
    }
  }
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    recordFlags: record.flags,
    flags: d?.getUint32(32, true) ?? 0,
    accelerationRate: f(56),
    decelerationRate: f(60),
    size: d?.getUint32(64, true) ?? RaceSize.medium,
    headBipedObject: biped(68),
    hairBipedObject: biped(72),
    injuredHealthPct: f(76),
    shieldBipedObject: biped(80),
    bodyBipedObject: biped(104),
    aimAngleTolerance: f(108),
    flightRadius: f(112),
    angularAccelerationRate: f(116),
    angularTolerance: f(120),
    flags2: d?.getUint32(124, true) ?? 0,
    mount:
      d && d.byteLength >= 164
        ? { mountOffset: vec(128), dismountOffset: vec(140), mountCameraOffset: vec(152) }
        : MOUNT_DEFAULTS,
    attackRace: formField(record, 'ATKR'),
    attacks: parseAttacks(record),
    movementTypes: {
      walk: formField(record, 'WKMV'),
      run: formField(record, 'RNMV'),
      swim: formField(record, 'SWMV'),
      fly: formField(record, 'FLMV'),
      sneak: formField(record, 'SNMV'),
      sprint: formField(record, 'SPMV'),
    },
    movementOverrides,
    equipment: record.fields.u32('VNAM') ?? 0,
  };
}

/** NPC_ SPOR / OCOR / GWOR / ECOR: package lists (FLST) that override its packages. */
export interface OverridePackageLists {
  readonly spectator: number | undefined;
  readonly observeCorpse: number | undefined;
  readonly guardWarn: number | undefined;
  readonly combat: number | undefined;
}

/**
 * What an NPC_ gives combat and AI. With a template, ATKR and the attacks come from it under
 * template flag 0x800 (attack data), the package lists under 0x400 (default package list), the
 * combat style under 0x10 (AI data) (UESP NPC_).
 */
export interface NpcCombat {
  readonly formId: number;
  /** ATKR: the race whose attack data it uses (the Creation Kit's "override from behavior graph"). */
  readonly attackRace: number | undefined;
  /** Its own attack data: each overrides the race's for its event (UESP). */
  readonly attacks: readonly AttackData[];
  readonly overridePackages: OverridePackageLists;
  /** DPLT: the default package list (FLST). */
  readonly defaultPackageList: number | undefined;
  /** ZNAM. */
  readonly combatStyle: number | undefined;
}

export function parseNpcCombat(record: RecordSource): NpcCombat {
  return {
    formId: record.formId,
    attackRace: formField(record, 'ATKR'),
    attacks: parseAttacks(record),
    overridePackages: {
      spectator: formField(record, 'SPOR'),
      observeCorpse: formField(record, 'OCOR'),
      guardWarn: formField(record, 'GWOR'),
      combat: formField(record, 'ECOR'),
    },
    defaultPackageList: formField(record, 'DPLT'),
    combatStyle: formField(record, 'ZNAM'),
  };
}
