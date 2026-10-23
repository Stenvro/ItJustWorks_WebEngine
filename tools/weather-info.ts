// Climates, weathers and region weather lists of the load order, checked against the files
// they name; one weather's sky at a time of day; the weather regions as the sky chooses them.
//
//   node tools/weather-info.ts                      every climate and weather, problems
//   node tools/weather-info.ts SkyrimClear 13.5     one weather at 13:30 (DefaultClimate)
//   node tools/weather-info.ts --regions            weather regions, climates' weather lifetimes
//   node tools/weather-info.ts --at Tamriel 20 -5   the player's weather region in a cell's middle

import { parseNif } from '../src/formats/nif/nif.ts';
import { skyState } from '../src/world/sky-state.ts';
import {
  parseClimate,
  parseRegionWeather,
  parseWeather,
  type ClimateRecord,
  type Rgb,
  type WeatherRecord,
} from '../src/world/weather.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { parseWeatherRegionArea, weatherRegionAt } from '../src/world/sky-weather.ts';
import { Worldspace } from '../src/world/worldspace.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const hex = (id: number): string => id.toString(16).padStart(8, '0');
const rgb = (c: Rgb): string => c.map((v) => Math.round(v * 255)).join(',');

const weathers = new Map<number, WeatherRecord>();
for (const id of db.formIdsOfType('WTHR')) {
  const record = await db.get(id);
  if (record && !record.deleted) weathers.set(id, parseWeather(record));
}
const climates = new Map<number, ClimateRecord>();
for (const id of db.formIdsOfType('CLMT')) {
  const record = await db.get(id);
  if (record && !record.deleted) climates.set(id, parseClimate(record));
}

const query = process.argv[2];
if (query === '--regions') {
  for (const climate of climates.values()) {
    const hours = Math.trunc((255 - climate.volatility) * 22) / 255 + 1;
    console.log(
      `${hex(climate.formId)} ${climate.editorId}: a weather lasts ${hours.toFixed(2)} h`,
    );
  }
  for (const id of db.formIdsOfType('REGN')) {
    const record = await db.get(id);
    const region = record && parseWeatherRegionArea(record);
    if (!record || !region?.weather) continue;
    const tab = region.weather;
    const list = tab.weathers
      .map((w) => `${weathers.get(w.weather)?.editorId ?? hex(w.weather)} ${String(w.chance)}`)
      .join(', ');
    console.log(
      `${hex(id)} ${record.editorId ?? ''}: world ${hex(region.world ?? 0)}, ` +
        `${String(region.areas.length)} areas, priority ${String(tab.priority)}` +
        `${tab.override ? ' override' : ''}: ${list}`,
    );
  }
} else if (query === '--at') {
  const [name = 'Tamriel', cx = '0', cy = '0'] = process.argv.slice(3);
  const worldRecord = (await db.worldspaces()).find((w) => w.editorId === name);
  if (!worldRecord) throw new Error(`no worldspace ${name}`);
  const world = await Worldspace.open(db, worldRecord.formId);
  const [x, y] = [Number(cx), Number(cy)];
  const ids = await world.regions(x, y);
  const regions = await Promise.all(
    ids.map(async (id) => {
      const record = await db.get(id);
      return record && parseWeatherRegionArea(record);
    }),
  );
  for (const [i, id] of ids.entries()) {
    const tab = regions[i]?.weather;
    const editorId = (await db.get(id))?.editorId ?? '';
    console.log(`  ${hex(id)} ${editorId}${tab ? ` priority ${String(tab.priority)}` : ''}`);
  }
  const chosen = weatherRegionAt(regions, worldRecord.formId, (x + 0.5) * 4096, (y + 0.5) * 4096);
  const chosenName = chosen
    ? ((await db.get(chosen.formId))?.editorId ?? '')
    : 'none (the climate)';
  console.log(`weather region: ${chosenName}`);
} else if (query) {
  const weather = [...weathers.values()].find(
    (w) => w.editorId.toLowerCase() === query.toLowerCase(),
  );
  if (!weather) throw new Error(`no weather ${query}`);
  const climate = [...climates.values()].find((c) => c.editorId === 'DefaultClimate');
  const hour = Number(process.argv[3] ?? '12');
  const sky = skyState({ weather, climate, hour, daysPassed: 0, cloudMinutes: 0 });
  console.log(`${weather.editorId} at ${String(hour)}h, weights ${sky.weights.join(' ')}`);
  console.log(
    `  sky upper ${rgb(sky.skyUpper)} lower ${rgb(sky.skyLower)} horizon ${rgb(sky.horizon)}`,
  );
  console.log(
    `  sun ${rgb(sky.sunColor)} sunlight ${rgb(sky.sunlight)} glare ${sky.sunGlare.toFixed(2)}`,
  );
  console.log(`  sun direction ${sky.sunDirection.map((v) => v.toFixed(2)).join(' ')}`);
  console.log(
    `  fog ${rgb(sky.fogNear)} → ${rgb(sky.fogFar)}, ${sky.fogNearDistance.toFixed(0)}..${sky.fogFarDistance.toFixed(0)} pow ${sky.fogPower.toFixed(2)} max ${sky.fogMax.toFixed(2)}`,
  );
  console.log(`  ambient ${sky.ambient.colors.map(rgb).join(' | ')}`);
  console.log(
    `  stars ${rgb(sky.starsColor)}, masser ${sky.masser.alpha.toFixed(2)} ${sky.masser.texture}`,
  );
  for (const cloud of sky.clouds) {
    console.log(
      `  cloud ${String(cloud.layer).padStart(2)} ${cloud.texture} ${rgb(cloud.color)} alpha ${cloud.alpha.toFixed(2)}`,
    );
  }
  console.log(
    `  imagespaces ${sky.imageSpaces.map((i) => `${hex(i.formId)}×${i.weight.toFixed(2)}`).join(' ')}`,
  );
} else {
  const problems: string[] = [];
  const checkFile = (owner: string, path: string): void => {
    if (path !== '' && !vfs.has(path)) problems.push(`${owner}: missing ${path}`);
  };
  for (const climate of climates.values()) {
    const t = climate.timing;
    console.log(
      `${hex(climate.formId)} ${climate.editorId}: sunrise ${String(t.sunriseBegin)}-${String(t.sunriseEnd)}, sunset ${String(t.sunsetBegin)}-${String(t.sunsetEnd)}, ` +
        `moons ${climate.masser ? 'M' : '-'}${climate.secunda ? 'S' : '-'} phase ${String(climate.phaseLength)}d, ` +
        `${String(climate.weathers.length)} weathers, sky ${climate.skyModel}`,
    );
    checkFile(climate.editorId, climate.sunTexture);
    checkFile(climate.editorId, climate.sunGlareTexture);
    checkFile(climate.editorId, climate.skyModel);
    for (const entry of climate.weathers) {
      if (!weathers.has(entry.weather))
        problems.push(`${climate.editorId}: weather ${hex(entry.weather)} does not exist`);
    }
  }
  let regionLists = 0;
  for (const id of db.formIdsOfType('REGN')) {
    const record = await db.get(id);
    const region = record ? parseRegionWeather(record) : undefined;
    if (!region) continue;
    regionLists++;
    for (const entry of region.weathers) {
      if (!weathers.has(entry.weather))
        problems.push(
          `${record?.editorId ?? hex(id)}: weather ${hex(entry.weather)} does not exist`,
        );
    }
  }
  const layers = new Map<number, number>();
  let withDalc = 0;
  let withAurora = 0;
  for (const weather of weathers.values()) {
    const count = weather.clouds.filter((c) => c.texture !== '').length;
    layers.set(count, (layers.get(count) ?? 0) + 1);
    if (weather.directionalAmbient) withDalc++;
    if (weather.aurora !== '') {
      withAurora++;
      checkFile(weather.editorId, weather.aurora);
    }
    // Disabled or fully transparent layers often name textures that do not ship.
    for (const cloud of weather.clouds) {
      if (cloud.enabled && Math.max(...cloud.alphas) > 0)
        checkFile(weather.editorId, cloud.texture);
    }
    for (const fog of [weather.fog.dayFar, weather.fog.nightFar]) {
      if (!Number.isFinite(fog)) problems.push(`${weather.editorId}: fog distance ${String(fog)}`);
    }
  }
  console.log(
    `${String(weathers.size)} weathers (${String(withDalc)} with DALC, ${String(withAurora)} with aurora), ` +
      `${String(climates.size)} climates, ${String(regionLists)} region weather lists`,
  );
  console.log(
    'cloud textures per weather:',
    [...layers]
      .sort((a, b) => a[0] - b[0])
      .map(([n, c]) => `${String(n)}: ${String(c)}`)
      .join(', '),
  );
  const clouds = parseNif(await vfs.read('meshes\\sky\\clouds.nif'));
  const root = clouds.blocks[clouds.roots[0] ?? 0];
  console.log(`clouds.nif: ${String(root?.kind === 'node' ? root.children.length : 0)} layers`);
  console.log(problems.length === 0 ? 'no problems' : problems.join('\n'));
}
await db.close();
await vfs.close();
