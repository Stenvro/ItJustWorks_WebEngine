import { describe, expect, it } from 'vitest';
import { CreatureSoundType } from '../world/actor-records.ts';
import { CreatureSounds, creatureLoops, type CreatureActor } from './creature-sounds.ts';

const BREATHE = 0x100;
const MACHINE = 0x200;
const IDLE = 0x300;
const sounds = [
  { type: CreatureSoundType.consciousLoop, sound: BREATHE, chance: 100 },
  { type: CreatureSoundType.movementLoop, sound: MACHINE, chance: 100 },
  { type: CreatureSoundType.idle, sound: IDLE, chance: 100 },
];

describe('creature loops', () => {
  it('plays the conscious loop while conscious, the movement loop while it also moves', () => {
    expect([...creatureLoops(sounds, { conscious: true, moving: false })]).toEqual([BREATHE]);
    expect([...creatureLoops(sounds, { conscious: true, moving: true })]).toEqual([
      BREATHE,
      MACHINE,
    ]);
    expect(creatureLoops(sounds, { conscious: false, moving: true }).size).toBe(0);
  });

  it('starts loops on the stage and stops them as the creature dies or leaves', async () => {
    const started: number[] = [];
    const stopped: number[] = [];
    const loops = new CreatureSounds({
      play: (descriptor) => {
        started.push(descriptor);
        return Promise.resolve({ stop: () => stopped.push(descriptor) });
      },
      unconscious: () => false,
    });
    let actor: CreatureActor = {
      reference: 1,
      sounds,
      position: [0, 0, 0],
      dead: false,
      place: () => [0, 0, 0],
    };
    loops.frame([actor], 0.1);
    expect(started).toEqual([BREATHE]);
    // 100 units in 0.1 s: it moves.
    actor = { ...actor, position: [100, 0, 0] };
    loops.frame([actor], 0.1);
    expect(started).toEqual([BREATHE, MACHINE]);
    await Promise.resolve();
    actor = { ...actor, dead: true };
    loops.frame([actor], 0.1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped.sort()).toEqual([BREATHE, MACHINE]);
    loops.remove(1);
  });

  it('plays the idle sound with its chance as the creature takes an ambient idle', () => {
    const started: number[] = [];
    const sounds2 = new CreatureSounds({
      play: (descriptor) => {
        started.push(descriptor);
        return undefined;
      },
      unconscious: () => false,
    });
    const crab = [{ type: CreatureSoundType.idle, sound: IDLE, chance: 40 }];
    const actor: CreatureActor = {
      reference: 2,
      sounds: crab,
      position: [0, 0, 0],
      dead: false,
      place: () => [0, 0, 0],
    };
    sounds2.frame([actor], 0.1);
    sounds2.idle(2, () => 0.39); // 39 < 40: it sounds
    sounds2.idle(2, () => 0.41); // 41: it does not
    expect(started).toEqual([IDLE]);
    // Not while dead, nor for an actor it does not know.
    sounds2.frame([{ ...actor, dead: true }], 0.1);
    sounds2.idle(2, () => 0);
    sounds2.idle(3, () => 0);
    expect(started).toEqual([IDLE]);
  });
});
