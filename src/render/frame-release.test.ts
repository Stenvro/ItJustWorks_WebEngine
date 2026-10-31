import { describe, expect, it } from 'vitest';
import { frameRecording, recordFrame, releaseAfterFrame } from './frame-release.ts';

describe('frame release', () => {
  it('destroys at once outside a frame', () => {
    const done: string[] = [];
    releaseAfterFrame(() => done.push('scene'));
    expect(done).toEqual(['scene']);
  });

  it('waits for the frame being recorded to be submitted', () => {
    const done: string[] = [];
    recordFrame(() => {
      expect(frameRecording()).toBe(true);
      // A menu closing in its own update, in the middle of the frame.
      releaseAfterFrame(() => done.push('scene'));
      expect(done).toEqual([]);
      done.push('submit');
    });
    expect(done).toEqual(['submit', 'scene']);
    expect(frameRecording()).toBe(false);
  });

  it('still destroys when the frame throws', () => {
    const done: string[] = [];
    expect(() => {
      recordFrame(() => {
        releaseAfterFrame(() => done.push('scene'));
        throw new Error('lost device');
      });
    }).toThrow('lost device');
    expect(done).toEqual(['scene']);
  });
});
