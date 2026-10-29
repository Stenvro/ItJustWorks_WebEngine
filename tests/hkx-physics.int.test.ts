// Integration test: the ragdoll physics of the skeleton files reads completely (every vanilla
// file: `node tools/hkx-physics.ts`). Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { readHavokPhysics } from '../src/formats/hkx/physics.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('Havok ragdoll physics on the local game data', () => {
  let vfs: Vfs;

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
  }, 60_000);
  afterAll(async () => {
    await vfs.close();
  });

  it('reads the human ragdoll: bodies, shapes, constraints and motors', async () => {
    const pack = Packfile.parse(
      await vfs.read('meshes\\actors\\character\\character assets\\skeleton.hkx'),
    );
    const { ragdoll, systems, container } = readHavokPhysics(pack);
    expect(ragdoll?.skeleton?.bones).toHaveLength(18);
    expect(ragdoll?.rigidBodies).toHaveLength(18);
    expect([...(ragdoll?.boneToRigidBodyMap ?? [])]).toEqual([...Array(18).keys()]);
    const com = ragdoll?.rigidBodies[0];
    expect(com?.name).toBe('Ragdoll_NPC COM [COM ]');
    expect(com?.shape?.kind).toBe('capsule');
    expect(com?.motion.mass).toBeCloseTo(5);
    expect(com?.material.friction).toBeCloseTo(0.3);
    expect(com?.motion.angularDamping).toBeCloseTo(0.05, 2);
    const kinds = ragdoll?.constraints.map((constraint) => constraint.data.kind) ?? [];
    expect(kinds.filter((kind) => kind === 'ragdoll')).toHaveLength(9);
    expect(kinds.filter((kind) => kind === 'limited-hinge')).toHaveLength(8);
    for (const constraint of ragdoll?.constraints ?? []) {
      expect(constraint.bodyA).toBeGreaterThanOrEqual(0);
      expect(constraint.bodyB).toBeGreaterThanOrEqual(0);
      if (constraint.data.kind === 'ragdoll') {
        expect(constraint.data.coneLimit.maxAngle).toBeGreaterThan(0);
        expect(constraint.data.motors.motors[0]?.maxForce).toBeGreaterThan(0);
      }
    }
    // The physics system: the ragdoll's bodies and the character bumper.
    expect(systems[0]?.rigidBodies.map((body) => body.name)).toContain('CharacterBumper');
    expect(container?.children.map((child) => child.name)).toContain('CharacterBumper');
  });

  it('reads the frostbite spider and its shapes', async () => {
    const pack = Packfile.parse(
      await vfs.read('meshes\\actors\\frostbitespider\\character assets\\skeleton.hkx'),
    );
    const { ragdoll } = readHavokPhysics(pack);
    expect(ragdoll?.rigidBodies).toHaveLength(48);
    expect(ragdoll?.constraints).toHaveLength(47);
    expect(ragdoll?.rigidBodies.every((body) => body.shape?.kind !== 'unknown')).toBe(true);
  });
});
