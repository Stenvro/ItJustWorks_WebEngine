// Integration test: the behavior projects' animation data on the local game data (root motion,
// animation sets, speed tables). Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AnimationDataLibrary } from '../src/animation/animation-data-library.ts';
import { rootMotionTotal } from '../src/formats/animdata/root-motion.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('animation data on the local game data', () => {
  let vfs: Vfs;
  let library: AnimationDataLibrary;
  const MALE = 'meshes\\actors\\character\\defaultmale.hkx';

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    library = await AnimationDataLibrary.load((path) => vfs.read(path));
  });
  afterAll(async () => {
    await vfs.close();
  });

  it('reads every block of the single files', () => {
    expect(library.failures).toEqual([]);
    const male = library.project(MALE);
    expect(male?.data?.clips.length).toBeGreaterThan(2000);
    expect(male?.setData?.sets.length).toBeGreaterThan(300);
    expect(male?.speedData?.tables.length).toBeGreaterThan(10);
    expect(library.response('HitFrame', false)).toBe('HitFrameHandler');
  });

  it("moves the walk and run loops at their locomotion blend's child weights", () => {
    const male = library.project(MALE);
    // MT_ForwardBlend (mt_behavior.hkx) puts MT_WalkForward at 82.4541 and MT_RunForward at
    // 350.987 on its SpeedSampled axis.
    expect(male?.rootMotionTotal('MT_WalkForward')?.speed).toBeCloseTo(82.45, 1);
    expect(male?.rootMotionTotal('MT_RunForward')?.speed).toBeCloseTo(350.99, 0);
    expect(male?.rootMotionTotal('MT_WalkForward')?.yaw).toBeCloseTo(0, 3);
  });

  it("measures the speed tables on the clips' root motion (a synchronised blend)", () => {
    const male = library.project(MALE);
    const walkFast = male?.motion('MT_WalkForwardFast');
    const run = male?.motion('MT_RunForward');
    if (!walkFast || !run) throw new Error('no locomotion motion');
    // Parameter 324.5 between MT_WalkForwardFast (weight 140, played at 1.2) and MT_RunForward
    // (350.987): the blend's stride over its blended cycle duration.
    const t = (324.5 - 140) / (350.987 - 140);
    const speed = (motion: typeof run, playback: number): [number, number] => [
      rootMotionTotal(motion).distance,
      motion.duration / playback,
    ];
    const [strideA, durationA] = speed(
      walkFast,
      male?.clip('MT_WalkForwardFast')?.playbackSpeed ?? 1,
    );
    const [strideB, durationB] = speed(run, 1);
    const predicted = ((1 - t) * strideA + t * strideB) / ((1 - t) * durationA + t * durationB);
    expect(male?.speedAtParameter(0, 0, 324.5)).toBeCloseTo(predicted, 0);
  });

  it('moves the actor in the direction of its power attacks', () => {
    const male = library.project(MALE);
    const attacks = male?.attacks({ iLeftHandType: 10, iRightHandType: 1 }) ?? [];
    const clip = (event: string): string =>
      attacks.find((attack) => attack.event === event)?.clips[0] ?? '';
    const forward = male?.rootMotionTotal(clip('attackPowerStartForward'));
    const left = male?.rootMotionTotal(clip('attackPowerStartLeft'));
    const back = male?.rootMotionTotal(clip('attackPowerStartBackward'));
    expect(forward?.translation[1]).toBeGreaterThan(300);
    expect(left?.translation[0]).toBeLessThan(-50);
    expect(back?.translation[1]).toBeLessThan(-50);
    expect(attacks.map((attack) => attack.event)).toContain('bashStart');
  });

  it("gives a creature's attacks from its only set", () => {
    const wolf = library.project('meshes\\actors\\canine\\wolfproject.hkx');
    const attacks = wolf?.attacks({}) ?? [];
    expect(attacks.length).toBeGreaterThan(0);
    expect(attacks.every((attack) => attack.clips.every((clip) => wolf?.clip(clip)))).toBe(true);
  });

  it("samples the horse's speed as the engine's sampler does", () => {
    const horse = library.project('meshes\\actors\\horse\\horseproject.hkx');
    // HorseDefault (iState 60): a walk of 125 is the walk (125.11) with a little slow trot; a
    // gallop of 450 is past the table's last point (321) and is the goal itself (the run
    // blend's child sits at 450); a hair left of ahead (0.99) reads the first curve.
    expect(horse?.speedParameter(60, 0, 125)).toBeCloseTo(125.81, 1);
    expect(horse?.speedParameter(60, 0, 450)).toBe(450);
    expect(horse?.speedParameter(60, 0.99, 125)).toBeCloseTo(125.81, 1);
    expect(horse?.speedParameter(60, 0, 0)).toBe(0);
  });

  it('turns the actor around as it sits down on a chair', () => {
    const turn = library.project(MALE)?.rootMotionTotal('Chair_FrontEnterVar1');
    expect(Math.abs(turn?.yaw ?? 0)).toBeCloseTo(Math.PI, 1);
  });
});
