import { describe, expect, it } from 'vitest';
import { encodeWindows1252 } from '../formats/text.ts';
import {
  ANIMATION_DATA_FILES,
  AnimationDataLibrary,
  animationDataKey,
} from './animation-data-library.ts';

const counted = (lines: string[]): string[] => [String(lines.length), ...lines];

const ANIMATION_DATA = [
  '3',
  'TestCharacter.txt',
  'TestDoor.txt',
  'TestDoor.txt',
  ...counted([
    '1',
    '1',
    'Characters\\TestCharacter.hkx',
    '1',
    'Walk',
    '3',
    '1',
    '0',
    '0',
    '0',
    '',
    'PowerForward',
    '5',
    '1',
    '0',
    '0',
    '1',
    'HitFrame:0.5',
    '',
  ]),
  ...counted([
    '3',
    '1',
    '1',
    '1 0 80 0',
    '1',
    '1 0 0 0 1',
    '',
    '5',
    '2',
    '1',
    '2 0 400 0',
    '1',
    '2 0 0 0 1',
    '',
  ]),
  ...counted(['1', '1', 'Characters\\DoorA.hkx', '0']),
  ...counted(['1', '1', 'Characters\\DoorB.hkx', '0']),
].join('\r\n');

const ANIMATION_SET_DATA = [
  '1',
  'TestCharacterData\\TestCharacter.txt',
  '3',
  'Sword.txt',
  'Shield.txt',
  'Idle.txt',
  ...['V3', '0', '2', 'iLeftHandType', '0', '0', 'iRightHandType', '1', '4'],
  ...['1', 'attackPowerStartForward', '0', '1', 'PowerForward', '0'],
  ...['V3', '0', '2', 'iLeftHandType', '10', '10', 'iRightHandType', '1', '4'],
  ...['2', 'attackPowerStartForward', '0', '1', 'ShieldPower', 'bashStart', '0', '1', 'Bash', '0'],
  ...['V3', '0', '0', '1', 'attackStart', '0', '1', 'AnySwipe', '0'],
].join('\r\n');

function speedData(): Uint8Array {
  const head = encodeWindows1252('1\r\nTestCharacterData\\TestCharacter.spd\r\n');
  const bytes = new Uint8Array(head.length + 4 * 10);
  bytes.set(head);
  const view = new DataView(bytes.buffer);
  const words = [1, 1, 0, 1, 0, 2, 0, 0, 100, 80];
  words.forEach((word, i) => {
    const at = head.length + i * 4;
    if (i >= 4 && i !== 5) view.setFloat32(at, word, true);
    else view.setUint32(at, word, true);
  });
  return bytes;
}

describe('AnimationDataLibrary', () => {
  const library = new AnimationDataLibrary({
    animationData: ANIMATION_DATA,
    animationSetData: ANIMATION_SET_DATA,
    speedData: speedData(),
    actorResponses: 'HitFrame : HitFrameHandler\r\nsitDown : ChairHandler',
    playerResponses: 'BackupResponse : ActorResponse\r\nsitDown : PlayerChairHandler',
  });

  it('names projects by their file name, from a race path or the listed name', () => {
    expect(animationDataKey('Actors\\Character\\TestCharacter.hkx')).toBe('testcharacter');
    expect(library.project('meshes\\actors\\test\\testcharacter.hkx')?.name).toBe('TestCharacter');
    expect(library.project('TESTCHARACTER')?.data?.clips).toHaveLength(2);
    expect(library.project('meshes\\actors\\test\\unknown.hkx')).toBeUndefined();
    expect(library.failures).toEqual([]);
  });

  it("gives a clip generator's root motion by name", () => {
    const project = library.project('meshes\\actors\\test\\testcharacter.hkx');
    expect(project?.motion('walk')?.clipId).toBe(3);
    expect(project?.rootMotionAt('Walk', 0.5)?.translation[1]).toBeCloseTo(40);
    expect(project?.rootMotionDelta('Walk', 0.75, 0.25)?.translation[1]).toBeCloseTo(40);
    expect(project?.rootMotionTotal('PowerForward')?.speed).toBeCloseTo(200);
    expect(project?.rootMotionAt('Missing', 0)).toBeUndefined();
  });

  it('gives the attacks of an equip state: its sets first, then the unconditional ones', () => {
    const project = library.project('TestCharacter');
    const sword = project?.attacks({ iLeftHandType: 0, iRightHandType: 2 });
    expect(sword?.map((attack) => [attack.event, attack.clips])).toEqual([
      ['attackPowerStartForward', ['PowerForward']],
      ['attackStart', ['AnySwipe']],
    ]);
    const shield = project?.attacks({ ILEFTHANDTYPE: 10, iRightHandType: 1 });
    expect(shield?.map((attack) => attack.event)).toEqual([
      'attackPowerStartForward',
      'bashStart',
      'attackStart',
    ]);
    expect(project?.attack({ iLeftHandType: 10, iRightHandType: 1 }, 'BASHSTART')?.clips).toEqual([
      'Bash',
    ]);
    // Unnamed variables count as 0: the sword set's left hand.
    expect(project?.attack({ iRightHandType: 3 }, 'attackPowerStartForward')?.clips).toEqual([
      'PowerForward',
    ]);
    expect(project?.attacks({ iRightHandType: 9 }).map((attack) => attack.event)).toEqual([
      'attackStart',
    ]);
    expect(project?.sets({ iRightHandType: 9 }).map((set) => set.name)).toEqual(['Idle']);
  });

  it('keeps the block with clip data, else the first, of a name listed twice', () => {
    expect(library.project('TestDoor')?.data?.files).toEqual(['Characters\\DoorA.hkx']);
  });

  it('samples the speed tables both ways', () => {
    const project = library.project('TestCharacter');
    expect(project?.speedAtParameter(0, 0, 50)).toBeCloseTo(40);
    expect(project?.speedParameter(0, 0, 40)).toBeCloseTo(50);
    expect(project?.speedParameter(7, 0, 40)).toBeUndefined();
  });

  it('answers animation events for the player and other actors', () => {
    expect(library.response('sitDown', true)).toBe('PlayerChairHandler');
    expect(library.response('sitDown', false)).toBe('ChairHandler');
    expect(library.response('HitFrame', true)).toBe('HitFrameHandler');
  });

  it('reads the files through a VFS reader; missing or corrupt ones leave their part empty', async () => {
    const files = new Map<string, Uint8Array>([
      [ANIMATION_DATA_FILES.animationData, encodeWindows1252(ANIMATION_DATA)],
      [
        ANIMATION_DATA_FILES.animationSetData,
        encodeWindows1252('1\r\nX\\X.txt\r\n1\r\nA.txt\r\nV3\r\nmany'),
      ],
    ]);
    const loaded = await AnimationDataLibrary.load((path) => {
      const bytes = files.get(path);
      return bytes ? Promise.resolve(bytes) : Promise.reject(new Error(`missing ${path}`));
    });
    expect(loaded.project('TestCharacter')?.motion('Walk')?.duration).toBe(1);
    expect(loaded.project('TestCharacter')?.setData).toBeUndefined();
    expect(loaded.failures.some((failure) => failure.includes('speeddatasinglefile'))).toBe(true);
    expect(loaded.failures.some((failure) => failure.includes('expected a trigger count'))).toBe(
      true,
    );
    expect(loaded.response('HitFrame', false)).toBeUndefined();
  });
});
