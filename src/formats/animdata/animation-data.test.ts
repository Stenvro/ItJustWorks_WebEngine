import { describe, expect, it } from 'vitest';
import {
  parseAnimationData,
  parseClipMotions,
  parseProjectAnimationData,
} from './animation-data.ts';

/** Lines of a block with its line count in front. */
const counted = (lines: string[]): string[] => [String(lines.length), ...lines];

const OBJECT_BLOCK = ['1', '2', 'Behaviors\\TestDoor.hkx', 'Characters\\TestDoor.hkx', '0'];
const CLIP_BLOCK = [
  '1',
  '3',
  'Behaviors\\TestBehavior.hkx',
  'Characters\\TestCharacter.hkx',
  'Character Assets\\skeleton.HKX',
  '1',
  'WalkLoop',
  '4',
  '1',
  '0',
  '0',
  '2',
  'FootLeft:0.25',
  'FootRight:0.75',
  '',
  'WalkLoop[mirrored]',
  '4',
  '0.5',
  '0.1',
  '0.2',
  '0',
  '',
  'Sound.Play:Step:1.5',
  '7',
  '1',
  '0',
  '0',
  '1',
  'Sound.Play:Step:1.5',
  '',
];
const MOTION_BLOCK = [
  '4',
  '1',
  '2',
  '0.5 0 40 0',
  '1 0 100 0',
  '1',
  '1 0 0 0 1',
  '',
  '7',
  '2',
  '1',
  '2 -1.5e-005 0 0',
  '2',
  '1 0 0 0.707107 0.707107',
  '2 0 0 1 7.54979e-008',
  '',
];

const SINGLE_FILE = [
  '2',
  'TestDoor.txt',
  'TestCharacter.txt',
  ...counted(OBJECT_BLOCK),
  ...counted(CLIP_BLOCK),
  ...counted(MOTION_BLOCK),
].join('\r\n');

describe('parseAnimationData', () => {
  const data = parseAnimationData(SINGLE_FILE);

  it('reads the project list and each project block by its line count', () => {
    expect(data.failures).toEqual([]);
    expect(data.projects.map((project) => project.name)).toEqual(['TestDoor', 'TestCharacter']);
    const [door, character] = data.projects;
    expect(door).toEqual({
      name: 'TestDoor',
      files: ['Behaviors\\TestDoor.hkx', 'Characters\\TestDoor.hkx'],
      hasClipData: false,
      clips: [],
      motions: [],
    });
    expect(character?.files).toHaveLength(3);
  });

  it('reads clip generators: clip id, speed, crop and events', () => {
    const clips = data.projects[1]?.clips ?? [];
    expect(clips.map((clip) => clip.name)).toEqual([
      'WalkLoop',
      'WalkLoop[mirrored]',
      'Sound.Play:Step:1.5',
    ]);
    expect(clips[0]).toEqual({
      name: 'WalkLoop',
      clipId: 4,
      playbackSpeed: 1,
      cropStart: 0,
      cropEnd: 0,
      events: [
        { name: 'FootLeft', time: 0.25 },
        { name: 'FootRight', time: 0.75 },
      ],
    });
    expect(clips[1]).toMatchObject({ clipId: 4, playbackSpeed: 0.5, cropStart: 0.1, cropEnd: 0.2 });
    // An event name may hold colons: the time follows the last one.
    expect(clips[2]?.events).toEqual([{ name: 'Sound.Play:Step', time: 1.5 }]);
  });

  it('reads motion: duration, translation keys and rotation keys per clip id', () => {
    const motions = data.projects[1]?.motions ?? [];
    expect(motions.map((motion) => motion.clipId)).toEqual([4, 7]);
    expect(motions[0]).toEqual({
      clipId: 4,
      duration: 1,
      translations: [
        { time: 0.5, value: [0, 40, 0] },
        { time: 1, value: [0, 100, 0] },
      ],
      rotations: [{ time: 1, value: [0, 0, 0, 1] }],
    });
    expect(motions[1]?.translations[0]?.value[0]).toBeCloseTo(-1.5e-5, 10);
    expect(motions[1]?.rotations[1]?.value[3]).toBeCloseTo(7.54979e-8, 12);
  });

  it('accepts LF line breaks', () => {
    const lf = parseAnimationData(SINGLE_FILE.replace(/\r\n/g, '\n'));
    expect(lf).toEqual(data);
  });

  it('skips a corrupt block by its line count and keeps reading', () => {
    const corrupt = [...CLIP_BLOCK];
    corrupt[8] = 'fast'; // the first clip's playback speed
    const text = [
      '2',
      'TestCharacter.txt',
      'TestDoor.txt',
      ...counted(corrupt),
      ...counted(MOTION_BLOCK),
      ...counted(OBJECT_BLOCK),
    ].join('\r\n');
    const result = parseAnimationData(text);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.project).toBe('TestCharacter');
    expect(result.failures[0]?.message).toMatch(/line 13: expected a playback speed, found "fast"/);
    // The project keeps its head and motion; the next project is read.
    expect(result.projects[0]?.clips).toEqual([]);
    expect(result.projects[0]?.motions).toHaveLength(2);
    expect(result.projects[1]?.name).toBe('TestDoor');
  });

  it('reports a block whose line count does not match its content', () => {
    const text = [
      '2',
      'TestDoor.txt',
      'OtherDoor.txt',
      String(OBJECT_BLOCK.length + 1),
      ...OBJECT_BLOCK,
      'left over',
      ...counted(OBJECT_BLOCK),
    ].join('\r\n');
    const result = parseAnimationData(text);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.message).toMatch(/used 5 of 6 lines/);
    expect(result.projects.map((project) => project.name)).toEqual(['TestDoor', 'OtherDoor']);
  });

  it('stops at a project whose head cannot be read', () => {
    const text = ['2', 'A.txt', 'B.txt', 'many', ...OBJECT_BLOCK].join('\r\n');
    const result = parseAnimationData(text);
    expect(result.projects).toEqual([]);
    expect(result.failures[0]?.message).toMatch(/the rest of the file is not read/);
  });

  it('throws a FormatError without a project count', () => {
    expect(() => parseAnimationData('TestDoor.txt')).toThrow(/project count/);
  });
});

describe('the per-project files', () => {
  it('reads meshes\\animationdata\\<project>.txt like a block of the single file', () => {
    const project = parseProjectAnimationData(
      CLIP_BLOCK.join('\r\n') + '\r\n',
      'meshes\\animationdata\\testcharacter.txt',
    );
    expect(project.name).toBe('testcharacter');
    expect(project.clips).toEqual(parseAnimationData(SINGLE_FILE).projects[1]?.clips);
  });

  it('reads boundanims\\anims_<project>.txt, also without the last empty line', () => {
    const motions = parseClipMotions(MOTION_BLOCK.slice(0, -1).join('\r\n'), 'anims_test.txt');
    expect(motions.map((motion) => motion.clipId)).toEqual([4, 7]);
  });
});
