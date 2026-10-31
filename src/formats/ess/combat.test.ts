import { describe, expect, it } from 'vitest';
import { CombatUnknown, combatTypeName, readCombatController, readCombatObject } from './combat.ts';
import { EssReader } from './ess-reader.ts';
import { EssWriter } from './ess-test-writer.ts';
import { PathingStream } from './movement.ts';
import { pathingTypeId } from './pathing-type.ts';

const resolve = (raw: number): number => raw & 0x3fffff;
const stream = (data: Uint8Array): PathingStream => new PathingStream(new EssReader(data), resolve);

/** A combat target selector, written the first time (id | 1, type, data). */
function selector(writer: EssWriter, id: number): EssWriter {
  return writer
    .u32(id | 1)
    .u32(pathingTypeId('CombatTargetSelectorStandard'))
    .refId(1, 0x14)
    .u32(0)
    .u32(0)
    .f32(1)
    .f32(2);
}

describe('combat AI objects', () => {
  it('keys the combat classes by their names, templates by their arguments mixed in', () => {
    // The original's id for the cover search, as the saves hold it.
    expect(combatTypeName(0x93409b55)).toBe('CombatCoverSearch');
    const magic =
      (pathingTypeId('CombatInventoryItemMagicT') ^
        pathingTypeId('CombatInventoryItemShout') ^
        pathingTypeId('CombatMagicCasterOffensive')) >>>
      0;
    expect(combatTypeName(magic)).toBe('CombatInventoryItemMagicT<Shout, Offensive>');
  });

  it('reads an object the first time, its id alone after', () => {
    const data = selector(new EssWriter(), 0x1000).u32(0x1000).u32(0).done();
    const s = stream(data);
    readCombatObject(s);
    readCombatObject(s);
    readCombatObject(s);
    expect(s.reader.remaining).toBe(0);
  });

  it('names a combat class it has no layout for', () => {
    const data = new EssWriter().u32(0x1001).u32(0x12345678).done();
    expect(() => {
      readCombatObject(stream(data));
    }).toThrow(CombatUnknown);
  });

  it('knows the 26 combat paths the original has, and no other request and destination', () => {
    const mix = (...names: string[]): number =>
      names.reduce((type, name) => type ^ pathingTypeId(name), 0) >>> 0;
    expect(
      combatTypeName(mix('CombatPathT', 'CombatPathRequestHover', 'CombatPathDestinationNone')),
    ).toBe('CombatPathT<Hover, None>');
    // The generic request's id: the hover request's name's with its two policies mixed in.
    const generic = mix(
      'CombatPathRequestHover',
      'CombatPathingGoalPolicyFindTargetLocation',
      'CombatPathingSearchPolicyStandard',
    );
    expect(combatTypeName(generic ^ mix('CombatPathT', 'CombatPathDestinationRef'))).toBe(
      'CombatPathT<FindTargetLocation, Ref>',
    );
    // A pairing no template of the original makes.
    expect(
      combatTypeName(mix('CombatPathT', 'CombatPathRequestHover', 'CombatPathDestinationRef')),
    ).toBeUndefined();
  });

  /** A path's own part as the original's CombatPath writes it, before its request. */
  function pathStart(w: EssWriter, id: number, request: string, destination: string): EssWriter {
    const type =
      pathingTypeId('CombatPathT') ^
      pathingTypeId(`CombatPathRequest${request}`) ^
      pathingTypeId(`CombatPathDestination${destination}`);
    // The id (first time), the type; the actor, three values, two timers, no speed controller.
    w.u32(id | 1)
      .u32(type >>> 0)
      .refId(1, 0x14)
      .u32(1)
      .u32(2)
      .u32(3);
    return w.f32(1).f32(2).f32(3).f32(4).u32(0);
  }
  /** A location: a point and the cell's reference. */
  const location = (w: EssWriter): EssWriter => w.f32(1).f32(2).f32(3).refId(1, 0x3c);
  /** A path point with no cell and no form (movement.ts). */
  const point = (w: EssWriter): EssWriter =>
    w.f32(1).f32(2).f32(3).u32(0).bytes([0, 0, 0]).u16(0xffff).u8(0).u8(0);

  it('reads the hover path: its request and the places to hover, a point and seven values each', () => {
    const w = pathStart(new EssWriter(), 0x10, 'Hover', 'None').u64(0n).vsval(2);
    for (let i = 0; i < 2; i++) {
      point(w);
      for (let j = 0; j < 7; j++) w.f32(j);
    }
    const s = stream(w.done());
    readCombatObject(s);
    expect(s.reader.remaining).toBe(0);
  });

  it('reads the flying paths and their destinations as the original writes them', () => {
    const w = new EssWriter();
    // Landing at a location: the flight request, the landing's reference and three values;
    // the destination's location and a value.
    pathStart(w, 0x20, 'Landing', 'Location').u64(0n).refId(1, 0x1234).u32(0).u32(0).u32(0);
    location(w).u32(5);
    // Orbiting a location: the flight request and a value.
    pathStart(w, 0x30, 'Orbit', 'Location').u64(0n).u32(9);
    location(w).u32(5);
    // A flying attack: the flight request and its target; no destination.
    pathStart(w, 0x40, 'FlyingAttack', 'None').u64(0n).refId(1, 0x14);
    // To references by weight: the request and the weights; the destination's reference with
    // its location, a value and a timer, then the references (a reference and a value each).
    pathStart(w, 0x50, 'WeightedMultiGoal', 'Refs').u64(0n).vsval(2).f32(0.5).f32(0.5);
    location(w.refId(1, 0x14)).u32(0).f32(0).f32(1);
    w.vsval(2).refId(1, 0x14).u32(0).refId(1, 0x15).u32(1);
    // To several locations: a location and a value each.
    pathStart(w, 0x60, 'MultiGoal', 'Locations').u64(0n).vsval(1);
    location(w).u32(0);
    const s = stream(w.done());
    for (let i = 0; i < 5; i++) readCombatObject(s);
    expect(s.reader.remaining).toBe(0);
  });

  it('reads the generic paths: the goal policy and the search policy after the request', () => {
    const generic = (goal: string, search: string, destination: string): number =>
      (pathingTypeId('CombatPathRequestHover') ^
        pathingTypeId(`CombatPathingGoalPolicy${goal}`) ^
        pathingTypeId(`CombatPathingSearchPolicy${search}`) ^
        pathingTypeId('CombatPathT') ^
        pathingTypeId(`CombatPathDestination${destination}`)) >>>
      0;
    const w = new EssWriter();
    // Searching: the path's part, the request; the goal's reference, its points (a list), a
    // point; the search policy's request and four flags; no destination.
    w.u32(0x71)
      .u32(generic('Search', 'Standard', 'None'))
      .refId(1, 0x14)
      .u32(0)
      .u32(0)
      .u32(0);
    w.f32(0).f32(0).f32(0).f32(0).u32(0).u64(0n);
    w.refId(1, 0x14).vsval(1).f32(1).f32(2).f32(3).f32(4).f32(5).f32(6);
    w.u64(0n).bytes([1, 0, 0, 0]);
    // Flanking a reference: two combat objects, the search, two more objects; the reference.
    w.u32(0x81)
      .u32(generic('Flank', 'Flank', 'Ref'))
      .refId(1, 0x14)
      .u32(0)
      .u32(0)
      .u32(0);
    w.f32(0).f32(0).f32(0).f32(0).u32(0).u64(0n);
    w.u32(0).u32(0).u64(0n).bytes([0, 0, 0, 0]).u32(0).u32(0);
    location(w.refId(1, 0x14)).u32(0).f32(0).f32(1);
    const s = stream(w.done());
    readCombatObject(s);
    readCombatObject(s);
    expect(s.reader.remaining).toBe(0);
  });

  it('reads a combat controller to its end', () => {
    const w = new EssWriter().refId(1, 0x1234).refId(1, 0x14).u32(7);
    w.bytes([1, 1, 0, 0, 0, 0]).f32(0).f32(0).f32(0);
    // No aim controllers (current and previous: none), no areas, one target selector, the
    // current and previous selectors (the same one, by id).
    w.vsval(0).i32(-1).i32(-1).vsval(0).i32(-1).vsval(1);
    selector(w, 0x2000).u32(0x2000).u32(0x2000);
    // The combat state.
    w.bytes(new Uint8Array(6 + 4 + 12 + 4 + 2 + 12 + 4 + 1 + 16 + 32));
    w.vsval(0)
      .vsval(1)
      .refId(1, 0x14)
      .u8(0)
      .bytes(new Uint8Array(24 + 4));
    // The inventory: its values, seven empty lists, two empty sets, four empty lists.
    w.bytes(new Uint8Array(40 + 1 + 4 + 8));
    for (let i = 0; i < 7; i++) w.vsval(0);
    for (let i = 0; i < 2; i++) w.vsval(0).bytes(new Uint8Array(20));
    w.vsval(0).vsval(0).vsval(0).vsval(0);
    // The blackboard: a timer and a time stamp.
    w.vsval(2).wstring('AcquireWeaponTimer').f32(1).f32(2).wstring('CoverSearchFailedTimeStamp');
    w.f32(3).u32(0);
    // The behaviour tree: a running tree's state (its size first), two trees, one named state.
    w.u32(0).u8(1).vsval(3).bytes([1, 2, 3]).vsval(2).u32(4).u32(5);
    w.vsval(1).wstring('Combat').u32(1).vsval(1).u32(2).vsval(1).u32(3).u32(4);
    const s = stream(w.done());
    expect(readCombatController(s)).toEqual({
      attacker: 0x1234,
      target: 0x14,
      blackboard: ['AcquireWeaponTimer', 'CoverSearchFailedTimeStamp'],
    });
    expect(s.reader.remaining).toBe(0);
  });
});
