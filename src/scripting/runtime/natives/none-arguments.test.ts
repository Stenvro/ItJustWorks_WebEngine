import { describe, expect, it } from 'vitest';
import type { NativeCall, PapyrusVm } from '../../papyrus-vm.ts';
import { ObjectHandle, type Value } from '../../values.ts';
import { NONE_ARGUMENT_CHECKS, withNoneChecks } from './none-arguments.ts';

const call = (args: readonly Value[], self: ObjectHandle | null = null): NativeCall => ({
  vm: undefined as unknown as PapyrusVm,
  self,
  args,
  name: 'test',
  latent: (promise) => promise,
  where: () => '[stack]',
});

describe("the natives' checks of a None argument", () => {
  it("logs the original's line and returns its result instead of running the native", async () => {
    const lines: string[] = [];
    let ran = 0;
    const find = withNoneChecks(
      'formlist.find',
      () => {
        ran++;
        return 3;
      },
      (line) => lines.push(line),
    );
    expect(await find(call([null]))).toBe(-1);
    expect(lines).toEqual(['[stack]: Cannot find a None form']);
    expect(ran).toBe(0);
    expect(await find(call([new ObjectHandle(0x14, 'form')]))).toBe(3);
    expect(ran).toBe(1);
  });

  it('checks each argument in order, and writes a lower-case line after its object', async () => {
    const lines: string[] = [];
    const constraint = withNoneChecks(
      'game.addhavokballandsocketconstraint',
      () => true,
      (line) => lines.push(line),
    );
    const ref = new ObjectHandle(0x14, 'form');
    expect(await constraint(call([ref, 'a', null, 'b']))).toBe(false);
    expect(lines).toEqual([
      '[stack]: none second reference passed in to AddHavokBallAndSocketConstraint',
    ]);
    const moveTo = withNoneChecks(
      'objectreference.moveto',
      () => null,
      (line) => lines.push(line),
    );
    await moveTo(call([null], ref));
    expect(lines.at(-1)).toMatch(/^\[stack\]: \[.*\] cannot be moved to a None object's location$/);
  });

  it('leaves the natives without a check as they are', () => {
    const fn = (): Value => null;
    expect(withNoneChecks('objectreference.removeitem', fn, () => undefined)).toBe(fn);
    expect(NONE_ARGUMENT_CHECKS.size).toBeGreaterThan(100);
  });
});
