// Directional materials of the load order: every material object (MATO) with its values, how
// many statics use it and at which max angles, and the shader of the multi-pass ones.
//
//   node tools/material-info.ts                  every material object
//   node tools/material-info.ts IceShader01      one material and the statics using it

import { parseNif } from '../src/formats/nif/nif.ts';
import { propertyMaterial } from '../src/render/model-data.ts';
import {
  parseMaterialObject,
  parseStaticDirectional,
  projectedUVParams,
  type MaterialObject,
} from '../src/world/material-object.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const hex = (id: number): string => id.toString(16).padStart(8, '0');
const round = (value: number): string => String(Math.round(value * 1000) / 1000);

const materials = new Map<number, MaterialObject>();
for (const formId of db.formIdsOfType('MATO')) {
  const record = await db.get(formId);
  if (record && !record.deleted) materials.set(formId, parseMaterialObject(record));
}
/** Statics per material: editor id and max angle. */
const users = new Map<number, { editorId: string; maxAngle: number; snow: boolean }[]>();
let snowOnly = 0;
for (const formId of db.formIdsOfType('STAT')) {
  const record = await db.get(formId);
  const directional = record && parseStaticDirectional(record);
  if (!directional) continue;
  if (directional.material === 0) {
    snowOnly++;
    continue;
  }
  const list = users.get(directional.material) ?? [];
  list.push({
    editorId: record.editorId ?? hex(formId),
    maxAngle: directional.maxAngle,
    snow: directional.consideredSnow,
  });
  users.set(directional.material, list);
}

const describe = (material: MaterialObject): string => {
  const pass = material.singlePass
    ? `single pass, colour ${material.singlePassColor.map(round).join(',')}`
    : (() => {
        const { material: shader, alpha } = propertyMaterial(
          material.properties.map((data) => parseNif(data)),
        );
        if (!shader) return 'multi-pass without a shader';
        const texture =
          (shader.kind === 'lighting' ? shader.textures[0] : shader.sourceTexture) ?? '';
        const type = shader.kind === 'lighting' ? `type ${String(shader.shaderType)}` : 'effect';
        return `multi-pass ${type} ${texture === '' ? '(no texture)' : texture}${alpha ? ' alpha' : ''}`;
      })();
  return (
    `falloff ${round(material.falloffScale)}/${round(material.falloffBias)} noise ${round(material.noiseUVScale)} ` +
    `material ${round(material.materialUVScale)} direction ${material.projectionVector.map(round).join(',')} ` +
    `dampener ${round(material.normalDampener)} · ${pass}`
  );
};

const query = process.argv[2]?.toLowerCase();
if (query) {
  const entry = [...materials.entries()].find(([, m]) => m.editorId.toLowerCase() === query);
  if (!entry) throw new Error(`no material object ${query}`);
  const [formId, material] = entry;
  console.log(`${hex(formId)} ${material.editorId}: ${describe(material)}`);
  for (const user of users.get(formId) ?? []) {
    const [x, , z, w] = projectedUVParams(material, user.maxAngle);
    console.log(
      `  ${user.editorId} @${round(user.maxAngle)}°${user.snow ? ' snow' : ''}: params ${round(x)} ${z.toExponential(2)} ${round(w)}`,
    );
  }
} else {
  for (const [formId, material] of materials) {
    const list = users.get(formId) ?? [];
    const angles = [...new Set(list.map((user) => Math.round(user.maxAngle)))].sort(
      (a, b) => a - b,
    );
    console.log(
      `${hex(formId)} ${material.editorId.padEnd(32)} ${String(list.length).padStart(4)} statics` +
        `${angles.length > 0 ? ` @${angles.join('/')}` : ''}  ${describe(material)}`,
    );
  }
  console.log(`${String(snowOnly)} statics count as snow without a material`);
}
await db.close();
await vfs.close();
