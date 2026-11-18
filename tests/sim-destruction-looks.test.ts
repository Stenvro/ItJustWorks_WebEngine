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
});
