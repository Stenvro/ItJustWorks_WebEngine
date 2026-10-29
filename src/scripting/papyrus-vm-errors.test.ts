import { describe, expect, it } from 'vitest';
import {
  buildPex,
  float,
  id,
  int,
  none,
  str,
  type BuildScript,
} from '../../tests/helpers/pex-builder.ts';
import { parsePex } from '../formats/pex/pex.ts';
import { PapyrusVm, type VmHost } from './papyrus-vm.ts';
import { ScriptLibrary } from './script-library.ts';
import { floatText, ObjectHandle, PapyrusArray } from './values.ts';

// The VM's own rules for what a script gets wrong, and how it prints numbers (observed in the
// original): the errors are logged with the script's stack and the thread goes on.
const SCRIPT: BuildScript = {
  name: 'Rules',
  functions: [
    {
      name: 'Texts',
      returnType: 'String',
      locals: [
        ['f', 'Float'],
        ['i', 'Int'],
        ['s', 'String'],
        ['t', 'String'],
      ],
      code: [
        ['assign', id('f'), float(1.5)],
        ['assign', id('i'), int(3)],
        ['cast', id('s'), id('f')],
        ['cast', id('t'), id('i')],
        ['strcat', id('s'), id('s'), str(' ')],
        ['strcat', id('s'), id('s'), id('t')],
        ['strcat', id('s'), id('s'), str(' ')],
        ['strcat', id('s'), id('s'), float(-0.25)],
        ['return', id('s')],
      ],
    },
    {
      name: 'DivideByZero',
      returnType: 'Int',
      locals: [['i', 'Int']],
      code: [
        ['assign', id('i'), int(7)],
        ['idiv', id('i'), int(1), int(0)],
        ['return', id('i')],
      ],
    },
    {
      name: 'MakeArray',
      returnType: 'Int[]',
      params: [['size', 'Int']],
      locals: [['a', 'Int[]']],
      code: [
        ['array_create', id('a'), id('size')],
        ['return', id('a')],
      ],
    },
    {
      name: 'ReadPast',
      returnType: 'Int',
      locals: [
        ['a', 'Int[]'],
        ['x', 'Int'],
      ],
      code: [
        ['array_create', id('a'), int(2)],
        ['array_setelement', id('a'), int(2), int(9)],
        ['array_getelement', id('x'), id('a'), int(5)],
        ['assign', id('a'), none],
        ['array_getelement', id('x'), id('a'), int(0)],
        ['return', id('x')],
      ],
    },
  ],
};

function setup(): { vm: PapyrusVm; logged: string[]; self: ObjectHandle } {
  const pex = parsePex(buildPex(SCRIPT));
  const library = new ScriptLibrary((name) => Promise.resolve(name === 'rules' ? pex : undefined));
  const logged: string[] = [];
  const host: VmHost = {
    formType: () => Promise.resolve('form'),
    attachedScripts: () => Promise.resolve([{ name: 'Rules', properties: new Map() }]),
    native: () => undefined,
    warn: (message) => logged.push(`warn: ${message}`),
    gameLog: (message) => logged.push(message),
  };
  return { vm: new PapyrusVm(library, host), logged, self: new ObjectHandle(0x10, 'Rules') };
}

describe('Papyrus VM rules', () => {
  it('prints floats with six decimals and ints as they are', async () => {
    const { vm, self } = setup();
    expect(await vm.call(self, 'Texts')).toBe('1.500000 3 -0.250000');
  });

  it('prints floats as single precision, as C prints them', () => {
    expect(floatText(0.1)).toBe('0.100000');
    expect(floatText(1 / 3)).toBe('0.333333');
    expect(floatText(-0)).toBe('-0.000000');
    expect(floatText(100)).toBe('100.000000');
    expect(floatText(1e30)).toBe('1000000015047466219876688855040.000000');
    expect(floatText(Infinity)).toBe('inf');
  });

  it('leaves the result of a division by zero as it was and logs it', async () => {
    const { vm, logged, self } = setup();
    expect(await vm.call(self, 'DivideByZero')).toBe(7);
    expect(logged).toEqual(['Rules.DivideByZero [rules 00000010]: Cannot divide by zero']);
  });

  it('makes arrays of 1 to 128 elements only', async () => {
    const { vm, logged, self } = setup();
    const made = await vm.call(self, 'MakeArray', [128]);
    expect(made instanceof PapyrusArray ? made.items.length : -1).toBe(128);
    expect(await vm.call(self, 'MakeArray', [129])).toBeNull();
    expect(await vm.call(self, 'MakeArray', [0])).toBeNull();
    expect(logged.map((line) => line.slice(line.indexOf(': ') + 2))).toEqual([
      'Array size of 129 is too large, must be 128 or smaller',
      'Array size of 0 must be greater then 0',
    ]);
  });

  it('logs reads and writes past an array’s end and on a None array', async () => {
    const { vm, logged, self } = setup();
    expect(await vm.call(self, 'ReadPast')).toBe(0);
    expect(logged.map((line) => line.slice(line.indexOf(': ') + 2))).toEqual([
      'Array index 2 is out of range (0-1)',
      'Array index 5 is out of range (0-1)',
      'Cannot access an element of a None array',
    ]);
  });
});
