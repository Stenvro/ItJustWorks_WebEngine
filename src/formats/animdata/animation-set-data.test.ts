import { describe, expect, it } from 'vitest';
import { bsCrc32 } from '../crc32.ts';
import {
  animationClipKey,
  animationSetApplies,
  parseAnimationSet,
  parseAnimationSetData,
  projectName,
} from './animation-set-data.ts';

const SWORD_SET = [
  'V3',
  '2',
  'weapEquip',
  'SwapForceEquip',
  '2',
  'iLeftHandType',
  '0',
  '0',
  'iRightHandType',
  '1',
  '4',
  '2',
  'attackStart',
  '1',
  '2',
  'Sword_AttackLeft',
  'Sword_AttackRight',
  'attackPowerStartForward',
  '0',
  '1',
  'Sword_PowerForward',
  '1',
  String(bsCrc32('meshes\\actors\\test\\animations')),
  String(bsCrc32('sword_attackleft')),
  '7891816',
];
const IDLE_SET = ['V3', '0', '0', '0', '0'];

const SINGLE_FILE = [
  '2',
  'TestCharacterData\\TestCharacter.txt',
  'TestCritterData\\TestCritter.txt',
  '2',
  'Sword.txt',
  'Idle.txt',
  ...SWORD_SET,
  ...IDLE_SET,
  '1',
  'FullBody.txt',
  ...IDLE_SET,
].join('\r\n');

describe('parseAnimationSetData', () => {
  const projects = parseAnimationSetData(SINGLE_FILE);

  it('reads the projects, their set lists and the sets in list order', () => {
    expect(projects.map((project) => project.name)).toEqual(['TestCharacter', 'TestCritter']);
    expect(projects[0]?.path).toBe('TestCharacterData\\TestCharacter.txt');
    expect(projects[0]?.sets.map((set) => set.name)).toEqual(['Sword', 'Idle']);
    expect(projects[1]?.sets.map((set) => set.name)).toEqual(['FullBody']);
  });

  it('reads a set: triggers, conditions, attacks and cached clips', () => {
    const sword = projects[0]?.sets[0];
    expect(sword).toEqual({
      name: 'Sword',
      version: 'V3',
      triggers: ['weapEquip', 'SwapForceEquip'],
      conditions: [
        { variable: 'iLeftHandType', min: 0, max: 0 },
        { variable: 'iRightHandType', min: 1, max: 4 },
      ],
      attacks: [
        { event: 'attackStart', flag: 1, clips: ['Sword_AttackLeft', 'Sword_AttackRight'] },
        { event: 'attackPowerStartForward', flag: 0, clips: ['Sword_PowerForward'] },
      ],
      clips: [
        {
          folder: bsCrc32('meshes\\actors\\test\\animations'),
          file: bsCrc32('sword_attackleft'),
          extension: 7891816,
        },
      ],
    });
  });

  it('reads one set file of a project folder', () => {
    expect(
      parseAnimationSet(SWORD_SET.join('\r\n'), 'meshes\\animationsetdata\\x\\sword.txt').name,
    ).toBe('sword');
  });

  it('throws a FormatError where a set does not start with its version', () => {
    expect(() => parseAnimationSetData(['1', 'A\\A.txt', '1', 'S.txt', '0'].join('\n'))).toThrow(
      /line 5: expected a set version/,
    );
  });
});

describe('animationClipKey', () => {
  it('hashes the lower-case folder and file name and packs the extension', () => {
    expect(animationClipKey('Meshes\\Actors\\Test\\Animations\\Sword_AttackLeft.HKX')).toEqual({
      folder: bsCrc32('meshes\\actors\\test\\animations'),
      file: bsCrc32('sword_attackleft'),
      // "hkx" as a little-endian u32: 0x68 0x6b 0x78 0x00.
      extension: 0x786b68,
    });
  });
});

describe('animationSetApplies', () => {
  const sword = parseAnimationSetData(SINGLE_FILE)[0]?.sets[0];
  it('needs every condition inside its range', () => {
    if (!sword) throw new Error('no set');
    const values = (left: number, right: number) => (name: string) =>
      name === 'iLeftHandType' ? left : name === 'iRightHandType' ? right : undefined;
    expect(animationSetApplies(sword, values(0, 1))).toBe(true);
    expect(animationSetApplies(sword, values(0, 4))).toBe(true);
    expect(animationSetApplies(sword, values(0, 5))).toBe(false);
    expect(animationSetApplies(sword, values(10, 1))).toBe(false);
    expect(animationSetApplies(sword, () => undefined)).toBe(false);
  });
});

describe('projectName', () => {
  it('is the listed file name without folder and extension', () => {
    expect(projectName('TestCharacterData\\TestCharacter.txt')).toBe('TestCharacter');
    expect(projectName('TestCharacterData\\TestCharacter.spd')).toBe('TestCharacter');
    expect(projectName('meshes\\actors\\test\\testcharacter.hkx')).toBe('testcharacter');
  });
});
