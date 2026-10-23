import { describe, expect, it, vi } from 'vitest';
import { graphEvent } from '../animation/graph-events.ts';
import type { Vec3 } from '../render/math.ts';
import type { ActorLook } from '../world/actors.ts';
import { actorSounds, footstepGait, type SoundingWorld } from './actor-sounds.ts';

const FOOTSTEP_SET = 0x1234;
const PUDDLE = 0x4cc4b;

function setup(feet: Vec3, water: { height: number; type: number } | undefined) {
  const footstep = vi.fn(() => Promise.resolve(true));
  const sounds = {
    footstep,
    playNamed: vi.fn<(editorId: string) => Promise<undefined>>(() => Promise.resolve(undefined)),
  };
  const world: SoundingWorld = {
    sounds: () => sounds,
    ground: () => ({ material: 0x99, landscape: false }),
    water: () => water,
  };
  const look = { footstepSet: FOOTSTEP_SET } as unknown as ActorLook;
  const handle = actorSounds({ look, feet: () => feet, gait: () => 'run', player: true }, world);
  return { handle, footstep, playNamed: sounds.playNamed };
}

describe('actorSounds', () => {
  it('steps in the water the feet are under', () => {
    const { handle, footstep } = setup([0, 0, 10], { height: 14, type: PUDDLE });
    handle([graphEvent('FootLeft')]);
    expect(footstep).toHaveBeenCalledWith(FOOTSTEP_SET, 'FootLeft', 'run', [0, 0, 10], {
      water: PUDDLE,
    });
  });

  it('steps on the ground when the water is below the feet', () => {
    const { handle, footstep } = setup([0, 0, 10], { height: 6, type: PUDDLE });
    handle([graphEvent('FootRight')]);
    expect(footstep).toHaveBeenCalledWith(FOOTSTEP_SET, 'FootRight', 'run', [0, 0, 10], {
      material: 0x99,
      landscape: false,
    });
  });
});

describe('actorSounds, SoundPlay', () => {
  it('plays the sound its payload names (the text after the dot); NPCSoundPlay not the player', () => {
    const { handle, playNamed, footstep } = setup([0, 0, 0], undefined);
    handle([graphEvent('SoundPlay.NPCGiantAttackStomp'), graphEvent('NPCSoundPlay.NPCWolfDeath')]);
    expect(playNamed).toHaveBeenCalledTimes(1);
    expect(playNamed.mock.calls[0]?.[0]).toBe('NPCGiantAttackStomp');
    expect(footstep).not.toHaveBeenCalled();
  });
});

describe('footstepGait', () => {
  it("steps by the actor's movement: sneaking first, then sprinting, running, walking", () => {
    const motion = { sneaking: false, sprinting: false, running: false };
    expect(footstepGait(undefined)).toBe('walk');
    expect(footstepGait(motion)).toBe('walk');
    expect(footstepGait({ ...motion, running: true })).toBe('run');
    expect(footstepGait({ ...motion, sprinting: true })).toBe('sprint');
    expect(footstepGait({ ...motion, sneaking: true, running: true })).toBe('sneak');
  });
});
