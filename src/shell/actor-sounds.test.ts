import { describe, expect, it, vi } from 'vitest';
import type { Vec3 } from '../render/math.ts';
import type { ActorLook } from '../world/actors.ts';
import { actorSounds, type SoundingWorld } from './actor-sounds.ts';

const FOOTSTEP_SET = 0x1234;
const PUDDLE = 0x4cc4b;

function setup(feet: Vec3, water: { height: number; type: number } | undefined) {
  const footstep = vi.fn(() => Promise.resolve(true));
  const sounds = { footstep, playNamed: vi.fn(() => Promise.resolve(undefined)) };
  const world: SoundingWorld = {
    sounds: () => sounds,
    ground: () => ({ material: 0x99, landscape: false }),
    water: () => water,
  };
  const look = { footstepSet: FOOTSTEP_SET } as unknown as ActorLook;
  const handle = actorSounds({ look, feet: () => feet, gait: () => 'run', player: true }, world);
  return { handle, footstep };
}

describe('actorSounds', () => {
  it('steps in the water the feet are under', () => {
    const { handle, footstep } = setup([0, 0, 10], { height: 14, type: PUDDLE });
    handle(['FootLeft']);
    expect(footstep).toHaveBeenCalledWith(FOOTSTEP_SET, 'FootLeft', 'run', [0, 0, 10], {
      water: PUDDLE,
    });
  });

  it('steps on the ground when the water is below the feet', () => {
    const { handle, footstep } = setup([0, 0, 10], { height: 6, type: PUDDLE });
    handle(['FootRight']);
    expect(footstep).toHaveBeenCalledWith(FOOTSTEP_SET, 'FootRight', 'run', [0, 0, 10], {
      material: 0x99,
      landscape: false,
    });
  });
});
