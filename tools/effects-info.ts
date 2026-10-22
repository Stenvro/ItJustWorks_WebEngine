// Effect shaders, hazards and harvestable flora against the real files
// (src/world/effect-shader-records.ts, hazard-records.ts, flora-records.ts).
//
//   node tools/effects-info.ts --audit          every EFSH, HAZD, FLOR and TREE read: counts,
//                                               what reads oddly, flora with a harvested look
//   node tools/effects-info.ts LifeDetected     one record (editor id or hex form id): an
//                                               EFSH's membrane and particles, a HAZD's data,
//                                               a FLOR's or TREE's ingredient and seasons

import { parseArgs } from 'node:util';
import { parseNif } from '../src/formats/nif/nif.ts';
import { buildModel } from '../src/render/model-data.ts';
import { baseModelPath } from '../src/world/cell-records.ts';
import { parseEffectShader } from '../src/world/effect-shader-records.ts';
import { parseFlora } from '../src/world/flora-records.ts';
import { HazardFlag, parseHazard } from '../src/world/hazard-records.ts';
import { RecordDatabase, type GameRecord } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { audit: { type: 'boolean', default: false } },
});

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const TYPES = ['EFSH', 'HAZD', 'FLOR', 'TREE'];
const hex = (formId: number | undefined): string =>
  formId === undefined ? '-' : formId.toString(16).toUpperCase().padStart(8, '0');
const name = async (formId: number | undefined): Promise<string> =>
  formId === undefined ? '-' : ((await db.get(formId))?.editorId ?? hex(formId));

async function find(wanted: string): Promise<GameRecord | undefined> {
  if (/^(0x)?[0-9a-f]{1,8}$/i.test(wanted)) {
    const record = await db.get(Number.parseInt(wanted, 16));
    if (record) return record;
  }
  for (const type of TYPES) {
    for (const formId of db.formIdsOfType(type)) {
      const record = await db.get(formId);
      if (record?.editorId?.toLowerCase() === wanted.toLowerCase()) return record;
    }
  }
  return undefined;
}

/** NiSwitchNodes of a model (flora: a harvested look), 0 where it cannot be read. */
async function switches(record: GameRecord): Promise<number> {
  const path = baseModelPath(record);
  if (!path || !vfs.has(path)) return 0;
  try {
    return buildModel(parseNif(await vfs.read(path))).switches ?? 0;
  } catch {
    return 0;
  }
}

if (values.audit) {
  const counts = new Map<string, number>();
  const odd: string[] = [];
  let harvestable = 0;
  let harvestedLooks = 0;
  for (const type of TYPES) {
    for (const formId of db.formIdsOfType(type)) {
      const record = await db.get(formId);
      if (!record || record.deleted) continue;
      counts.set(type, (counts.get(type) ?? 0) + 1);
      if (type === 'EFSH') {
        const shader = parseEffectShader(record);
        if (shader.membrane.sourceBlend > 11 || shader.particles.sourceBlend > 11)
          odd.push(`${record.editorId ?? hex(formId)}: blend modes`);
      } else if (type === 'HAZD') {
        const hazard = parseHazard(record);
        if (hazard.radius < 0 || hazard.lifetime < 0 || hazard.flags > 0x1f)
          odd.push(
            `${hazard.editorId}: radius ${String(hazard.radius)} flags ${String(hazard.flags)}`,
          );
      } else {
        const flora = parseFlora(record);
        if (!flora) continue;
        harvestable++;
        if ((await switches(record)) > 0) harvestedLooks++;
        const ingredient = await db.get(flora.ingredient);
        if (!ingredient) odd.push(`${flora.editorId}: ingredient ${hex(flora.ingredient)} missing`);
      }
    }
  }
  console.log([...counts].map(([type, count]) => `${type} ${String(count)}`).join(', '));
  console.log(
    `harvestable flora ${String(harvestable)}, with a harvested look ${String(harvestedLooks)}`,
  );
  console.log(odd.length === 0 ? 'nothing odd' : odd.join('\n'));
} else {
  for (const wanted of positionals) {
    const record = await find(wanted);
    if (!record) {
      console.log(`${wanted}: not found`);
      continue;
    }
    console.log(`${record.type} ${record.editorId ?? ''} [${hex(record.formId)}]`);
    if (record.type === 'EFSH') {
      const shader = parseEffectShader(record);
      const m = shader.membrane;
      const p = shader.particles;
      console.log(
        `  flags 0x${shader.flags.toString(16)}, fill ${shader.fillTexture || '-'}, palette ${shader.membranePalette || '-'}`,
      );
      console.log(
        `  membrane blend ${String(m.sourceBlend)}/${String(m.destBlend)} z ${String(m.zTest)}, fill in ${String(m.fill.fadeIn)} full ${String(m.fill.full)} out ${String(m.fill.fadeOut)} persistent ${String(m.fill.persistent)} ratio ${String(m.fill.fullRatio)}, scroll ${m.scroll.join(' ')}`,
      );
      console.log(
        `  edge colour ${m.edgeColor.map((c) => Math.round(c * 255)).join(' ')} falloff ${String(m.edgeFalloff)}, in ${String(m.edge.fadeIn)} full ${String(m.edge.full)} out ${String(m.edge.fadeOut)}`,
      );
      console.log(
        `  particles ${shader.particleTexture || '-'} (${String(p.textureCountU)}x${String(p.textureCountV)}), palette ${shader.particlePalette || '-'}, blend ${String(p.sourceBlend)}/${String(p.destBlend)} z ${String(p.zTest)}`,
      );
      console.log(
        `  birth up ${String(p.birthRampUp)} full ${String(p.fullBirthTime)} down ${String(p.birthRampDown)}: ${String(p.fullBirthRatio)}/s then ${String(p.persistentCount)}/s, life ${String(p.lifetime)}±${String(p.lifetimeVariation)}, scale ${p.scaleKeys.join(' → ')}`,
      );
    } else if (record.type === 'HAZD') {
      const hazard = parseHazard(record);
      const flags = Object.entries(HazardFlag)
        .filter(([, bit]) => (hazard.flags & bit) !== 0)
        .map(([flag]) => flag);
      console.log(
        `  model ${hazard.model ?? '-'}, limit ${String(hazard.limit)}, radius ${String(hazard.radius)} ft, lifetime ${String(hazard.lifetime)} s, interval ${String(hazard.targetInterval)} s, flags ${flags.join(' ') || 'none'}`,
      );
      console.log(
        `  spell ${await name(hazard.spell)}, light ${await name(hazard.light)}, sound ${await name(hazard.sound)}, image space ${await name(hazard.imageSpaceModifier)} within ${String(hazard.imageSpaceRadius)}`,
      );
    } else {
      const flora = parseFlora(record);
      if (!flora) {
        console.log('  no ingredient to harvest');
        continue;
      }
      console.log(
        `  ${flora.verb ?? 'Harvest'}: ${await name(flora.ingredient)}, sound ${await name(flora.sound)}, by season ${flora.production.join(' / ')} %, harvested look: ${(await switches(record)) > 0 ? 'yes' : 'no'}`,
      );
    }
  }
}
await db.close();
await vfs.close();
