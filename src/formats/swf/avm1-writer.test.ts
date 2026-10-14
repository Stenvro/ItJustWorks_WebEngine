import { describe, expect, it } from 'vitest';
import { decodeAvm1 } from './avm1.ts';
import { Avm1Writer, Op } from './avm1-writer.ts';

describe('Avm1Writer labels', () => {
  it('resolves jumps to labels before and after them', () => {
    const code = new Avm1Writer()
      .label('top')
      .push(true)
      .ifTo('end')
      .jumpTo('top')
      .label('end')
      .op(Op.end)
      .bytes();
    const actions = decodeAvm1(code, 10);
    const offsets = new Map(actions.map((action) => [action.name, action.offset]));
    const ifAction = actions.find((action) => action.name === 'If');
    const jumpAction = actions.find((action) => action.name === 'Jump');
    expect(ifAction?.target).toBe(offsets.get('End'));
    expect(jumpAction?.target).toBe(0);
  });

  it('refuses a jump to a label never placed', () => {
    const writer = new Avm1Writer().jumpTo('nowhere');
    expect(() => writer.bytes()).toThrow(/nowhere/);
  });
});
