// Conformance: combat dialogue (engine map: Combat > Combat dialogue) on the local game data: the
// range the lines' distance mults scale.
//
// Sources: observed in the original, the range is the attenuation max distance of the 3D dialogue
// output model, the default object DOP2 (Skyrim.esm: SOMDialogue3DDefault, SOPM ANAM 70 .. 3000).
// Ours: src/ai/combat-dialogue.ts dialogueLineRange. Skipped without game data.

import { beforeAll, describe, expect, it } from 'vitest';
import { COMBAT_LINE_RANGE, dialogueLineRange } from '../../../src/ai/combat-dialogue.ts';
import { DefaultObjects } from '../../../src/world/default-objects.ts';
import { RecordDatabase } from '../../../src/world/record-db.ts';
import { Vfs } from '../../../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../../../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('combat lines on the local game data', () => {
  let db: RecordDatabase;
  let defaults: DefaultObjects;

  beforeAll(async () => {
    db = await RecordDatabase.open(await Vfs.mount(openGameFolder()));
    defaults = await DefaultObjects.read(db);
  }, 120_000);

  it('their range is the 3D dialogue output model’s max distance (DOP2: 3000)  [original]', async () => {
    expect(await dialogueLineRange(db, defaults)).toBe(COMBAT_LINE_RANGE);
    // Without that default object no range limits them.
    expect(await dialogueLineRange(db, { get: () => undefined })).toBe(Number.POSITIVE_INFINITY);
  });
});
