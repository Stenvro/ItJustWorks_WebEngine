// Integration test: the characters' mirroring (hkbMirroredSkeletonInfo) and their projects'
// default event mode on the local game data: a mirrored reference pose is the reference pose.
// Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MirroredSkeleton } from '../src/animation/mirror.ts';
import { ModelSpace } from '../src/animation/procedural.ts';
import { readAnimationContainer } from '../src/formats/hkx/animation.ts';
import { loadCharacterInfo } from '../src/formats/hkx/behavior.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('mirrored skeletons on the local game data', () => {
  let vfs: Vfs;
  const read = (path: string): Promise<Uint8Array> => vfs.read(path);

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  });
  afterAll(async () => {
    await vfs.close();
  });

  /** The largest move of a body bone (by name) as the reference pose is mirrored. */
  const worstMove = async (project: string, body: RegExp): Promise<number> => {
    const character = await loadCharacterInfo(project, read);
    expect(character.defaultEventMode).toBe(2);
    if (!character.rig || !character.mirror) throw new Error(`${project}: no rig or mirroring`);
    expect(character.mirror.axis).toEqual([1, 0, 0, 0]);
    const skeleton = readAnimationContainer(Packfile.parse(await read(character.rig))).skeletons[0];
    if (!skeleton) throw new Error(`${project}: no skeleton`);
    const pose = skeleton.referencePose.slice();
    new MirroredSkeleton(skeleton, character.mirror).mirrorPose(pose);
    const before = new ModelSpace(skeleton.parents);
    before.update(skeleton.referencePose);
    const after = new ModelSpace(skeleton.parents);
    after.update(pose);
    let worst = 0;
    skeleton.bones.forEach((bone, i) => {
      if (!body.test(bone.name)) return;
      const a = before.position(i);
      const b = after.position(i);
      worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
    });
    return worst;
  };

  it('mirrors the human reference pose onto itself (99 bone pairs)', async () => {
    expect(
      await worstMove('meshes\\actors\\character\\defaultmale.hkx', /^NPC (?!.*Magic)/),
    ).toBeLessThan(0.05);
  });

  it("mirrors the deer's and the chicken's reference poses onto themselves", async () => {
    expect(await worstMove('meshes\\actors\\deer\\deerproject.hkx', /./)).toBeLessThan(0.5);
    expect(
      await worstMove('meshes\\actors\\ambient\\chicken\\chickenproject.hkx', /./),
    ).toBeLessThan(0.5);
  });
});
