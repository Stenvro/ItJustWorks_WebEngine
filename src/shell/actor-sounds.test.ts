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

  it('sounds a descriptor once per update: a paired clip’s twins (the troll killmoves’)', () => {
    const { handle, playNamed } = setup([0, 0, 0], undefined);
    // The troll's side reads its clip file's SoundPlay.NPCKill1HMD and its own
    // 2_SoundPlay.NPCKill1HMD (without its prefix: SoundPlay) at 0.03 s.
    handle([
      graphEvent('SoundPlay.NPCKill1HMD'),
      { name: 'SoundPlay', payload: 'NPCKill1HMD', text: '2_SoundPlay.NPCKill1HMD' },
    ]);
    expect(playNamed).toHaveBeenCalledTimes(1);
    // The next update's sounds again.
    handle([graphEvent('SoundPlay.NPCKill1HMD')]);
    expect(playNamed).toHaveBeenCalledTimes(2);
  });

  it('stops what SoundPlay started: SoundStop at once, SoundRelease letting it end', async () => {
    const stops: (boolean | undefined)[] = [];
    const loop = { ended: false, stop: (immediately?: boolean) => void stops.push(immediately) };
    const footstep = vi.fn(() => Promise.resolve(true));
    const world: SoundingWorld = {
      sounds: () => ({ footstep, playNamed: () => Promise.resolve(loop) }),
      ground: () => undefined,
      water: () => undefined,
    };
    const look = { footstepSet: FOOTSTEP_SET } as unknown as ActorLook;
    const handle = actorSounds(
      { look, feet: () => [0, 0, 0], gait: () => 'run', player: true },
      world,
    );
    handle([graphEvent('SoundPlay.WPNBowPullLPM')]);
    await Promise.resolve();
    // Another descriptor's stop leaves it playing; its own stops it (any case).
    handle([graphEvent('SoundStop.WPNBowZoomIn'), graphEvent('SoundStop.wpnbowpulllpm')]);
    expect(stops).toEqual([true]);
    handle([graphEvent('SoundPlay.NPCDogBarkDistant')]);
    await Promise.resolve();
    handle([graphEvent('SoundRelease.NPCDogBarkDistant')]);
    expect(stops).toEqual([true, false]);
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
