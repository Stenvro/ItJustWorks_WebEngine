// Integration test: the sky's weather on the local game data: the weather region the player
// gets in a cell, the sky's mode of interiors and worldspaces, and days of weather run with
// the game's own regions, weathers and climate. Skipped without game data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCell } from '../src/world/cell-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import {
  parseWeatherRegionArea,
  SkyMode,
  skyModeAt,
  SkyWeather,
  weatherRegionAt,
  type WeatherRegionArea,
} from '../src/world/sky-weather.ts';
import { parseClimate, parseWeather, type WeatherRecord } from '../src/world/weather.ts';
import { WorldFlag, Worldspace } from '../src/world/worldspace.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('the sky weather on the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  const weathers = new Map<number, WeatherRecord>();

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
    for (const id of db.formIdsOfType('WTHR')) {
      const record = await db.get(id);
      if (record) weathers.set(id, parseWeather(record));
    }
  }, 60_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  const worldId = async (editorId: string): Promise<number> => {
    const world = (await db.worldspaces()).find((w) => w.editorId === editorId);
    if (!world) throw new Error(`${editorId} missing`);
    return world.formId;
  };
  const region = async (formId: number): Promise<WeatherRegionArea | undefined> => {
    const record = await db.get(formId);
    return record ? parseWeatherRegionArea(record) : undefined;
  };
  const named = (formId: number | undefined): string =>
    formId === undefined ? '-' : (weathers.get(formId)?.editorId ?? formId.toString(16));

  it('gives the player the weather region of the place: the city in Whiterun', async () => {
    const id = await worldId('WhiterunWorld');
    const world = await Worldspace.open(db, id);
    let found: string | undefined;
    for (let x = 3; x <= 7 && !found; x++) {
      for (let y = -5; y <= 0 && !found; y++) {
        const regions = await Promise.all((await world.regions(x, y)).map(region));
        const chosen = weatherRegionAt(regions, id, (x + 0.5) * 4096, (y + 0.5) * 4096);
        if (chosen) found = (await db.get(chosen.formId))?.editorId;
      }
    }
    expect(found).toBe('WeatherWhiterun');
  }, 60_000);

  it('every weather a region or climate lists exists', async () => {
    const missing: string[] = [];
    for (const id of db.formIdsOfType('REGN')) {
      const area = await region(id);
      for (const entry of area?.weather?.weathers ?? []) {
        if (!weathers.has(entry.weather)) missing.push(`REGN ${id.toString(16)}`);
      }
    }
    for (const id of db.formIdsOfType('CLMT')) {
      const record = await db.get(id);
      for (const entry of record ? parseClimate(record).weathers : []) {
        if (!weathers.has(entry.weather)) missing.push(`CLMT ${id.toString(16)}`);
      }
    }
    expect(missing).toEqual([]);
  }, 60_000);

  it("knows the sky's mode: Breezehome shows the dome of its region's weather", async () => {
    const cell = (await db.interiorCells()).find((c) => c.editorId === 'WhiterunBreezehome');
    const record = cell && (await db.get(cell.formId));
    if (!record) throw new Error('WhiterunBreezehome missing');
    const breezehome = parseCell(record);
    expect(skyModeAt({ interior: true, cellFlags: breezehome.flags })).toBe(SkyMode.skyDomeOnly);
    const skyRegion = breezehome.skyRegion;
    expect(skyRegion && (await db.get(skyRegion))?.editorId).toBe('WeatherWhiterun');
    // Blackreach has no sky but no lighting template of its own: the full sky's mode.
    const blackreach = await Worldspace.open(db, await worldId('Blackreach'));
    expect(blackreach.record.flags & WorldFlag.noSky).not.toBe(0);
    expect(
      skyModeAt({
        interior: false,
        lightingTemplate: blackreach.record.lightingTemplate !== undefined,
        noSky: true,
      }),
    ).toBe(SkyMode.full);
  }, 60_000);

  it("runs days of Whiterun's weather: a change about every 18.7 hours, each over its Trans Delta", async () => {
    const climateRecord = await db.get(0x812); // SkyrimClimate
    if (!climateRecord) throw new Error('SkyrimClimate missing');
    const climate = parseClimate(climateRecord);
    const whiterun = await db
      .formIdsOfType('REGN')
      .reduce<Promise<WeatherRegionArea | undefined>>(async (found, id) => {
        const before = await found;
        if (before) return before;
        const record = await db.get(id);
        return record?.editorId === 'WeatherWhiterun' ? parseWeatherRegionArea(record) : undefined;
      }, Promise.resolve(undefined));
    const list = whiterun?.weather?.weathers ?? [];
    expect(list.length).toBeGreaterThan(1);
    let seed = 7;
    let hour = 8;
    const sky = new SkyWeather({
      hour: () => hour % 24,
      weather: (id) => weathers.get(id),
      global: () => undefined,
      // A fixed sequence (a small LCG) so the run is the same each time.
      random: () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31,
    });
    sky.setClimate(climate);
    sky.enterExterior({ formId: 1, weathers: list });
    const changes: { at: number; weather: string; took: number | undefined }[] = [];
    let began: number | undefined;
    let last = -1;
    for (let step = 0; step < 72 * 100; step++) {
      hour = 8 + step / 100;
      sky.frame();
      if (sky.changes !== last) {
        last = sky.changes;
        changes.push({ at: hour, weather: named(sky.current), took: undefined });
        began = hour;
      }
      const change = changes[changes.length - 1];
      if (change && change.took === undefined && sky.outgoing === undefined && began !== undefined)
        change.took = hour - began;
    }
    // The first weather comes at once; then one about every 18.69 game hours.
    expect(changes.length).toBeGreaterThanOrEqual(4);
    expect(changes.length).toBeLessThanOrEqual(5);
    for (const change of changes.slice(1)) {
      expect(list.some((entry) => named(entry.weather) === change.weather)).toBe(true);
    }
    for (let i = 2; i < changes.length; i++) {
      const gap = (changes[i]?.at ?? 0) - (changes[i - 1]?.at ?? 0);
      expect(gap).toBeGreaterThan(18.6);
      expect(gap).toBeLessThan(19);
    }
    // Each change took its weather's span between fWeatherTransMin and Max (0.01..0.25 h).
    for (const change of changes.slice(1)) {
      const weather = [...weathers.values()].find((w) => w.editorId === change.weather);
      const span = (weather?.transDelta ?? 0) * 0.24 + 0.01;
      expect(change.took).toBeGreaterThanOrEqual(span - 0.011);
      expect(change.took).toBeLessThanOrEqual(span + 0.011);
    }
    // FindWeather(rainy) of the region: the rainy weather of the lowest chance.
    const rainy = list.filter(
      (entry) => ((weathers.get(entry.weather)?.flags ?? 0) & 0x4) !== 0 && entry.chance > 0,
    );
    const lowest = Math.min(...rainy.map((entry) => entry.chance));
    expect(rainy.find((entry) => entry.chance === lowest)?.weather).toBe(sky.findWeather(2));
  }, 60_000);
});
