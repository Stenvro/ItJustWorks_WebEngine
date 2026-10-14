import { describe, expect, it } from 'vitest';
import { readSwf, swfExports, SwfTagCode } from './swf.ts';
import { concatBytes, encodeSwfString, encodeTag, u16Bytes, writeSwf } from './swf-writer.ts';

describe('writeSwf', () => {
  it('writes a movie readSwf reads back', () => {
    const exports = concatBytes([u16Bytes(1), u16Bytes(3), encodeSwfString('$EverywhereFont')]);
    const movie = readSwf(
      writeSwf(
        [
          { code: SwfTagCode.exportAssets, body: exports },
          { code: SwfTagCode.showFrame, body: new Uint8Array(0) },
        ],
        { width: 1280, height: 720, frameRate: 24 },
      ),
    );
    expect(movie.header).toMatchObject({ signature: 'FWS', version: 15, frameRate: 24 });
    expect(movie.header.frameSize).toEqual({ xMin: 0, xMax: 25600, yMin: 0, yMax: 14400 });
    expect(movie.tags.map((tag) => tag.code)).toEqual([
      SwfTagCode.exportAssets,
      SwfTagCode.showFrame,
      SwfTagCode.end,
    ]);
    expect(swfExports(movie)).toEqual([{ id: 3, name: '$EverywhereFont' }]);
  });

  it('uses a long tag header from 63 bytes on', () => {
    expect(encodeTag(12, new Uint8Array(62))).toHaveLength(64);
    expect(encodeTag(12, new Uint8Array(63))).toHaveLength(69);
  });
});
