// Shows the game's input bindings (interface\controls\pc\controlmap.txt) per input context,
// with the keyboard keys as browser key codes.
//
//   node tools/controlmap-info.ts            main gameplay
//   node tools/controlmap-info.ts --all      every input context

import { parseControlMap, SCAN_CODES } from '../src/formats/controlmap/controlmap.ts';
import { decodeWindows1252 } from '../src/formats/text.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const PATH = 'interface\\controls\\pc\\controlmap.txt';
const vfs = await Vfs.mount(openGameFolder());
const map = parseControlMap(decodeWindows1252(await vfs.read(PATH)));
const contexts = process.argv.includes('--all') ? map.contexts : map.contexts.slice(0, 1);
const hex = (value: number): string => `0x${value.toString(16)}`;
contexts.forEach((events, index) => {
  console.log(`context ${String(index)} (${String(events.length)} events)`);
  for (const event of events) {
    const keys = event.keys
      .map((binding) => binding.map((code) => SCAN_CODES.get(code) ?? hex(code)).join('+'))
      .join(', ');
    const parts = [
      keys && `keys ${keys}`,
      event.mouse.length > 0 && `mouse ${event.mouse.map(hex).join(', ')}`,
      event.gamepad.length > 0 && `pad ${event.gamepad.map(hex).join(', ')}`,
      event.aliases.length > 0 && `as ${event.aliases.join(', ')}`,
      event.flags !== 0 && `flags ${hex(event.flags)}`,
    ].filter(Boolean);
    console.log(`  ${event.name.padEnd(20)} ${parts.join(' · ')}`);
  }
});
await vfs.close();
