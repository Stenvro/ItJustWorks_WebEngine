// The conformance report (docs/conformance.md): runs the conformance suites
// (tests/conformance/<area>/<system>.test.ts) with Vitest's JSON reporter, or reads such a
// report, and prints for every system of the engine map (docs/engine-map.md) how many cases it
// has and how many pass, fail, differ as known (it.fails) or are still to write (it.todo).
//
//   node tools/conformance-report.ts                  runs the suites (needs the game data)
//   node tools/conformance-report.ts --json report.json   reads a Vitest JSON report
//   npm run conformance

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  conformanceTable,
  formatTable,
  knownDifferenceLines,
  knownDifferenceTitles,
  parseEngineMap,
  type SuiteResult,
} from './conformance-table.ts';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const jsonAt = args.indexOf('--json');

/** What the JSON reporter writes (the parts read here). */
interface VitestReport {
  readonly testResults: readonly {
    readonly name: string;
    readonly assertionResults: readonly {
      readonly title: string;
      readonly status: string;
      readonly location?: { readonly line: number };
    }[];
  }[];
}

function isReport(value: unknown): value is VitestReport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'testResults' in value &&
    Array.isArray(value.testResults)
  );
}

/** Runs the suites; the path of the JSON report written. */
function runSuites(): string {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'conformance-')), 'report.json');
  const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
  const run = spawnSync(
    process.execPath,
    [
      vitest,
      'run',
      'tests/conformance',
      '--reporter=json',
      '--includeTaskLocation',
      `--outputFile=${out}`,
    ],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] },
  );
  if (!fs.existsSync(out)) {
    throw new Error(`the suites wrote no report (vitest exited ${String(run.status)})`);
  }
  return out;
}

const reportPath = jsonAt >= 0 ? path.resolve(args[jsonAt + 1] ?? '') : runSuites();
const report: unknown = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
if (!isReport(report)) throw new Error(`${reportPath} is not a Vitest JSON report`);

const suites: SuiteResult[] = report.testResults
  .filter((result) => /conformance[\\/]/.test(result.name))
  .map((result) => {
    let source = '';
    try {
      source = fs.readFileSync(result.name, 'utf8');
    } catch {
      // A report from elsewhere: its it.fails cases count as plain ones.
    }
    return {
      file: path.relative(root, result.name).replaceAll('\\', '/'),
      cases: result.assertionResults.map(({ title, status, location }) => ({
        title,
        status,
        ...(location && { line: location.line }),
      })),
      knownDifferences: knownDifferenceTitles(source),
      knownDifferenceLines: knownDifferenceLines(source),
    };
  });

const systems = parseEngineMap(fs.readFileSync(path.join(root, 'docs', 'engine-map.md'), 'utf8'));
console.log(formatTable(conformanceTable(systems, suites)));
