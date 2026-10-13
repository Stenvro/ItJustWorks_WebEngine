// Integration test: Havok skeletons and spline-compressed animations of the local game data.
// Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  readAnimationContainer,
  TRANSFORM_FLOATS,
  type AnimationContainer,
  type HkxAnimation,
} from '../src/formats/hkx/animation.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const ANIMATIONS = 'meshes\\actors\\character\\animations\\';

describe.skipIf(!hasGamedata())('Havok animations on the local game data', () => {
  let vfs: Vfs;
  const load = async (path: string): Promise<AnimationContainer> =>
    readAnimationContainer(Packfile.parse(await vfs.read(path)));
  const clip = async (path: string): Promise<HkxAnimation> => {
    const animation = (await load(path)).bindings[0]?.animation;
    if (!animation) throw new Error(`${path} has no animation`);
    return animation;
  };
  /** The pose at a time over a buffer prefilled with a marker. */
  const pose = (animation: HkxAnimation, time: number, floats?: Float32Array): Float32Array => {
    const out = new Float32Array(animation.trackCount * TRANSFORM_FLOATS).fill(-7);
    animation.sample(time, out, floats);
    return out;
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  it('reads the human skeleton with its float slots and the ragdoll skeleton', async () => {
    const { skeletons } = await load('meshes\\actors\\character\\character assets\\skeleton.hkx');
    const [human, ragdoll] = skeletons;
    expect(human?.name).toBe('NPC Root [Root]');
    expect(human?.bones).toHaveLength(99);
    expect(human?.bones[0]?.name).toBe('NPC Root [Root]');
    expect(human?.parents[0]).toBe(-1);
    expect(human?.floatSlots).toContain('hkVis:Weapon');
    expect(human?.referenceFloats).toHaveLength(human?.floatSlots.length ?? -1);
    expect(ragdoll?.bones).toHaveLength(18);
  });

  it('decodes a walk: its length, foot events and a pelvis that sways', async () => {
    const walk = await clip(`${ANIMATIONS}male\\mt_walkforward.hkx`);
    expect(walk.duration).toBeCloseTo(1.133, 3);
    expect([walk.trackCount, walk.floatTrackCount]).toEqual([99, 4]);
    expect(walk.annotations.map((annotation) => annotation.text)).toEqual([
      'FootLeft',
      'FootRight',
    ]);
    const floats = new Float32Array(4);
    const start = pose(walk, 0, floats);
    const middle = pose(walk, walk.duration / 2);
    for (const value of [...start, ...middle, ...floats]) expect(Number.isFinite(value)).toBe(true);
    expect(start[4 * TRANSFORM_FLOATS]).toBeCloseTo(2.62, 1);
    expect(middle[4 * TRANSFORM_FLOATS]).toBeCloseTo(-3.25, 1);
    expect(Array.from(floats)).toEqual([1, 1, 1, 1]);
  });

  it('agrees with itself where one compressed block ends and the next begins', async () => {
    const path = 'meshes\\actors\\character\\_1stperson\\animations\\1hm_1stp_walk.hkx';
    const pack = Packfile.parse(await vfs.read(path));
    // hkaSplineCompressedAnimation: numBlocks @60, blockDuration @72.
    const at = pack.objectsOf('hkaSplineCompressedAnimation')[0]?.offset ?? 0;
    expect(pack.i32(at + 60)).toBe(2);
    const seam = pack.f32(at + 72);
    const walk = await clip(path);
    const before = pose(walk, seam - 1e-4);
    const after = pose(walk, seam + 1e-4);
    for (let i = 0; i < before.length; i++) {
      expect(Math.abs((before[i] ?? 0) - (after[i] ?? 0))).toBeLessThan(0.05);
    }
  });

  it('leaves the bone that a clip carries NaN for at the pose below it', async () => {
    const angry = await clip(`${ANIMATIONS}dialogueangryhips.hkx`);
    const out = pose(angry, 1);
    // Track 41 (AnimObjectR) has NaN ranges in the data; every other track is decoded.
    const track = Array.from(out.subarray(41 * TRANSFORM_FLOATS, 42 * TRANSFORM_FLOATS));
    expect(track).toEqual(new Array(TRANSFORM_FLOATS).fill(-7));
    for (const value of out) expect(Number.isFinite(value)).toBe(true);
  });

  it('fades the book in through a float track', async () => {
    const book = await clip(`${ANIMATIONS}idlebook_onepage.hkx`);
    const floats = new Float32Array(4);
    pose(book, 0, floats);
    expect(Array.from(floats)).toEqual([1, 0, 1, 1]);
    pose(book, book.duration / 2, floats);
    expect(floats[1]).toBeCloseTo(1, 3);
  });
});
