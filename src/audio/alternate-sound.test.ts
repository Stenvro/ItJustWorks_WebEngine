import { describe, expect, it } from 'vitest';
import { readyStandIn } from './alternate-sound.ts';

const readyOf =
  (...paths: string[]) =>
  (path: string): boolean =>
    paths.includes(path);

describe('readyStandIn', () => {
  const files = ['wood1.wav', 'wood2.wav', 'wood3.wav'];
  const lofi = ['dirt1.wav', 'dirt2.wav'];

  it('plays the picked file when it is in memory', () => {
    expect(readyStandIn('wood2.wav', files, lofi, readyOf('wood2.wav', 'wood1.wav'), () => 0)).toBe(
      'wood2.wav',
    );
  });

  it('else another file of the same descriptor that is in memory', () => {
    expect(readyStandIn('wood2.wav', files, lofi, readyOf('wood3.wav', 'dirt1.wav'), () => 0)).toBe(
      'wood3.wav',
    );
  });

  it('else a file of the alternate descriptor (the LoFi sound)', () => {
    expect(
      readyStandIn('wood2.wav', files, lofi, readyOf('dirt1.wav', 'dirt2.wav'), () => 0.9),
    ).toBe('dirt2.wav');
  });

  it('waits for the picked file when nothing is in memory', () => {
    expect(readyStandIn('wood2.wav', files, lofi, readyOf(), () => 0)).toBeUndefined();
    expect(readyStandIn('wood2.wav', files, [], readyOf('other.wav'), () => 0)).toBeUndefined();
  });
});
