import { describe, expect, it } from 'vitest';
import type { Condition } from '../scripting/conditions.ts';
import {
  LocationType,
  TargetType,
  type PackageInput,
  type PackageRecord,
  type ProcedureBranch,
} from './package-records.ts';
import {
  conditionsHold,
  packageStart,
  scheduleFits,
  type GameTime,
  type PackageActor,
  type PackageReference,
  type PackageWorld,
  type Space,
} from './package-start.ts';

const TAMRIEL: Space = { kind: 'world', world: 0x3c };
const JAIL: Space = { kind: 'interior', cell: 0x580a2 };
const at = (hour: number, dayOfWeek = 0): GameTime => ({ hour, dayOfWeek, month: 7, date: 17 });

const condition = (fn: number, form: number, comparand: number, extra: Partial<Condition> = {}) =>
  ({
    function: fn,
    operator: 0,
    or: false,
    comparand,
    form,
    param2: 0,
    strings: [],
    runOn: 0,
    reference: 0,
    raw1: 0,
    form2: 0,
    param3: -1,
    eventMember: '',
    ...extra,
  }) satisfies Condition;

const procedure = (
  name: string,
  inputs: number[],
  conditions: Condition[] = [],
): ProcedureBranch => ({
  type: 'Procedure',
  conditions,
  branchFlags: 0,
  procedure: name,
  flags: 0,
  inputs,
  flagOverride: undefined,
  children: [],
});
const sequence = (...children: ProcedureBranch[]): ProcedureBranch => ({
  type: 'Sequence',
  conditions: [],
  branchFlags: 0,
  procedure: undefined,
  flags: 0,
  inputs: [],
  flagOverride: undefined,
  children,
});
const NO_EVENT = { idle: undefined, topic: undefined };

const pack = (
  formId: number,
  fields: Partial<PackageRecord> & { inputs?: PackageInput[] },
): PackageRecord => ({
  formId,
  editorId: `Package${formId.toString(16)}`,
  flags: 0,
  type: 0,
  interruptOverride: 0,
  preferredSpeed: 0,
  interruptFlags: 0,
  schedule: undefined,
  conditions: [],
  idles: undefined,
  combatStyle: undefined,
  ownerQuest: undefined,
  template: undefined,
  inputCount: 0,
  version: 0,
  inputs: [],
  tree: undefined,
  inputNames: [],
  onBegin: NO_EVENT,
  onEnd: NO_EVENT,
  onChange: NO_EVENT,
  ...fields,
});

/** Templates: Patrol (Patrol Start: input 0), Sleep (Travel to the sleep location: 0), Sit (16). */
const TEMPLATES = [
  pack(0x17723, { tree: sequence(procedure('Patrol', [0, 1])) }),
  pack(0x19717, { tree: sequence(procedure('Travel', [0, 11, 255]), procedure('Sleep', [2])) }),
  pack(0xa9277, { tree: sequence(procedure('Sit', [16]), procedure('Wait', [3])) }),
];

const REFERENCES = new Map<number, PackageReference>([
  [0x2c934, { space: TAMRIEL, baseType: 'IDLM', position: [0, 0, 0] }],
  [0xf50d5, { space: TAMRIEL, baseType: 'FURN', position: [0, 0, 0] }],
  [0xd46b7, { space: { kind: 'interior', cell: 0x36ed6 }, baseType: 'FURN', position: [0, 0, 0] }],
  [0x14, { space: TAMRIEL, baseType: 'NPC_', position: [0, 0, 0] }],
  // A sandbox's marker (in a hearth).
  [0xdddc9, { space: TAMRIEL, baseType: 'STAT', position: [-118, -374, 64] }],
]);

function world(packages: PackageRecord[], aliases: number[] | 'unknown' = []): PackageWorld {
  const all = new Map([...TEMPLATES, ...packages].map((entry) => [entry.formId, entry]));
  return {
    package: (formId) => Promise.resolve(all.get(formId)),
    reference: (formId) => Promise.resolve(REFERENCES.get(formId)),
    cellSpace: (cell) => Promise.resolve({ kind: 'interior', cell }),
    global: (formId) => (formId === 0x99 ? 1 : undefined),
    readGlobals: () => Promise.resolve(),
    questStage: () => 0,
    stageDone: (quest) => (quest === 0x77 ? undefined : false),
    questRunning: () => false,
    questCompleted: () => false,
    aliasPackages: () => Promise.resolve(aliases === 'unknown' ? undefined : aliases),
  };
}

const actor = (packages: number[], links: [number, number][] = []): PackageActor => ({
  reference: 0x37058,
  base: 0xd314c,
  npc: 0xd314c,
  race: 0x13746,
  female: false,
  factions: new Map([[0x2816c, 0]]),
  packages,
  space: TAMRIEL,
  linked: (keyword) => new Map(links).get(keyword),
});

const linkedTarget = (id: number): PackageInput => ({
  id,
  type: 'SingleRef',
  value: { kind: 'singleRef', target: { type: TargetType.linkedReference, value: 0, count: 0 } },
});
const schedule = (hour: number, hours: number, dayOfWeek = -1) => ({
  month: -1,
  dayOfWeek,
  date: 0,
  hour,
  minute: 0,
  duration: hours * 60,
});

describe('package schedules', () => {
  it('run from their hour for their duration, on through midnight', () => {
    const night = schedule(19, 12);
    expect(scheduleFits(night, at(18.9))).toBe(false);
    expect(scheduleFits(night, at(19))).toBe(true);
    expect(scheduleFits(night, at(2))).toBe(true);
    expect(scheduleFits(night, at(7))).toBe(false);
    expect(scheduleFits(undefined, at(3))).toBe(true);
  });

  it('take a night that began yesterday by yesterday’s day of the week', () => {
    // Weekdays (Morndas..Fredas) from 22:00 for 6 hours.
    const weekdayNights = schedule(22, 6, 7);
    expect(scheduleFits(weekdayNights, at(23, 5))).toBe(true);
    // 01:00 on Loredas: the night began on Fredas.
    expect(scheduleFits(weekdayNights, at(1, 6))).toBe(true);
    // 01:00 on Morndas: it began on Sundas.
    expect(scheduleFits(weekdayNights, at(1, 1))).toBe(false);
    expect(scheduleFits(schedule(-1, 0, 8), at(12, 0))).toBe(true);
    expect(scheduleFits(schedule(-1, 0, 9), at(12, 2))).toBe(false);
    expect(scheduleFits(schedule(-1, 0, 10), at(12, 4))).toBe(true);
  });
});

describe('package conditions', () => {
  const values = (byFunction: Record<number, number | undefined>) => (c: Condition) =>
    byFunction[c.function];
  it('hold, fail, or are not known as the known ones decide', () => {
    const a = condition(1, 0, 1);
    const b = condition(2, 0, 1);
    expect(conditionsHold([a, b], values({ 1: 1, 2: 1 }), () => undefined)).toBe(true);
    expect(conditionsHold([a, b], values({ 1: 0, 2: undefined }), () => undefined)).toBe(false);
    expect(conditionsHold([a, b], values({ 1: 1, 2: undefined }), () => undefined)).toBe(undefined);
    // a OR b: one known true is enough.
    const either = [{ ...a, or: true }, b];
    expect(conditionsHold(either, values({ 1: 1, 2: undefined }), () => undefined)).toBe(true);
    expect(conditionsHold(either, values({ 1: 0, 2: 0 }), () => undefined)).toBe(false);
    // Compared with a global.
    const global = { ...a, comparand: { global: 0x99 } };
    expect(conditionsHold([global], values({ 1: 1 }), (id) => (id === 0x99 ? 1 : undefined))).toBe(
      true,
    );
  });
});

describe('where packages put actors', () => {
  const patrol = pack(0x100, {
    template: 0x17723,
    schedule: schedule(7, 12),
    inputs: [linkedTarget(0)],
  });
  const sleep = pack(0x101, {
    template: 0x19717,
    schedule: schedule(19, 12),
    inputs: [
      {
        id: 0,
        type: 'Location',
        value: {
          kind: 'location',
          location: { type: LocationType.inCell, form: 0x580a2, radius: 0 },
        },
      },
    ],
  });
  const guard = actor([0x100, 0x101], [[0, 0x2c934]]);

  it('runs a scene package action alone, and stays where it got to once the action is done', async () => {
    // The scene's: to the cell the guard sleeps in, at any hour.
    const goToBed = { ...sleep, formId: 0x103, schedule: undefined };
    const scene = (packages: number[]): PackageWorld => ({
      ...world([patrol, sleep, goToBed], [0x100]),
      scenePackages: () => packages,
    });
    // By day the guard patrols (its alias's package too); a scene's action sends it away.
    expect(await packageStart(guard, scene([0x103]), at(10))).toMatchObject({
      kind: 'elsewhere',
      package: 0x103,
    });
    // The action's package done, the scene holds it where it is.
    expect(await packageStart(guard, scene([]), at(10))).toEqual({ kind: 'here' });
  });

  it('starts a patrol at its start, and sleeps in another cell at night', async () => {
    const data = world([patrol, sleep]);
    expect(await packageStart(guard, data, at(10))).toMatchObject({
      kind: 'at',
      reference: 0x2c934,
      procedure: 'Patrol',
      furniture: false,
    });
    expect(await packageStart(guard, data, at(23))).toMatchObject({
      kind: 'elsewhere',
      package: 0x101,
    });
    // In the cell it sleeps in, it is there.
    expect(await packageStart({ ...guard, space: JAIL }, data, at(23))).toMatchObject({
      kind: 'here',
    });
  });

  it('puts an actor in the furniture it sits in, here or in another cell', async () => {
    const sit = (target: number) =>
      pack(0x102, {
        template: 0xa9277,
        inputs: [
          {
            id: 16,
            type: 'SingleRef',
            value: {
              kind: 'singleRef',
              target: { type: TargetType.specificReference, value: target, count: 0 },
            },
          },
        ],
      });
    expect(await packageStart(actor([0x102]), world([sit(0xf50d5)]), at(10))).toMatchObject({
      kind: 'at',
      reference: 0xf50d5,
      furniture: true,
    });
    expect(await packageStart(actor([0x102]), world([sit(0xd46b7)]), at(10))).toMatchObject({
      kind: 'elsewhere',
    });
    // An actor target (the player) moves: the actor stays where it was placed.
    expect(await packageStart(actor([0x102]), world([sit(0x14)]), at(10))).toMatchObject({
      kind: 'here',
    });
  });

  it('keeps an actor placed within the area round a reference, else puts it near the reference', async () => {
    const sandbox = pack(0x106, {
      tree: procedure('Sandbox', [0]),
      inputs: [
        {
          id: 0,
          type: 'Location',
          value: {
            kind: 'location',
            location: { type: LocationType.nearReference, form: 0xdddc9, radius: 300 },
          },
        },
      ],
    });
    const data = world([sandbox]);
    const placedAt = (position: [number, number, number]) => ({
      ...actor([0x106]),
      position,
    });
    expect(await packageStart(placedAt([66, -580, 68]), data, at(10))).toMatchObject({
      kind: 'here',
      procedure: 'Sandbox',
    });
    expect(await packageStart(placedAt([900, -580, 68]), data, at(10))).toMatchObject({
      kind: 'at',
      reference: 0xdddc9,
      furniture: false,
      radius: 300,
    });
  });

  it('skips packages whose conditions fail and waits on those it cannot know', async () => {
    const notInFaction = pack(0x103, {
      template: 0x17723,
      conditions: [condition(71, 0x2816c, 0)],
      inputs: [linkedTarget(0)],
    });
    const unknownQuest = pack(0x104, {
      template: 0x17723,
      conditions: [condition(59, 0x77, 0, { param2: 10 })],
      inputs: [linkedTarget(0)],
    });
    const data = world([notInFaction, unknownQuest, patrol]);
    const linked: [number, number][] = [[0, 0x2c934]];
    // In the faction: the first does not run, the second's quest stage is not known.
    expect(await packageStart(actor([0x103, 0x104], linked), data, at(10))).toMatchObject({
      kind: 'undecided',
      package: 0x104,
    });
    expect(await packageStart(actor([0x103, 0x100], linked), data, at(10))).toMatchObject({
      kind: 'at',
      package: 0x100,
    });
  });

  it('reads its own package data in conditions, and leaves alias-held actors to their quests', async () => {
    const own = pack(0x105, {
      template: 0x17723,
      conditions: [condition(612, 40, 1)],
      inputs: [linkedTarget(0), { id: 40, type: 'Bool', value: { kind: 'bool', value: true } }],
    });
    const linked: [number, number][] = [[0, 0x2c934]];
    expect(await packageStart(actor([0x105], linked), world([own]), at(10))).toMatchObject({
      kind: 'at',
    });
    // Held by an alias whose packages are not known (no scripts run): left to its quest.
    expect(
      await packageStart(actor([0x105], linked), world([own], 'unknown'), at(10)),
    ).toMatchObject({
      kind: 'undecided',
    });
    // An alias's package comes before the actor's own.
    const sandbox = pack(0x106, {});
    expect(
      await packageStart(actor([0x105], linked), world([own, sandbox], [0x106]), at(10)),
    ).toMatchObject({ package: 0x106 });
    // Without its patrol start linked, where it patrols is not known.
    expect(await packageStart(actor([0x105]), world([own]), at(10))).toMatchObject({
      kind: 'undecided',
    });
  });
});
