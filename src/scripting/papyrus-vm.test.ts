import { describe, expect, it } from 'vitest';
import {
  bool,
  buildPex,
  id,
  int,
  none,
  str,
  type BuildScript,
} from '../../tests/helpers/pex-builder.ts';
import { parsePex } from '../formats/pex/pex.ts';
import {
  PapyrusVm,
  type AttachedScriptInfo,
  type NativeFunction,
  type VmHost,
} from './papyrus-vm.ts';
import { ScriptLibrary } from './script-library.ts';
import { ObjectHandle, PapyrusArray, type Value } from './values.ts';

// A tiny world: a quest (0x10) with HouseScript, which extends BaseHouse; two markers (0x20,
// 0x21) that are ObjectReferences; ObjectReference.Enable/IsDisabled are natives.
const SCRIPTS: BuildScript[] = [
  { name: 'Form', functions: [{ name: 'GetFormID', returnType: 'Int', native: true }] },
  {
    name: 'ObjectReference',
    parent: 'Form',
    functions: [
      { name: 'Enable', native: true, params: [['abFade', 'Bool']] },
      { name: 'IsDisabled', returnType: 'Bool', native: true },
    ],
  },
  { name: 'Quest', parent: 'Form' },
  { name: 'Test', functions: [{ name: 'Forget', native: true }] },
  {
    name: 'BaseHouse',
    parent: 'Quest',
    variables: [['::Built_var', 'Int', int(0)]],
    properties: [['Built', 'Int', '::Built_var']],
    functions: [
      {
        name: 'Describe',
        returnType: 'String',
        locals: [['::t', 'String']],
        code: [
          ['strcat', id('::t'), str('built '), id('::Built_var')],
          ['return', id('::t')],
        ],
      },
    ],
  },
  {
    name: 'HouseScript',
    parent: 'BaseHouse',
    variables: [
      ['::Markers_var', 'ObjectReference[]', none],
      ['::Self_var', 'HouseScript', none],
    ],
    properties: [
      ['Markers', 'ObjectReference[]', '::Markers_var'],
      ['Me', 'HouseScript', '::Self_var'],
    ],
    functions: [
      {
        // Enables every marker; counts them in the parent's variable.
        name: 'BuildAll',
        returnType: 'Int',
        locals: [
          ['i', 'Int'],
          ['n', 'Int'],
          ['go', 'Bool'],
          ['ref', 'ObjectReference'],
          ['::NoneVar', 'None'],
        ],
        code: [
          ['array_length', id('n'), id('::Markers_var')],
          ['cmp_lt', id('go'), id('i'), id('n')],
          ['jmpf', id('go'), int(6)],
          ['array_getelement', id('ref'), id('::Markers_var'), id('i')],
          ['callmethod', id('Enable'), id('ref'), id('::NoneVar'), bool(false)],
          ['iadd', id('i'), id('i'), int(1)],
          ['assign', id('::Built_var'), id('i')],
          ['jmp', int(-6)],
          ['return', id('::Built_var')],
        ],
      },
      {
        name: 'Busy',
        code: [['assign', id('::State'), str('Working')]],
      },
      { name: 'Report', returnType: 'String', code: [['return', str('idle')]] },
      {
        name: 'Math',
        returnType: 'Float',
        locals: [
          ['a', 'Int'],
          ['f', 'Float'],
          ['s', 'String'],
          ['arr', 'Int[]'],
          ['k', 'Int'],
        ],
        code: [
          ['idiv', id('a'), int(7), int(2)], // 3
          ['imod', id('k'), int(7), int(2)], // 1
          ['iadd', id('a'), id('a'), id('k')], // 4
          ['cast', id('f'), id('a')],
          ['fdiv', id('f'), id('f'), int(8)], // 0.5
          ['cast', id('s'), int(12)],
          ['array_create', id('arr'), int(3)],
          ['array_setelement', id('arr'), int(1), int(9)],
          ['array_findelement', id('arr'), id('k'), int(9), int(0)], // 1
          ['cast', id('a'), id('s')], // 12
          ['iadd', id('a'), id('a'), id('k')], // 13
          ['cast', id('f'), id('a')],
          ['return', id('f')],
        ],
      },
      { name: 'Forever', code: [['jmp', int(0)]] },
      {
        // Its object lets go of its scripts meanwhile (an effect that ended), then it calls
        // its own function.
        name: 'ForgetThenDescribe',
        returnType: 'String',
        locals: [
          ['::t', 'String'],
          ['::NoneVar', 'None'],
        ],
        code: [
          ['callstatic', id('Test'), id('Forget'), id('::NoneVar')],
          ['callmethod', id('Describe'), id('self'), id('::t')],
          ['return', id('::t')],
        ],
      },
      {
        // Its object's scripts are reset meanwhile (it started its own quest), then it sets a
        // variable and describes itself.
        name: 'ForgetThenBuild',
        returnType: 'String',
        locals: [
          ['::t', 'String'],
          ['::NoneVar', 'None'],
        ],
        code: [
          ['callstatic', id('Test'), id('Forget'), id('::NoneVar')],
          ['callmethod', id('Describe'), id('self'), id('::t')],
          ['assign', id('::Built_var'), int(7)],
          ['return', id('::t')],
        ],
      },
    ],
    states: [
      {
        name: 'Working',
        functions: [{ name: 'Report', returnType: 'String', code: [['return', str('working')]] }],
      },
    ],
  },
];

class TestHost implements VmHost {
  readonly enabled = new Set<number>();
  readonly warnings: string[] = [];
  /** Test.Forget: the house's scripts are let go (PapyrusVm.reset). */
  forget: (() => void | Promise<void>) | undefined;

  formType(target: ObjectHandle): Promise<string | undefined> {
    return Promise.resolve(target.formId === 0x10 ? 'quest' : 'objectreference');
  }

  attachedScripts(target: ObjectHandle): Promise<readonly AttachedScriptInfo[]> {
    if (target.formId !== 0x10) return Promise.resolve([]);
    const markers = new PapyrusArray([
      new ObjectHandle(0x20, 'form'),
      new ObjectHandle(0x21, 'form'),
    ]);
    return Promise.resolve([
      {
        name: 'HouseScript',
        properties: new Map<string, Value>([
          ['markers', markers],
          ['me', new ObjectHandle(0x10, 'form')],
        ]),
      },
    ]);
  }

  native(script: string, fn: string): NativeFunction | undefined {
    if (script === 'objectreference' && fn === 'enable') {
      return ({ self }) => {
        if (self) this.enabled.add(self.formId);
        return null;
      };
    }
    if (script === 'objectreference' && fn === 'isdisabled') {
      return ({ self }) => !self || !this.enabled.has(self.formId);
    }
    if (script === 'test' && fn === 'forget') {
      return async () => {
        await this.forget?.();
        return null;
      };
    }
    return undefined;
  }

  warn(message: string): void {
    this.warnings.push(message);
  }
}

function setup(): { vm: PapyrusVm; host: TestHost; house: ObjectHandle } {
  const byName = new Map(SCRIPTS.map((s) => [s.name.toLowerCase(), parsePex(buildPex(s))]));
  const library = new ScriptLibrary((name) => Promise.resolve(byName.get(name)));
  const host = new TestHost();
  return { vm: new PapyrusVm(library, host), host, house: new ObjectHandle(0x10, 'HouseScript') };
}

describe('Papyrus VM', () => {
  it('runs loops over property arrays and calls natives on each element', async () => {
    const { vm, host, house } = setup();
    expect(await vm.call(house, 'BuildAll')).toBe(2);
    expect([...host.enabled]).toEqual([0x20, 0x21]);
    expect(host.warnings).toEqual([]);
  });

  it("shares the parent script's variables and properties with the child", async () => {
    const { vm, house } = setup();
    await vm.call(house, 'BuildAll');
    expect(await vm.getProperty(house, 'Built')).toBe(2);
    expect(await vm.call(house, 'Describe')).toBe('built 2');
    expect(await vm.getVariable(house, '::Built_var')).toBe(2);
    await vm.setProperty(house, 'Built', 5);
    expect(await vm.call(house.as('BaseHouse'), 'Describe')).toBe('built 5');
  });

  it('types handles by their declared property type and casts by the target type', async () => {
    const { vm, house } = setup();
    const me = await vm.getProperty(house, 'Me');
    expect(me).toBeInstanceOf(ObjectHandle);
    expect((me as ObjectHandle).type).toBe('housescript');
    expect(await vm.canBe(new ObjectHandle(0x10, 'form'), 'BaseHouse')).toBe(true);
    expect(await vm.canBe(new ObjectHandle(0x20, 'form'), 'HouseScript')).toBe(false);
  });

  it('keeps a running script on its own instance after its object lets it go', async () => {
    const { vm, host, house } = setup();
    host.forget = () => {
      vm.reset(house);
    };
    await vm.call(house, 'BuildAll');
    // Its own call still sees its variables (an ended effect's script reads its properties).
    expect(await vm.call(house, 'ForgetThenDescribe')).toBe('built 2');
    // Called anew, the object's scripts start over.
    expect(await vm.call(house, 'Describe')).toBe('built 0');
  });

  it('resets a running script in place: what it sets afterwards stays', async () => {
    const { vm, host, house } = setup();
    host.forget = () => vm.restart(house);
    await vm.call(house, 'BuildAll');
    // The reset reaches the running script (its variables are the plugin's again)...
    expect(await vm.call(house, 'ForgetThenBuild')).toBe('built 0');
    // ...and what it set after the reset is the object's.
    expect(await vm.call(house, 'Describe')).toBe('built 7');
    expect(await vm.getProperty(house, 'Markers')).toBeInstanceOf(PapyrusArray);
  });

  it('switches functions with the script state', async () => {
    const { vm, house } = setup();
    expect(await vm.call(house, 'Report')).toBe('idle');
    await vm.call(house, 'Busy');
    expect(await vm.call(house, 'Report')).toBe('working');
  });

  it('does integer and float arithmetic, casts and arrays like Papyrus', async () => {
    const { vm, house } = setup();
    expect(await vm.call(house, 'Math')).toBe(13);
  });

  it('stops endless loops and reports missing functions and natives', async () => {
    const { vm, host, house } = setup();
    // A runaway thread is stopped and reported, as the game logs a script error.
    expect(await vm.call(house, 'Forever')).toBeNull();
    expect(host.warnings.some((w) => w.includes('instructions without waiting'))).toBe(true);
    expect(await vm.call(house, 'NoSuchFunction')).toBeNull();
    expect(await vm.call(new ObjectHandle(0x20, 'objectreference'), 'GetFormID')).toBe(0);
    expect(host.warnings.some((w) => w.includes('NoSuchFunction'))).toBe(true);
    expect(host.warnings.some((w) => w.includes('Form.GetFormID is not implemented'))).toBe(true);
  });
});
