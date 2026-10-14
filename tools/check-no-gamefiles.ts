// Hard rule 1: never game files in the repo.
//
//   node tools/check-no-gamefiles.ts             staged files (pre-commit hook)
//   node tools/check-no-gamefiles.ts --all       all files in the index
//   node tools/check-no-gamefiles.ts --history   every file in every commit of every branch
//                                                (CI: a game file committed and removed again
//                                                is still in the history)

import { spawnSync } from 'node:child_process';
import { detectGameFile, MAX_FILE_BYTES } from './gamefile-detect.ts';

function git(args: readonly string[]): Buffer {
  const result = spawnSync('git', args, { maxBuffer: MAX_FILE_BYTES + 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

if (process.argv.includes('--history')) {
  checkHistory();
  process.exit(0);
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
  // Read the version in the index (what gets committed), not the working tree.
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
  console.error(
    'Game files found — these must never be in the repo (README.md, "No game files in the repository"):',
  );
  console.error(violations.join('\n'));
  console.error('\nRemove them from the index with: git rm --cached <path>');
  process.exit(1);
}
console.log(`No game files found (${paths.length} files checked).`);

/** Every blob reachable from any ref, with a path it was committed under. */
function checkHistory(): void {
  const objects = new Map<string, string>();
  for (const line of git(['rev-list', '--objects', '--all']).toString('utf8').split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0 && !objects.has(line.slice(0, space))) {
      objects.set(line.slice(0, space), line.slice(space + 1));
    }
  }
  // One `git cat-file --batch` for all of them: "<sha> <type> <size>\n<content>\n" each.
  const result = spawnSync('git', ['cat-file', '--batch'], {
    input: [...objects.keys()].join('\n') + '\n',
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = result.stdout;
  const found: string[] = [];
  let blobs = 0;
  let offset = 0;
  while (offset < output.length) {
    const end = output.indexOf(10, offset);
    if (end < 0) break;
    const [sha = '', type = '', sizeText = '0'] = output
      .subarray(offset, end)
      .toString()
      .split(' ');
    const size = Number(sizeText);
    const content = output.subarray(end + 1, end + 1 + size);
    offset = end + 1 + size + 1;
    if (type !== 'blob') continue;
    blobs++;
    const path = objects.get(sha) ?? sha;
    const reason = detectGameFile(path, size, content.subarray(0, 64));
    if (reason) found.push(`  ${path} (${sha.slice(0, 10)}: ${reason})`);
  }
  if (found.length > 0) {
    console.error(
      'Game files in the history — they must never be in the repo (README.md, "No game files in the repository"):',
    );
    console.error(found.join('\n'));
    process.exit(1);
  }
  console.log(`No game files in the history (${String(blobs)} files checked).`);
}
