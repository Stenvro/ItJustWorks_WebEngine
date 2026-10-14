import { describe, expect, it } from 'vitest';
import { decodeAvm1, disassembleAvm1 } from '../formats/swf/avm1.ts';
import { Avm1Writer, Op } from '../formats/swf/avm1-writer.ts';
import { readSwf, SwfTagCode, tagBody } from '../formats/swf/swf.ts';
import { writeSwf } from '../formats/swf/swf-writer.ts';
import {
  BRIDGE_CALL,
  BRIDGE_GET,
  BRIDGE_INVOKE,
  BRIDGE_SET,
  bridgeActions,
  withBridge,
} from './menu-bridge.ts';

describe('Avm1Writer', () => {
  it('writes pushes the decoder reads back', () => {
    const code = new Avm1Writer()
      .push('name', 7, -1, 0.5, true, null, { register: 3 })
      .op(Op.pop)
      .bytes();
    const [push, pop] = decodeAvm1(code, 15);
    expect(push?.values).toEqual([
      { kind: 'string', value: 'name' },
      { kind: 'number', value: 7 },
      { kind: 'number', value: -1 },
      { kind: 'number', value: 0.5 },
      { kind: 'boolean', value: true },
      { kind: 'null' },
      { kind: 'register', register: 3 },
    ]);
    expect(pop?.name).toBe('Pop');
  });

  it('writes a function with its body after it', () => {
    const code = new Avm1Writer()
      .function2('', ['a', 'b'], 3, 0, (body) => body.push({ register: 1 }).op(Op.return))
      .op(Op.pop)
      .bytes();
    const actions = decodeAvm1(code, 15);
    expect(actions[0]).toMatchObject({ name: 'DefineFunction2', params: ['a@r1', 'b@r2'] });
    expect(actions.map((a) => a.name)).toEqual(['DefineFunction2', 'Push', 'Return', 'Pop']);
    expect(actions[0]?.bodyEnd).toBe(actions[3]?.offset);
  });
});

describe('the menu bridge', () => {
  const lines = disassembleAvm1(decodeAvm1(bridgeActions('hud'), 15)).join('\n');

  it('tags the menu calls with the menu and reaches the page function', () => {
    expect(lines).toContain(`Push "hud", "${BRIDGE_CALL}", 2, r1, "unshift"`);
    expect(lines).toContain('"__itjwOriginalCall"');
  });

  it('registers the callbacks the engine invokes', () => {
    for (const name of [BRIDGE_INVOKE, BRIDGE_SET, BRIDGE_GET]) {
      expect(lines).toContain(`Push null, "${name}", 3`);
    }
    expect(lines).toContain('"gfxExtensions", true');
  });

  it('goes first in the first frame, after the header tags', () => {
    const menu = writeSwf(
      [
        { code: SwfTagCode.fileAttributes, body: new Uint8Array(4) },
        { code: SwfTagCode.setBackgroundColor, body: Uint8Array.of(0, 0, 0) },
        { code: SwfTagCode.doAction, body: Uint8Array.of(0) },
        { code: SwfTagCode.showFrame, body: new Uint8Array(0) },
      ],
      { width: 1280, height: 720 },
    );
    const bridged = readSwf(withBridge(menu, 'hud'));
    expect(bridged.header.frameSize.xMax).toBe(25600);
    expect(bridged.tags.map((tag) => tag.code)).toEqual([
      SwfTagCode.fileAttributes,
      SwfTagCode.setBackgroundColor,
      SwfTagCode.doAction,
      SwfTagCode.doAction,
      SwfTagCode.showFrame,
      SwfTagCode.end,
    ]);
    const first = bridged.tags[2];
    expect(first && tagBody(bridged, first)).toEqual(Uint8Array.from([...bridgeActions('hud'), 0]));
  });
});
