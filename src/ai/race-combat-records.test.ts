import { describe, expect, it } from 'vitest';
import { Fields } from '../formats/esm/fields.ts';
import {
  AttackFlag,
  EquipmentFlag,
  parseAttacks,
  parseNpcCombat,
  parseRaceCombat,
  RaceAiFlag,
  RaceFlag2,
  RaceRecordFlag,
  RaceSize,
} from './race-combat-records.ts';

const u32s = (...values: number[]): Uint8Array => new Uint8Array(Uint32Array.from(values).buffer);
const f32s = (...values: number[]): Uint8Array => new Uint8Array(Float32Array.from(values).buffer);
const text = (value: string): Uint8Array => new TextEncoder().encode(`${value}\0`);
const record = (fields: [string, Uint8Array][], flags = 0) => {
  const list = new Fields(fields.map(([type, data]) => ({ type, data })));
  return {
    formId: 0x13746,
    editorId: list.zstring('EDID'),
    flags,
    fields: list,
    formIdAt: (data: Uint8Array, offset = 0) =>
      new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset, true),
  };
};

/** An ATKD: damage, chance, spell, flags, attack angle, strike angle, stagger, type, ... */
function atkd(values: {
  damage: number;
  chance: number;
  spell: number;
  flags: number;
  attackAngle: number;
  strikeAngle: number;
  stagger: number;
  type: number;
  knockdown: number;
  recovery: number;
  stamina: number;
}): Uint8Array {
  const data = new DataView(new ArrayBuffer(44));
  data.setFloat32(0, values.damage, true);
  data.setFloat32(4, values.chance, true);
  data.setUint32(8, values.spell, true);
  data.setUint32(12, values.flags, true);
  data.setFloat32(16, values.attackAngle, true);
  data.setFloat32(20, values.strikeAngle, true);
  data.setFloat32(24, values.stagger, true);
  data.setUint32(28, values.type, true);
  data.setFloat32(32, values.knockdown, true);
  data.setFloat32(36, values.recovery, true);
  data.setFloat32(40, values.stamina, true);
  return new Uint8Array(data.buffer);
}

const plain = {
  damage: 1,
  chance: 1,
  spell: 0,
  flags: 0,
  attackAngle: 0,
  strikeAngle: 35,
  stagger: 0,
  type: 0,
  knockdown: 0,
  recovery: 0,
  stamina: 1,
};

describe('attack data', () => {
  it('pair each ATKD with the ATKE after it', () => {
    const attacks = parseAttacks(
      record([
        ['ATKE', text('stray')],
        ['ATKD', atkd(plain)],
        ['ATKE', text('attackStart')],
        [
          'ATKD',
          atkd({
            ...plain,
            damage: 2,
            chance: 0.5,
            spell: 0x5a2b1,
            flags: AttackFlag.powerAttack | AttackFlag.leftAttack,
            attackAngle: -90,
            strikeAngle: 85,
            stagger: 1,
            type: 0x914e5,
            knockdown: 0.25,
            recovery: 1.5,
            stamina: 0.5,
          }),
        ],
        ['ATKE', text('attackPowerStartForwardLeftHand')],
        // An ATKD without its event.
        ['ATKD', atkd(plain)],
        ['NAM1', new Uint8Array(0)],
        ['ATKE', text('stray')],
      ]),
    );
    expect(attacks).toEqual([
      {
        event: 'attackStart',
        damageMult: 1,
        attackChance: 1,
        spell: undefined,
        flags: 0,
        attackAngle: 0,
        strikeAngle: 35,
        stagger: 0,
        attackType: undefined,
        knockdown: 0,
        recoveryTime: 0,
        staminaMult: 1,
      },
      {
        event: 'attackPowerStartForwardLeftHand',
        damageMult: 2,
        attackChance: 0.5,
        spell: 0x5a2b1,
        flags: 0xc,
        attackAngle: -90,
        strikeAngle: 85,
        stagger: 1,
        attackType: 0x914e5,
        knockdown: 0.25,
        recoveryTime: 1.5,
        staminaMult: 0.5,
      },
      expect.objectContaining({ event: '', strikeAngle: 35 }),
    ]);
  });
});

describe('race combat data', () => {
  /** A 164-byte RACE DATA with the AI's fields set. */
  function raceData(size = 164): Uint8Array {
    const data = new DataView(new ArrayBuffer(size));
    data.setUint32(32, 0x143 | RaceAiFlag.noCombatInWater | RaceAiFlag.canDualWield, true);
    data.setFloat32(56, 0.5, true); // acceleration
    data.setFloat32(60, 2, true); // deceleration
    data.setUint32(64, RaceSize.extraLarge, true);
    data.setInt32(68, 0, true); // head: slot 30
    data.setInt32(72, 1, true); // hair: slot 31
    data.setFloat32(76, 0.25, true); // injured
    data.setInt32(80, -1, true); // no shield
    data.setInt32(104, 2, true); // body: slot 32
    data.setFloat32(108, 41.75, true); // aim angle tolerance
    data.setFloat32(112, 400, true); // flight radius
    data.setFloat32(116, 0.25, true);
    data.setFloat32(120, 5, true);
    data.setUint32(124, RaceFlag2.useAdvancedAvoidance | RaceFlag2.allowMountedCombat, true);
    if (size >= 164) {
      [-113.875, 195.125, 0, -50, 0, 65, 0, -300, 0].forEach((value, i) => {
        data.setFloat32(128 + i * 4, value, true);
      });
    }
    return new Uint8Array(data.buffer);
  }

  it('read DATA, movement types, overrides, equipment and attacks', () => {
    const speeds = f32s(10, 20, 11, 21, 12, 22, 13, 23, 1.5, 2.5, 3.5);
    const race = parseRaceCombat(
      record(
        [
          ['EDID', text('DragonRace')],
          ['DATA', raceData()],
          ['MNAM', new Uint8Array(0)],
          ['ATKR', u32s(0x131f5)],
          ['ATKD', atkd(plain)],
          ['ATKE', text('attackStartBite')],
          ['MTYP', u32s(0x5a3d)],
          ['SPED', speeds],
          ['MTYP', u32s(0x5a3e)],
          ['VNAM', u32s(0xffffe000 | EquipmentFlag.handToHandMelee)],
          ['WKMV', u32s(0x5a3d)],
          ['RNMV', u32s(0x5a3d)],
          ['FLMV', u32s(0x5a41)],
          ['SPMV', u32s(0)],
        ],
        RaceRecordFlag.critter,
      ),
    );
    expect(race).toMatchObject({
      editorId: 'DragonRace',
      recordFlags: 0x80000,
      flags: 0x40000943,
      accelerationRate: 0.5,
      decelerationRate: 2,
      size: RaceSize.extraLarge,
      headBipedObject: 30,
      hairBipedObject: 31,
      shieldBipedObject: undefined,
      bodyBipedObject: 32,
      injuredHealthPct: 0.25,
      aimAngleTolerance: 41.75,
      flightRadius: 400,
      angularAccelerationRate: 0.25,
      angularTolerance: 5,
      flags2: 0x11,
      mount: {
        mountOffset: [-113.875, 195.125, 0],
        dismountOffset: [-50, 0, 65],
        mountCameraOffset: [0, -300, 0],
      },
      attackRace: 0x131f5,
      movementTypes: {
        walk: 0x5a3d,
        run: 0x5a3d,
        swim: undefined,
        fly: 0x5a41,
        sneak: undefined,
        sprint: undefined,
      },
      equipment: 0xffffe001,
    });
    expect(race.attacks.map((attack) => attack.event)).toEqual(['attackStartBite']);
    // The MTYP without SPED overrides nothing.
    expect(race.movementOverrides).toEqual([
      {
        movementType: 0x5a3d,
        speeds: {
          walk: { left: 10, right: 11, forward: 12, back: 13 },
          run: { left: 20, right: 21, forward: 22, back: 23 },
          rotateInPlace: { walk: 1.5, run: 2.5 },
          rotateWhileMoving: 3.5,
        },
      },
    ]);
  });

  it('take the mount defaults from a 128-byte DATA, and none of DATA without one', () => {
    expect(parseRaceCombat(record([['DATA', raceData(128)]])).mount).toEqual({
      mountOffset: [-63.479, 0, 0],
      dismountOffset: [-50, 0, 65],
      mountCameraOffset: [0, -300, 0],
    });
    expect(parseRaceCombat(record([]))).toMatchObject({
      flags: 0,
      size: RaceSize.medium,
      headBipedObject: undefined,
      attacks: [],
      movementOverrides: [],
      equipment: 0,
    });
  });
});

describe('NPC combat data', () => {
  it('read attack race, attack overrides, package lists and combat style', () => {
    const npc = parseNpcCombat(
      record([
        ['EDID', text('BanditBoss')],
        ['ATKR', u32s(0x13746)],
        [
          'ATKD',
          atkd({ ...plain, chance: 0, flags: AttackFlag.powerAttack | AttackFlag.overrideData }),
        ],
        ['ATKE', text('attackPowerStartForward')],
        ['SPOR', u32s(0x10a01)],
        ['ECOR', u32s(0x10a02)],
        ['GWOR', u32s(0)],
        ['ZNAM', u32s(0x3dece)],
        ['DPLT', u32s(0x64b2c)],
      ]),
    );
    expect(npc).toMatchObject({
      attackRace: 0x13746,
      overridePackages: {
        spectator: 0x10a01,
        observeCorpse: undefined,
        guardWarn: undefined,
        combat: 0x10a02,
      },
      defaultPackageList: 0x64b2c,
      combatStyle: 0x3dece,
    });
    expect(npc.attacks).toEqual([
      expect.objectContaining({
        event: 'attackPowerStartForward',
        attackChance: 0,
        flags: 0x80000004,
      }),
    ]);
  });
});
