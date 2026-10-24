// The AI packages of the load order counted (docs/ai.md, "Packages"): how many packages set each
// general flag (PKDT), each interrupt flag and interrupt override; how many run each procedure
// (their own tree or their template's) and how many branches of each type the trees have; and
// the procedures' flag overrides (PFO2 / PFOR): which flags they set and clear, and their speeds.
// The conformance suites sweep the class with it (tests/conformance/ai/).
//
//   node tools/package-census.ts

import {
  parsePackage,
  type PackageRecord,
  type ProcedureBranch,
} from '../src/ai/package-records.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { openGameFolder } from './gamedata-path.ts';

export interface PackageCensus {
  /** Packages (PKDT type 18) and templates (19). */
  readonly packages: number;
  readonly templates: number;
  /** Packages setting each general flag bit (PackageFlag), by bit. */
  readonly flags: ReadonlyMap<number, number>;
  /** Packages setting each interrupt flag bit (InterruptFlag; bits 0–9), by bit. */
  readonly interrupts: ReadonlyMap<number, number>;
  /** Packages by interrupt override (0 none .. 4 combat). */
  readonly interruptOverrides: ReadonlyMap<number, number>;
  /** Packages running each procedure (their tree's or their template's), by name. */
  readonly procedures: ReadonlyMap<string, number>;
  /** Branches of each type over every tree (Procedure, Sequence, Simultaneous, Stacked, Random). */
  readonly branchTypes: ReadonlyMap<string, number>;
  /** Branches with a flag override, by their procedure. */
  readonly overrides: ReadonlyMap<string, number>;
  /** Packages whose tree (their own or their template's) has a branch with a flag override. */
  readonly packagesWithOverrides: number;
  /** Flag overrides setting and clearing each general flag bit; setting each interrupt bit. */
  readonly overrideSets: ReadonlyMap<number, number>;
  readonly overrideClears: ReadonlyMap<number, number>;
  readonly overrideInterruptSets: ReadonlyMap<number, number>;
  readonly overrideInterruptClears: ReadonlyMap<number, number>;
  /** Flag overrides setting Preferred Speed, by the speed they bring (undefined: PFOR). */
  readonly overrideSpeeds: ReadonlyMap<number | undefined, number>;
}

const add = <K>(map: Map<K, number>, key: K): void => {
  map.set(key, (map.get(key) ?? 0) + 1);
};
const eachBit = (value: number, bits: number, use: (bit: number) => void): void => {
  for (let i = 0; i < bits; i++) if ((value & (1 << i)) !== 0) use((1 << i) >>> 0);
};
const procedures = (branch: ProcedureBranch, into: Set<string>): Set<string> => {
  if (branch.procedure) into.add(branch.procedure);
  for (const child of branch.children) procedures(child, into);
  return into;
};
const hasOverride = (branch: ProcedureBranch): boolean =>
  branch.flagOverride !== undefined || branch.children.some(hasOverride);

/** Counts the load order's packages (every PACK record, the winning one of each). */
export async function packageCensus(db: RecordDatabase): Promise<PackageCensus> {
  const all = new Map<number, PackageRecord>();
  for (const formId of db.formIdsOfType('PACK')) {
    const record = await db.get(formId);
    if (record && !record.deleted) all.set(formId, parsePackage(record));
  }
  let packages = 0;
  let templates = 0;
  let packagesWithOverrides = 0;
  const flags = new Map<number, number>();
  const interrupts = new Map<number, number>();
  const interruptOverrides = new Map<number, number>();
  const procedureCounts = new Map<string, number>();
  const branchTypes = new Map<string, number>();
  const overrides = new Map<string, number>();
  const overrideSets = new Map<number, number>();
  const overrideClears = new Map<number, number>();
  const overrideInterruptSets = new Map<number, number>();
  const overrideInterruptClears = new Map<number, number>();
  const overrideSpeeds = new Map<number | undefined, number>();
  const visit = (branch: ProcedureBranch): void => {
    add(branchTypes, branch.type);
    const override = branch.flagOverride;
    if (override) {
      add(overrides, branch.procedure ?? branch.type);
      eachBit(override.setFlags, 32, (bit) => {
        add(overrideSets, bit);
      });
      eachBit(override.clearFlags, 32, (bit) => {
        add(overrideClears, bit);
      });
      eachBit(override.setInterruptFlags, 10, (bit) => {
        add(overrideInterruptSets, bit);
      });
      eachBit(override.clearInterruptFlags, 10, (bit) => {
        add(overrideInterruptClears, bit);
      });
      if ((override.setFlags & 0x2000) !== 0) add(overrideSpeeds, override.preferredSpeed);
    }
    branch.children.forEach(visit);
  };
  for (const pack of all.values()) {
    if (pack.tree) visit(pack.tree);
    if (pack.type === 19) {
      templates++;
      continue;
    }
    packages++;
    eachBit(pack.flags, 32, (bit) => {
      add(flags, bit);
    });
    eachBit(pack.interruptFlags, 10, (bit) => {
      add(interrupts, bit);
    });
    add(interruptOverrides, pack.interruptOverride);
    const template = pack.template === undefined ? undefined : all.get(pack.template);
    const tree = template?.tree ?? pack.tree;
    if (!tree) continue;
    for (const name of procedures(tree, new Set())) add(procedureCounts, name);
    if (hasOverride(tree)) packagesWithOverrides++;
  }
  return {
    packages,
    templates,
    flags,
    interrupts,
    interruptOverrides,
    procedures: procedureCounts,
    branchTypes,
    overrides,
    packagesWithOverrides,
    overrideSets,
    overrideClears,
    overrideInterruptSets,
    overrideInterruptClears,
    overrideSpeeds,
  };
}

if (import.meta.main) {
  const vfs = await Vfs.mount(openGameFolder());
  const db = await RecordDatabase.open(vfs);
  const census = await packageCensus(db);
  const bits = (map: ReadonlyMap<number, number>): string =>
    [...map]
      .sort((a, b) => a[0] - b[0])
      .map(([bit, count]) => `0x${bit.toString(16)} ${String(count)}`)
      .join(', ');
  const byCount = <K>(map: ReadonlyMap<K, number>): string =>
    [...map]
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => `${String(key)} ${String(count)}`)
      .join(', ');
  console.log(`${String(census.packages)} packages, ${String(census.templates)} templates`);
  console.log(`general flags: ${bits(census.flags)}`);
  console.log(`interrupt flags: ${bits(census.interrupts)}`);
  console.log(`interrupt overrides: ${byCount(census.interruptOverrides)}`);
  console.log(`procedures (packages running them): ${byCount(census.procedures)}`);
  console.log(`branch types: ${byCount(census.branchTypes)}`);
  console.log(
    `flag overrides: ${byCount(census.overrides)} (${String(census.packagesWithOverrides)} packages)`,
  );
  console.log(`  set ${bits(census.overrideSets)}; clear ${bits(census.overrideClears)}`);
  console.log(
    `  interrupts set ${bits(census.overrideInterruptSets)}; clear ${bits(census.overrideInterruptClears)}`,
  );
  console.log(`  speeds (setting Preferred Speed): ${byCount(census.overrideSpeeds)}`);
  await db.close();
  await vfs.close();
}
