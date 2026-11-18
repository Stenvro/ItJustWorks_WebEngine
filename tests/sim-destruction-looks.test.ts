// The destructible objects' looks each frame: a reference shown as its cell shows it (no stage
// look, its collision its own) has nothing to bring up to date.

import { describe, expect, it } from 'vitest';
import type { RenderPort } from '../src/render/render-port.ts';
import type { CellObject } from '../src/world/cell-loader.ts';
import { DestructionLooks } from '../src/shell/destruction-looks.ts';
import type { GameSession } from '../src/shell/game-session.ts';

describe('destructible objects each frame', () => {
  it('a reference without a stage look is not asked whether it is enabled', () => {
    const looks = new DestructionLooks(
      { scriptsReady: undefined } as unknown as GameSession,
      {} as RenderPort,
      () => undefined,
      () => undefined,
    );
    let asked = 0;
    const visibility = { hidden: false };
    looks.add(
      { reference: 0x1234, baseType: 'STAT' } as CellObject,
      new Float32Array(16),
      visibility,
      () => {
        asked++;
        return true;
      },
    );
    for (let frame = 0; frame < 10; frame++) expect([...looks.scenes()]).toEqual([]);
    expect(asked).toBe(0);
    expect(visibility.hidden).toBe(false);
  });

  it('a reference whose base has no destruction data is not looked at again', async () => {
    const references = new Map<number, { destructionStage?: number }>();
    let read = 0;
    const counted = {
      get: (reference: number) => {
        read++;
        return references.get(reference);
      },
    };
    const runtime = {
      state: { references: counted },
      destruction: {
        destructible: (reference: number) => Promise.resolve(reference === 0x2),
        look: () => Promise.resolve(undefined),
      },
    };
    const looks = new DestructionLooks(
      { scriptsReady: runtime } as unknown as GameSession,
      {} as RenderPort,
      () => undefined,
      () => undefined,
    );
    const add = (reference: number): void => {
      looks.add(
        { reference, baseType: 'STAT' } as CellObject,
        new Float32Array(16),
        { hidden: false },
        () => true,
      );
    };
    add(0x1);
    add(0x2);
    Array.from(looks.scenes());
    await Promise.resolve();
    await Promise.resolve();
    read = 0;
    for (let frame = 0; frame < 10; frame++) Array.from(looks.scenes());
    // Only the destructible one's stage is read each frame.
    expect(read).toBe(10);
  });
});
