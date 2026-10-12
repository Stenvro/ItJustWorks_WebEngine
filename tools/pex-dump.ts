// Disassembles compiled Papyrus scripts from the game data (through the VFS).
//
//   node tools/pex-dump.ts byohhousescript       listing of scripts\byohhousescript.pex
//   node tools/pex-dump.ts --verify              parse every script in the load order

import { parseArgs } from 'node:util';
import { disassemble } from '../src/formats/pex/disassemble.ts';
import { parsePex } from '../src/formats/pex/pex.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { verify: { type: 'boolean', default: false } },
});

const vfs = await Vfs.mount(openGameFolder());
try {
  if (values.verify) {
    const scripts = vfs.list('scripts').filter((path) => path.endsWith('.pex'));
    let failed = 0;
    let instructions = 0;
    const start = performance.now();
    for (const path of scripts) {
      try {
        const script = parsePex(await vfs.read(path));
        for (const object of script.objects) {
          for (const state of object.states) {
            for (const fn of state.functions) instructions += fn.code.length;
          }
        }
      } catch (error) {
        failed++;
        if (failed <= 20)
          console.log(`  ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(
      `${scripts.length} scripts, ${failed} failed, ${instructions} instructions in ` +
        `${(performance.now() - start).toFixed(0)} ms`,
    );
    if (failed > 0) process.exitCode = 1;
  } else {
    if (positionals.length === 0) {
      console.error('Usage: node tools/pex-dump.ts <script name>... | --verify');
      process.exit(2);
    }
    for (const name of positionals) {
      const path = `scripts\\${name.toLowerCase().replace(/\.pex$/, '')}.pex`;
      console.log(disassemble(parsePex(await vfs.read(path))));
    }
  }
} finally {
  await vfs.close();
}
