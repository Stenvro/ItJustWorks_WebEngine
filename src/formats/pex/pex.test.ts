import { describe, expect, it } from 'vitest';
import { buildPex, float, id, int, none, str } from '../../../tests/helpers/pex-builder.ts';
import { disassemble } from './disassemble.ts';
import { parsePex } from './pex.ts';

const script = buildPex({
  name: 'HouseScript',
  parent: 'Quest',
  variables: [
    ['::Rooms_var', 'Int', int(3)],
    ['::Name_var', 'String', str('Breezehome')],
  ],
  properties: [['Rooms', 'Int', '::Rooms_var']],
  functions: [
    {
      name: 'AddRoom',
      returnType: 'Int',
      params: [['aiCount', 'Int']],
      locals: [['::temp0', 'Int']],
      code: [
        ['iadd', id('::temp0'), id('::Rooms_var'), id('aiCount')],
        ['assign', id('::Rooms_var'), id('::temp0')],
        ['callmethod', id('Enable'), id('::Marker_var'), id('::NoneVar'), none, float(1.5)],
        ['jmpf', id('::temp0'), int(2)],
        ['return', id('::temp0')],
        ['return', int(-1)],
      ],
    },
    { name: 'GetValue', returnType: 'Float', native: true },
  ],
  states: [
    {
      name: 'Busy',
      functions: [{ name: 'AddRoom', returnType: 'Int', params: [['aiCount', 'Int']] }],
    },
  ],
});

describe('PEX', () => {
  it('reads objects, variables, properties, states and code', () => {
    const pex = parsePex(script);
    expect(pex.majorVersion).toBe(3);
    expect(pex.sourceFile).toBe('HouseScript.psc');
    const [object] = pex.objects;
    expect(object?.name).toBe('HouseScript');
    expect(object?.parent).toBe('Quest');
    expect(object?.variables.map((v) => [v.name, v.type, v.initial])).toEqual([
      ['::Rooms_var', 'Int', { kind: 'int', value: 3 }],
      ['::Name_var', 'String', { kind: 'string', value: 'Breezehome' }],
    ]);
    expect(object?.properties[0]).toMatchObject({
      name: 'Rooms',
      type: 'Int',
      autoVariable: '::Rooms_var',
    });
    expect(object?.states.map((s) => s.name)).toEqual(['', 'Busy']);
    const [addRoom, getValue] = object?.states[0]?.functions ?? [];
    expect(addRoom?.params).toEqual([{ name: 'aiCount', type: 'Int' }]);
    expect(addRoom?.code.map((i) => i.op)).toEqual([
      'iadd',
      'assign',
      'callmethod',
      'jmpf',
      'return',
      'return',
    ]);
    // Variable arguments of a call follow its three fixed ones.
    expect(addRoom?.code[2]?.args).toEqual([
      id('Enable'),
      id('::Marker_var'),
      id('::NoneVar'),
      none,
      float(1.5),
    ]);
    expect(addRoom?.code[5]?.args).toEqual([int(-1)]);
    expect(getValue?.native).toBe(true);
  });

  it('disassembles with jump targets', () => {
    const text = disassemble(parsePex(script));
    expect(text).toContain('ScriptName HouseScript extends Quest');
    expect(text).toContain('Int Function AddRoom(Int aiCount)');
    expect(text).toContain('jmpf ::temp0 @5');
    expect(text).toContain('State Busy');
  });

  it('rejects other files and inconsistent objects', () => {
    expect(() => parsePex(Uint8Array.from([0xde, 0xc0, 0x57, 0xfa, 3, 2]))).toThrow(/Not a PEX/);
    expect(() => parsePex(buildPex({ name: 'Bad', corruptSize: true }))).toThrow(/size/);
    expect(() => parsePex(script.subarray(0, script.length - 3))).toThrow();
  });
});
