import { describe, expect, it } from 'vitest';
import { decodeAvm1 } from './avm1.ts';
import { Avm1Writer, Op } from './avm1-writer.ts';
import { rewriteAvm1Strings } from './avm1-rewrite.ts';

/** A ConstantPool of the given strings. */
function pool(strings: readonly string[]): number[] {
  const payload = [strings.length & 0xff, strings.length >> 8];
  for (const text of strings) payload.push(...new TextEncoder().encode(text), 0);
  return [0x88, payload.length & 0xff, payload.length >> 8, ...payload];
}

const longer = (text: string): string | undefined =>
  text === '$NEW' ? 'New Game Started' : undefined;

describe('rewriteAvm1Strings', () => {
  it('keeps a block without matches as it is', () => {
    const code = new Avm1Writer().push('a', 1).op(Op.pop).bytes();
    expect(rewriteAvm1Strings(code, 15, longer)).toBe(code);
  });

  it('rewrites pool entries and pushed strings', () => {
    const code = Uint8Array.from([
      ...pool(['x', '$NEW']),
      ...new Avm1Writer().push('$NEW', '$OTHER').op(Op.pop).op(Op.pop).bytes(),
    ]);
    const actions = decodeAvm1(rewriteAvm1Strings(code, 15, longer), 15);
    expect(actions[0]?.pool).toEqual(['x', 'New Game Started']);
    expect(actions[1]?.values).toEqual([
      { kind: 'string', value: 'New Game Started' },
      { kind: 'string', value: '$OTHER' },
    ]);
  });

  it('moves branches and function sizes along', () => {
    // if (cond) skip the push; a function whose body pushes the key; a jump back to the start.
    const body = new Avm1Writer().push('$NEW').op(Op.return).bytes();
    const skipped = new Avm1Writer().push('$NEW').op(Op.pop).bytes();
    const code = new Avm1Writer()
      .push(true)
      .jumpIf(skipped.length)
      .append(skipped)
      .function2('f', [], 1, 0, (w) => w.append(body))
      .op(Op.pop)
      .bytes();
    const rewritten = rewriteAvm1Strings(code, 15, longer);
    const actions = decodeAvm1(rewritten, 15);
    const offsets = new Set(actions.map((action) => action.offset));
    const ifAction = actions.find((action) => action.name === 'If');
    const fn = actions.find((action) => action.name === 'DefineFunction2');
    // The If now lands on the DefineFunction2, past the longer push.
    expect(ifAction?.target).toBe(fn?.offset);
    // The function's body ends where the Pop after it starts.
    const pop = actions[actions.length - 1];
    expect(fn?.bodyEnd).toBe(pop?.offset);
    expect(offsets.has(fn?.bodyEnd ?? -1)).toBe(true);
  });
});
