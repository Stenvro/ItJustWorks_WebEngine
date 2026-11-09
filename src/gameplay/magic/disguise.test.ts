import { describe, expect, it } from 'vitest';
import { actsAgain, disguises, disguiseStep, type DisguiseState } from './disguise.ts';

describe('the Disguise archetype’s own state', () => {
  it('takes hold at its first look unseen; seen, it waits until no one detects its actor', () => {
    expect(disguiseStep('initiate', true, false)).toBe('normal');
    expect(disguiseStep('initiate', true, true)).toBe('waiting');
    expect(disguiseStep('waiting', true, true)).toBe('waiting');
    expect(disguiseStep('waiting', true, false)).toBe('normal');
  });

  it('is seen as it is meant to be once it holds; its conditions failing break it for good', () => {
    expect(disguiseStep('normal', true, true)).toBe('normal');
    expect(disguiseStep('normal', false, false)).toBe('fail');
    // Its conditions holding again do not bring it back, unlike other effects.
    expect(disguiseStep('fail', true, false)).toBe('fail');
  });

  it('does not take hold while its conditions fail before it began', () => {
    expect(disguiseStep('initiate', false, false)).toBe('initiate');
    expect(disguiseStep('waiting', false, false)).toBe('waiting');
  });

  it('does not act again once failed; every other effect (and state) does', () => {
    expect(actsAgain(undefined)).toBe(true);
    expect(actsAgain('initiate')).toBe(true);
    expect(actsAgain('waiting')).toBe(true);
    expect(actsAgain('normal')).toBe(true);
    expect(actsAgain('fail')).toBe(false);
  });

  it('disguises its actor only while it holds', () => {
    const states: (DisguiseState | undefined)[] = [
      undefined,
      'initiate',
      'waiting',
      'normal',
      'fail',
    ];
    expect(states.map(disguises)).toEqual([false, false, false, true, false]);
  });
});
