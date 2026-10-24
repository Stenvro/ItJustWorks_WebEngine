// Unit cases of the AI packages (tests/conformance/ai/): an actor's package runtime
// (src/ai/package-runtime.ts) on a mind and a body of the case's own, with records built in the
// case. The mind answers conditions by the forms a case marks true; the body records its travels.

import type { Condition } from '../../src/scripting/conditions.ts';
import type { Gait } from '../../src/ai/locomotion.ts';
import type {
  PackageFlagOverride,
  PackageRecord,
  ProcedureBranch,
} from '../../src/ai/package-records.ts';
import {
  ActorPackages,
  type PackageBody,
  type PackageMind,
  type ProcedureRunner,
} from '../../src/ai/package-runtime.ts';
import type { AiSettings } from '../../src/ai/ai-settings.ts';

export const procedure = (
  name: string,
  options: {
    readonly flags?: number;
    readonly conditions?: Condition[];
    readonly override?: PackageFlagOverride;
  } = {},
): ProcedureBranch => ({
  type: 'Procedure',
  conditions: options.conditions ?? [],
  branchFlags: 0,
  procedure: name,
  flags: options.flags ?? 0,
  inputs: [],
  flagOverride: options.override,
  children: [],
});

export const branch = (
  type: string,
  children: ProcedureBranch[],
  branchFlags = 0,
): ProcedureBranch => ({
  type,
  conditions: [],
  branchFlags,
  procedure: undefined,
  flags: 0,
  inputs: [],
  flagOverride: undefined,
  children,
});

export const pack = (
  formId: number,
  tree: ProcedureBranch,
  fields: Partial<PackageRecord> = {},
): PackageRecord => ({
  formId,
  editorId: `Pack${formId.toString(16)}`,
  flags: 0,
  type: 18,
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
  tree,
  inputNames: [],
  onBegin: { idle: undefined, topic: undefined },
  onEnd: { idle: undefined, topic: undefined },
  onChange: { idle: undefined, topic: undefined },
  ...fields,
});

/** A condition the fake mind holds while its form is marked true. */
export const condition = (form: number): Condition =>
  ({ function: 0, form, runOn: 0, operator: 0, comparand: 1, or: false }) as unknown as Condition;

/** An actor's packages on a fake mind and body. */
export function packageActor(
  packages: readonly PackageRecord[],
  runners: Readonly<Record<string, ProcedureRunner>>,
  options: {
    readonly settings?: AiSettings;
    readonly mind?: Partial<PackageMind>;
    readonly body?: Partial<PackageBody>;
  } = {},
) {
  const settings = options.settings;
  const truths = new Set<number>();
  const events: string[] = [];
  const gaits: Gait[] = [];
  const time = { hour: 10 };
  const mind: PackageMind = {
    time: () => ({ hour: time.hour, dayOfWeek: 0, month: 7, date: 17 }),
    day: () => 0,
    package: (formId) => Promise.resolve(packages.find((entry) => entry.formId === formId)),
    packagesOf: () => Promise.resolve(packages.map((entry) => entry.formId)),
    conditionsHold: (conditions) =>
      Promise.resolve(conditions.every((entry) => truths.has(entry.form))),
    place: () => Promise.resolve(undefined),
    target: () => Promise.resolve(undefined),
    placement: () => Promise.resolve(undefined),
    linked: () => Promise.resolve(undefined),
    around: () => Promise.resolve([]),
    idleMarker: () => Promise.resolve(undefined),
    search: () => Promise.resolve([]),
    carried: () => Promise.resolve(undefined),
    fakeFood: () => Promise.resolve(undefined),
    lockDoors: () => Promise.resolve(),
    ...(settings && { settings: () => settings }),
    packageEvent: (_actor, event, record) => {
      events.push(`${event} ${record.editorId}`);
    },
    ...options.mind,
  };
  const body: PackageBody = {
    reference: 1,
    position: () => [0, 0, 0],
    heading: () => 0,
    travel: (_to, gait) => {
      gaits.push(gait);
      return Promise.resolve(true);
    },
    stop: () => undefined,
    face: () => undefined,
    useFurniture: () => Promise.resolve(false),
    leaveFurniture: () => Promise.resolve(),
    takeIdleMarker: () => true,
    leaveIdleMarker: () => undefined,
    playIdle: () => Promise.resolve(true),
    say: () => undefined,
    activate: () => Promise.resolve(true),
    take: () => Promise.resolve(true),
    useItem: () => Promise.resolve(true),
    greet: () => true,
    standing: () => true,
    ...options.body,
  };
  const actor = new ActorPackages(1, mind, body, runners, () => 0);
  return { actor, truths, events, gaits, time };
}

/** One update of `seconds`, its async work let settle. */
export async function tick(actor: ActorPackages, seconds = 0.1): Promise<void> {
  actor.update(seconds);
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

/** A procedure that runs until the package is left (its run's stop), each wait one second. */
export const lasting: ProcedureRunner = async (run) => {
  while (!run.stopped()) await run.wait(1);
  return 'failure';
};

/** A procedure that travels once at the package's gait, then lasts. */
export const travelling: ProcedureRunner = async (run) => {
  await run.body.travel([0, 0, 0], run.gait, 0);
  return lasting(run);
};
