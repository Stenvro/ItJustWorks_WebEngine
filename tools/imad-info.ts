// Image-space modifiers (IMAD) of the load order: what each one changes, or one modifier's
// timeline sampled at a few points.
//
//   node tools/imad-info.ts                  every modifier: duration and what it keys
//   node tools/imad-info.ts LowHealthImod    one modifier (editor id or hex form id) over time

import {
  evaluateModifier,
  IMAD_CINEMATIC_CHANNELS,
  IMAD_HDR_CHANNELS,
  parseImageSpaceModifier,
  type ImageSpaceModifier,
  type ModifierFrame,
} from '../src/world/image-space-modifier.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const hex = (id: number): string => id.toString(16).padStart(8, '0');
const n = (value: number): string => String(Number(value.toFixed(3)));

const modifiers: ImageSpaceModifier[] = [];
for (const id of db.formIdsOfType('IMAD')) {
  const record = await db.get(id);
  if (record && !record.deleted) modifiers.push(parseImageSpaceModifier(record));
}

/** The names of the curves that change something (a key off its neutral value). */
function keyed(modifier: ImageSpaceModifier): string[] {
  const names: string[] = [];
  const channelNames = new Map<number, string>(
    [...Object.entries(IMAD_HDR_CHANNELS), ...Object.entries(IMAD_CINEMATIC_CHANNELS)].map(
      ([name, index]) => [index, name],
    ),
  );
  modifier.channels.forEach((channel, index) => {
    const name = channelNames.get(index) ?? `channel${String(index)}`;
    if (channel.mult.some((key) => key.value !== 1)) names.push(`${name}×`);
    if (channel.add.some((key) => key.value !== 0)) names.push(`${name}+`);
  });
  const curves: [string, readonly { value: number }[]][] = [
    ['blur', modifier.blurRadius],
    ['doubleVision', modifier.doubleVision],
    ['radialBlur', modifier.radialBlur.strength],
    ['dof', modifier.depthOfField.strength],
    ['motionBlur', modifier.motionBlur],
  ];
  for (const [name, keys] of curves) if (keys.some((key) => key.value !== 0)) names.push(name);
  if (modifier.tint.some((key) => key.color[3] > 0)) names.push('tint');
  if (modifier.fade.some((key) => key.color[3] > 0)) names.push('fade');
  return names;
}

function describeFrame(frame: ModifierFrame): string {
  const parts: string[] = [];
  for (const [name, change] of Object.entries(frame.hdr)) {
    if (change.mult !== 1 || change.add !== 0)
      parts.push(`${name} ×${n(change.mult)}+${n(change.add)}`);
  }
  for (const name of ['saturation', 'brightness', 'contrast'] as const) {
    const change = frame[name];
    if (change.mult !== 1 || change.add !== 0)
      parts.push(`${name} ×${n(change.mult)}+${n(change.add)}`);
  }
  if (frame.tint[3] > 0) parts.push(`tint ${frame.tint.map(n).join(',')}`);
  if (frame.fade[3] > 0) parts.push(`fade ${frame.fade.map(n).join(',')}`);
  if (frame.blurRadius > 0) parts.push(`blur ${n(frame.blurRadius)}`);
  if (frame.doubleVision > 0) parts.push(`double vision ${n(frame.doubleVision)}`);
  const radial = frame.radialBlur;
  if (radial.strength > 0)
    parts.push(
      `radial ${n(radial.strength)} ramp ${n(radial.rampUp)} start ${n(radial.start)} down ${n(radial.rampDown)}/${n(radial.downStart)}`,
    );
  const field = frame.depthOfField;
  if (field.strength > 0)
    parts.push(
      `dof ${n(field.strength)} at ${n(field.distance)} over ${n(field.range)} (${field.mode}, radius ${String(field.blurRadius)}${field.sky ? '' : ', no sky'})`,
    );
  if (frame.motionBlur > 0) parts.push(`motion blur ${n(frame.motionBlur)}`);
  return parts.length > 0 ? parts.join('; ') : 'no change';
}

const query = process.argv[2];
if (query) {
  const wanted = query.toLowerCase();
  const modifier = modifiers.find(
    (m) => m.editorId.toLowerCase() === wanted || hex(m.formId) === wanted.padStart(8, '0'),
  );
  if (!modifier) throw new Error(`no image-space modifier ${query}`);
  console.log(
    `${hex(modifier.formId)} ${modifier.editorId}: ${modifier.animatable ? `animated over ${n(modifier.duration)} s` : 'static'}`,
  );
  const times = modifier.animatable ? [0, 0.25, 0.5, 0.75, 1] : [0];
  for (const time of times) {
    console.log(`  ${n(time).padStart(4)}: ${describeFrame(evaluateModifier(modifier, time))}`);
  }
} else {
  for (const modifier of modifiers) {
    const timing = modifier.animatable ? `${n(modifier.duration)} s` : 'static';
    console.log(
      `${hex(modifier.formId)} ${modifier.editorId.padEnd(40)} ${timing.padEnd(7)} ${keyed(modifier).join(' ')}`,
    );
  }
  console.log(`${String(modifiers.length)} image-space modifiers`);
}
await db.close();
await vfs.close();
