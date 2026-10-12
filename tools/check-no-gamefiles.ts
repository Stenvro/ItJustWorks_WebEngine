// Harde regel 1: nooit gamebestanden in de repo.
//
//   node tools/check-no-gamefiles.ts         gestagede bestanden (pre-commit-hook)
//   node tools/check-no-gamefiles.ts --all   alle bestanden in de index

import { spawnSync } from 'node:child_process';
import { detectGameFile, MAX_FILE_BYTES } from './gamefile-detect.ts';

function git(args: readonly string[]): Buffer {
  const result = spawnSync('git', args, { maxBuffer: MAX_FILE_BYTES + 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} faalde: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

const all = process.argv.includes('--all');
const listing = all
  ? git(['ls-files', '-z'])
  : git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']);
const paths = listing
  .toString('utf8')
  .split('\0')
  .filter((path) => path.length > 0);

const violations: string[] = [];
for (const path of paths) {
  // Lees de versie in de index (wat er gecommit wordt), niet de werkmap.
  const size = Number(
    git(['cat-file', '-s', `:${path}`])
      .toString()
      .trim(),
  );
  const head =
    size > MAX_FILE_BYTES
      ? new Uint8Array()
      : git(['cat-file', 'blob', `:${path}`]).subarray(0, 64);
  const reason = detectGameFile(path, size, head);
  if (reason) violations.push(`  ${path}  (${reason})`);
}

if (violations.length > 0) {
  console.error('Gamebestanden gevonden — deze mogen nooit in de repo (CLAUDE.md, harde regel 1):');
  console.error(violations.join('\n'));
  console.error('\nHaal ze uit de index met: git rm --cached <pad>');
  process.exit(1);
}
console.log(`Geen gamebestanden gevonden (${paths.length} bestanden gecontroleerd).`);
