import { describe, expect, it } from 'vitest';
import { FormatError } from '../binary-reader.ts';
import { parseSeq, seqPath } from './seq.ts';

describe('SEQ files', () => {
  it('reads the form ids and names the file after its plugin', () => {
    const bytes = Uint8Array.from([0x5a, 0x5d, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00]);
    expect(Array.from(parseSeq(bytes))).toEqual([0x01015d5a, 1]);
    expect(seqPath('Dawnguard.esm')).toBe('seq\\dawnguard.seq');
  });

  it('refuses a file that is not whole form ids', () => {
    expect(() => parseSeq(new Uint8Array(6))).toThrow(FormatError);
  });
});
