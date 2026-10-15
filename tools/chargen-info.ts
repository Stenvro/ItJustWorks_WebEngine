// Shows what the race menu (character creation) offers: the playable races, and for one race
// and sex its face presets, head part lists, face part types, tint layers and the slider list
// as SetOptionSliders would send it (positions for the race's default look, or an NPC's).
//
//   node tools/chargen-info.ts                        the playable races
//   node tools/chargen-info.ts NordRace [m|f]         one race and sex (editor id or hex)
//   node tools/chargen-info.ts NordRace m --npc 7     slider positions of an actor base's face

import { HeadPartType } from '../src/world/actor-records.ts';
import { ChargenCatalog, morphTypeCounts } from '../src/gameplay/chargen-catalog.ts';
import {
  CHARGEN_CATEGORIES,
  appearanceFromNpc,
  buildSliders,
  defaultAppearance,
} from '../src/gameplay/chargen.ts';
import { TintMaskType } from '../src/world/chargen-records.ts';
import { GameSettings } from '../src/world/game-settings.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const args = process.argv.slice(2);
const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const settings = await GameSettings.read(db);
const catalog = await ChargenCatalog.open(
  db,
  morphTypeCounts((id) => settings.number(id)),
);
const hex = (formId: number): string => formId.toString(16).toUpperCase().padStart(8, '0');
const text = (gmst: string): string => settings.string(gmst) ?? gmst;
const editorId = async (formId: number): Promise<string> =>
  (await db.get(formId))?.editorId ?? hex(formId);
const nameOf = (values: Record<string, number>, value: number): string =>
  Object.entries(values).find(([, v]) => v === value)?.[0] ?? String(value);

try {
  const raceArg = args[0];
  if (raceArg === undefined) {
    console.log(`${String(catalog.races.length)} playable races:`);
    for (const race of catalog.races) {
      const data = await catalog.race(race.formId);
      const [male, female] = data?.sexes ?? [];
      console.log(
        `  ${hex(race.formId)} ${race.editorId} "${race.name}": presets ` +
          `${String(male?.presets.length)}/${String(female?.presets.length)}, hair colours ` +
          `${String(male?.hairColors.length)}/${String(female?.hairColors.length)}, complexions ` +
          `${String(male?.faceDetails.length)}/${String(female?.faceDetails.length)}, tint layers ` +
          `${String(male?.tintLayers.length)}/${String(female?.tintLayers.length)}`,
      );
    }
  } else {
    const raceId =
      catalog.races.find((race) => race.editorId.toLowerCase() === raceArg.toLowerCase())?.formId ??
      parseInt(raceArg, 16);
    const sex = args[1] === 'f' ? 1 : 0;
    const data = await catalog.raceData(raceId, sex);
    console.log(
      `${data.editorId} "${data.name}" ${sex ? 'female' : 'male'} (morph race ${data.morphRace})`,
    );
    console.log(`  ${data.description.replace(/\s+/g, ' ').slice(0, 160)}`);
    console.log(
      `  presets: ${(await Promise.all(data.presets.map((p) => Promise.resolve(p.editorId)))).join(', ')}`,
    );
    console.log(
      `  hair colours: ${(await Promise.all(data.hairColors.map((c) => editorId(c.formId)))).join(', ')}`,
    );
    console.log(
      `  complexions: ${(await Promise.all(data.faceDetails.map(editorId))).join(', ')} ` +
        `(default ${data.defaultFaceTexture === undefined ? '-' : await editorId(data.defaultFaceTexture)})`,
    );
    console.log(
      `  default head parts: ${(await Promise.all(data.defaultHeadParts.map(editorId))).join(', ')}`,
    );
    for (const [type, list] of [...data.headPartLists].sort((a, b) => a[0] - b[0])) {
      console.log(
        `  head parts ${nameOf(HeadPartType, type)}: ${String(list.length)} ` +
          `(${(await Promise.all(list.slice(0, 6).map(editorId))).join(', ')}${list.length > 6 ? ', ...' : ''})`,
      );
    }
    ['nose', 'brow', 'eyes', 'lips'].forEach((group, i) => {
      console.log(`  ${group} types: ${(data.morphTypes[i] ?? []).join(' ')}`);
    });
    for (const layer of data.tintLayers) {
      console.log(
        `  tint ${String(layer.index)} ${nameOf(TintMaskType, layer.type)}: ` +
          `${String(layer.presets.length)} presets, ${layer.mask ?? '(no mask)'}`,
      );
    }
    const npcAt = args.indexOf('--npc');
    const npcArg = npcAt >= 0 ? args[npcAt + 1] : undefined;
    const face = npcArg === undefined ? undefined : await catalog.face(parseInt(npcArg, 16));
    const appearance = face ? appearanceFromNpc(data, face) : defaultAppearance(data);
    console.log(`  sliders (${face ? `of ${face.editorId}` : 'default look'}):`);
    for (const category of CHARGEN_CATEGORIES) {
      for (const slider of buildSliders(data, appearance)) {
        if (!(slider.filterFlag & category.flag)) continue;
        console.log(
          `    ${text(category.label).padEnd(6)} ${String(slider.id).padStart(2)} ` +
            `${text(slider.label).padEnd(20)} ${slider.callback.padEnd(22)} ` +
            `${String(slider.min)}..${String(slider.max)} at ${String(Math.round(slider.position * 100) / 100)}` +
            ` step ${String(slider.interval)}`,
        );
      }
    }
  }
} finally {
  await db.close();
  await vfs.close();
}
