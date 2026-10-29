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
    {
      name: 'Single',
      returnType: 'Float',
      locals: [['f', 'Float']],
      code: [
        ['fadd', id('f'), float(Math.fround(0.1)), float(Math.fround(0.2))],
        ['return', id('f')],
      ],
    },
    {
      name: 'Finds',
      returnType: 'Int',
      locals: [
        ['a', 'Int[]'],
        ['x', 'Int'],
        ['y', 'Int'],
      ],
      code: [
        ['array_create', id('a'), int(3)],
        ['array_setelement', id('a'), int(2), int(9)],
        ['array_findelement', id('a'), id('x'), int(9), int(3)],
        ['array_rfindelement', id('a'), id('y'), int(9), int(-1)],
        ['iadd', id('x'), id('x'), id('y')],
        ['assign', id('a'), none],
        ['array_findelement', id('a'), id('y'), int(9), int(0)],
        ['return', id('x')],
      ],
    },
    {
      name: 'Casts',
      returnType: 'String',
      locals: [
        ['o', 'Rules'],
        ['i', 'Int'],
        ['s', 'String'],
      ],
      code: [
        ['cast', id('i'), id('o')],
        ['assign', id('o'), id('self')],
        ['cast', id('s'), id('o')],
        ['return', id('s')],
      ],
    },
    {
      name: 'CallOnNone',
      locals: [['o', 'Rules']],
      code: [['callmethod', id('Texts'), id('o'), id('::NoneVar')]],
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
    expect(logged).toEqual(['Rules.DivideByZero [rules < (00000010)>]: Cannot divide by zero']);
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

  it('does float arithmetic in single precision', async () => {
    const { vm, self } = setup();
    expect(await vm.call(self, 'Single')).toBe(Math.fround(Math.fround(0.1) + Math.fround(0.2)));
  });

  it('logs a find from a start index out of range, finding nothing; RFind from -1 is the last', async () => {
    const { vm, logged, self } = setup();
    // Find from 3 of a three-element array: -1 and the error; RFind from -1 finds index 2.
    expect(await vm.call(self, 'Finds')).toBe(1);
    expect(logged.map((line) => line.slice(line.indexOf(': ') + 2))).toEqual([
      'Array start index 3 is out of range (0-2)',
      "Variable isn't an array and cannot be searched",
    ]);
  });

  it('logs a cast between unrelated kinds, and prints an object as the original does', async () => {
    const { vm, logged, self } = setup();
    vm.host.describeObject = (target) =>
      Promise.resolve(`TheRules (${target.formId.toString(16).padStart(8, '0')})`);
    expect(await vm.call(self, 'Casts')).toBe('[Rules <TheRules (00000010)>]');
    expect(logged.map((line) => line.slice(line.indexOf(': ') + 2))).toEqual([
      'Cannot cast from Rules to Int',
    ]);
  });

  it('logs a call on None in the original’s words and goes on', async () => {
    const { vm, logged, self } = setup();
    expect(await vm.call(self, 'CallOnNone')).toBeNull();
    expect(logged).toEqual([
      'warn: Rules.CallOnNone [rules < (00000010)>]: Cannot call Texts() on a None object, aborting function call (o)',
    ]);
  });
});

describe('a state change (the compiled GotoState)', () => {
  // GotoState as the compiler writes it in every script: onEndState in the state left, the new
  // state set, then onBeginState in the state entered.
  const gotoState = {
    name: 'GotoState',
    params: [['newState', 'String']] as const,
    code: [
      ['callmethod', id('onEndState'), id('self'), id('::NoneVar')],
      ['assign', id('::State'), id('newState')],
      ['callmethod', id('onBeginState'), id('self'), id('::NoneVar')],
    ] as const,
  };
  const marker = (text: string) => ({
    code: [['strcat', id('trail'), id('trail'), str(text)]] as const,
  });
  const pex = parsePex(
    buildPex({
      name: 'Lever',
      variables: [['trail', 'String', str('')]],
      functions: [
        gotoState,
        { name: 'Trail', returnType: 'String', code: [['return', id('trail')]] },
      ],
      states: [
        { name: 'Up', functions: [{ name: 'onEndState', ...marker('end up;') }] },
        { name: 'Down', functions: [{ name: 'onBeginState', ...marker('begin down;') }] },
      ],
    }),
  );

  it('sends onEndState to the state left, then onBeginState to the state entered', async () => {
    const library = new ScriptLibrary((name) =>
      Promise.resolve(name === 'lever' ? pex : undefined),
    );
    const host: VmHost = {
      formType: () => Promise.resolve('form'),
      attachedScripts: () => Promise.resolve([{ name: 'Lever', properties: new Map() }]),
      native: () => undefined,
      warn: () => undefined,
    };
    const vm = new PapyrusVm(library, host);
    const lever = new ObjectHandle(0x20, 'Lever');
    await vm.call(lever, 'GotoState', ['Up']);
    await vm.call(lever, 'GotoState', ['Down']);
    expect(await vm.call(lever, 'Trail')).toBe('end up;begin down;');
  });
});
