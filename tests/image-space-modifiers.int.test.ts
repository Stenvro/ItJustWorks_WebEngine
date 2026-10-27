// Integration test: every image-space modifier (IMAD) of the local load order parses, its keys
// agree with DNAM's counts, and a few known ones evaluate as the Creation Kit shows them.
// Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  evaluateModifier,
  IMAD_CINEMATIC_CHANNELS,
  IMAD_DNAM_SIZE,
  modifierKeyTime,
  parseImageSpaceModifier,
  type ImageSpaceModifier,
} from '../src/world/image-space-modifier.ts';
import { ImageSpaceModifiers } from '../src/world/image-space-modifiers.ts';
import { NEUTRAL_IMAGE_SPACE } from '../src/world/image-space.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { DefaultObjects, DefaultObjectUse } from '../src/world/default-objects.ts';
import { parseVolumetricLighting } from '../src/world/volumetric-lighting.ts';
import { parseWeather } from '../src/world/weather.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

const ISM_TWEEN = 0x434bb;
const LOW_HEALTH = 0x10c445;
const FADE_TO_BLACK_HOLD = 0xf756e;

describe.skipIf(!hasGamedata())('image-space modifiers on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  const modifiers = new Map<number, ImageSpaceModifier>();

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    for (const formId of db.formIdsOfType('IMAD')) {
      const record = await db.get(formId);
      if (record && !record.deleted) modifiers.set(formId, parseImageSpaceModifier(record));
    }
  }, 60_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('parses every IMAD with keys matching the DNAM counts', async () => {
    expect(modifiers.size).toBeGreaterThan(200);
    for (const [formId, modifier] of modifiers) {
      const record = await db.get(formId);
      const dnam = record?.fields.first('DNAM');
      expect(dnam?.length, modifier.editorId).toBe(IMAD_DNAM_SIZE);
      if (!dnam) continue;
      const d = new DataView(dnam.buffer, dnam.byteOffset, dnam.byteLength);
      const count = (offset: number): number => d.getUint32(offset, true);
      modifier.channels.forEach((channel, i) => {
        expect(channel.mult.length, `${modifier.editorId} mult ${String(i)}`).toBe(
          count(8 + i * 8),
        );
        expect(channel.add.length, `${modifier.editorId} add ${String(i)}`).toBe(count(12 + i * 8));
      });
      expect(modifier.tint.length, modifier.editorId).toBe(count(0xb0));
      expect(modifier.blurRadius.length, modifier.editorId).toBe(count(0xb4));
      expect(modifier.radialBlur.strength.length, modifier.editorId).toBe(count(0xbc));
      expect(modifier.depthOfField.range.length, modifier.editorId).toBe(count(0xdc));
      expect(modifier.fade.length, modifier.editorId).toBe(count(0xec));
      expect(modifier.motionBlur.length, modifier.editorId).toBe(count(0xf0));
      // Every modifier evaluates to finite values along its timeline.
      for (const time of [0, 0.5, 1]) {
        const frame = evaluateModifier(modifier, time);
        expect(Number.isFinite(frame.brightness.add), modifier.editorId).toBe(true);
        expect(frame.fade.every(Number.isFinite), modifier.editorId).toBe(true);
      }
    }
  });

  it('reads ISMTween: a static darkening behind the menus', () => {
    const tween = modifiers.get(ISM_TWEEN);
    expect(tween?.editorId).toBe('ISMTween');
    if (!tween) return;
    expect(tween.animatable).toBe(false);
    const frame = evaluateModifier(tween, modifierKeyTime(tween, 10));
    expect(frame.brightness.add).toBeCloseTo(-0.15, 5);
    expect(frame.brightness.mult).toBe(1);
    expect(frame.fade[3]).toBe(0);
    const stack = new ImageSpaceModifiers();
    stack.apply(tween);
    stack.advance(5);
    expect(stack.modify(NEUTRAL_IMAGE_SPACE).brightness).toBeCloseTo(0.85, 5);
  });

  it('reads LowHealthImod: a one-second red pulse with blur', () => {
    const low = modifiers.get(LOW_HEALTH);
    expect(low?.editorId).toBe('LowHealthImod');
    if (!low) return;
    expect(low.animatable).toBe(true);
    expect(low.duration).toBe(1);
    expect(low.tint).toHaveLength(3);
    const peak = evaluateModifier(low, 0.36);
    expect(peak.tint[0]).toBeGreaterThan(0.9);
    expect(peak.tint[3]).toBeGreaterThan(0.05);
    expect(peak.blurRadius).toBeCloseTo(0.75, 5);
    expect(peak.radialBlur.strength).toBeCloseTo(0.1, 5);
    const end = evaluateModifier(low, 1);
    expect(end.tint[3]).toBe(0);
    expect(end.blurRadius).toBe(0);
  });

  it('reads FadeToBlackHoldImod: black at its start, held', () => {
    const hold = modifiers.get(FADE_TO_BLACK_HOLD);
    expect(hold?.editorId).toBe('FadeToBlackHoldImod');
    if (!hold) return;
    expect(hold.animatable).toBe(false);
    const frame = evaluateModifier(hold, modifierKeyTime(hold, 60));
    expect(frame.fade).toEqual([0, 0, 0, 1]);
    expect(frame.saturation.mult).toBe(1);
    expect(hold.channels[IMAD_CINEMATIC_CHANNELS.saturation]?.mult.length).toBeGreaterThan(0);
  });

  it('names LowHealthImod and the heartbeats as the low-health default objects', async () => {
    const defaults = await DefaultObjects.read(db);
    expect(defaults.get(DefaultObjectUse.lowHealthImageSpace)).toBe(LOW_HEALTH);
    const editorId = async (use: string): Promise<string | undefined> => {
      const formId = defaults.get(use);
      return formId === undefined ? undefined : (await db.get(formId))?.editorId;
    };
    expect(await editorId(DefaultObjectUse.heartbeatSlow)).toBe('UIHealthHeartbeatALPSD');
    expect(await editorId(DefaultObjectUse.heartbeatFast)).toBe('UIHealthHeartbeatBLPSD');
  });

  it("reads SkyrimClear's volumetric lighting by time of day; vanilla has no lens flares", async () => {
    let record: Awaited<ReturnType<RecordDatabase['get']>>;
    for (const formId of db.formIdsOfType('WTHR')) {
      const candidate = await db.get(formId);
      if (candidate?.editorId === 'SkyrimClear') record = candidate;
    }
    expect(record?.editorId).toBe('SkyrimClear');
    if (!record) return;
    const parsed = parseWeather(record);
    const day = parsed.volumetricLighting?.[1];
    expect(day).toBeDefined();
    const voli = day === undefined ? undefined : await db.get(day);
    expect(voli?.editorId).toBe('VLClearDay');
    if (voli) expect(parseVolumetricLighting(voli).intensity).toBe(2);
    expect(parsed.lensFlare).toBeUndefined();
    expect(db.formIdsOfType('LENS')).toEqual([]);
  });
});
