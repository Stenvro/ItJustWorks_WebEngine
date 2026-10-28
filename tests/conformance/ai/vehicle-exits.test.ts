// A rider getting out of its vehicle (docs/ai.md, the riders of a vehicle): what wants it
// elsewhere waits for its exit to end, and its graph leaves Cart_State as the exit ends.

import { describe, expect, it } from 'vitest';
import type { GraphEvent } from '../../../src/animation/graph-events.ts';
import { ActorVehicles, type ActorVehiclesOptions } from '../../../src/shell/actor-vehicles.ts';

const RIDER = 0x1234;
const CART = 0x5678;

/** A stage with one rider of a vehicle no cart pulls, and the rider's graph's events. */
function riding(): { vehicles: ActorVehicles; sent: string[] } {
  const actors = new Map<number, { vehicle?: number }>([[RIDER, { vehicle: CART }]]);
  const runtime = {
    state: { actors },
    placement: () => Promise.resolve({ position: [0, 0, 0], rotation: [0, 0, 0] }),
  };
  const options = {
    session: { scriptsReady: runtime },
    movers: { stop: () => undefined, release: () => undefined },
  } as unknown as ActorVehiclesOptions;
  const vehicles = new ActorVehicles(options);
  vehicles.changed(RIDER);
  return { vehicles, sent: [] };
}

const events = (...names: string[]): GraphEvent[] => names.map((name) => ({ name, text: name }));

describe('ActorVehicles', () => {
  it('lets a rider whose exit began get off only as its exit ends', async () => {
    const { vehicles, sent } = riding();
    const graph = {
      sendEvent: (name: string): boolean => {
        sent.push(name);
        return true;
      },
    };
    // The vehicle's place is read (a vehicle no cart pulls stands where it is placed).
    await Promise.resolve();
    vehicles.riderEvents(RIDER, graph, events('ExitCartBegin'));
    let off = false;
    void vehicles.alight(RIDER).then(() => {
      off = true;
    });
    await Promise.resolve();
    expect(off).toBe(false);
    // The prisoner's exit clip ends bound standing: its graph leaves Cart_State.
    vehicles.riderEvents(RIDER, graph, events('OffsetBoundStandingCartStart'));
    expect(sent).toEqual(['CartExit']);
    vehicles.riderEvents(RIDER, graph, events('ExitCartEnd'));
    await Promise.resolve();
    expect(off).toBe(true);
  });

  it('gets a sitting rider off at once', async () => {
    const { vehicles } = riding();
    await expect(vehicles.alight(RIDER)).resolves.toBeUndefined();
  });

  it('ends Cart_State for a rider whose ride ended before its exit clip', () => {
    const { vehicles, sent } = riding();
    vehicles.release(RIDER);
    const graph = {
      sendEvent: (name: string): boolean => {
        sent.push(name);
        return true;
      },
    };
    vehicles.riderEvents(RIDER, graph, events('OffsetBoundStandingCartStart'));
    expect(sent).toEqual(['CartExit']);
  });
});
