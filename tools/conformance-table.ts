// The conformance table (docs/conformance.md, "The report"): the engine map's systems
// (docs/engine-map.md) with the cases of their suites, tests/conformance/<area>/<system>.test.ts,
// counted from a Vitest JSON report: passing, failing, known differences (it.fails) and still
// to write (it.todo). A system's status follows: complete when every case is written and passes,
// partial when some pass, missing when none do.

/** A row of the engine map: its area (the heading's first word) and system. */
export interface MapSystem {
  /** The area as suites name their folder: "scripting", "ai", "combat", ... */
  readonly area: string;
  /** The area's heading in the engine map. */
  readonly areaTitle: string;
  readonly system: string;
  /** The system as suites name their file: "story-manager", "package-evaluation", ... */
  readonly slug: string;
  /** The status the engine map gives it now. */
  readonly mapStatus: string;
}

/** A case's result as the JSON reporter gives it. */
export interface CaseResult {
  readonly title: string;
  readonly status: string;
}

/** A suite file's results. */
export interface SuiteResult {
  /** The file's path. */
  readonly file: string;
  readonly cases: readonly CaseResult[];
  /** The titles of its it.fails cases (known differences), read from its source. */
  readonly knownDifferences: ReadonlySet<string>;
}

export interface SystemCounts {
  readonly cases: number;
  readonly passing: number;
  readonly failing: number;
  /** it.fails cases that still fail as written (the known differences). */
  readonly differs: number;
  /** it.fails cases that pass now (to be turned into plain cases). */
  readonly fixed: number;
  readonly todo: number;
  /** Cases skipped (no game data). */
  readonly skipped: number;
}

export interface SystemRow extends MapSystem {
  readonly counts: SystemCounts | undefined;
  /** complete, partial, missing (from the counts), or no suite. */
  readonly status: 'complete' | 'partial' | 'missing' | 'no suite' | 'skipped';
}

/** A name as a file name: lower case, words joined by hyphens. */
export function slugOf(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The systems of the engine map's area tables. */
export function parseEngineMap(markdown: string): MapSystem[] {
  const systems: MapSystem[] = [];
  let areaTitle: string | undefined;
  let inAreas = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith('## ')) inAreas = line.trim() === '## Areas';
    if (!inAreas) continue;
    if (line.startsWith('### ')) {
      areaTitle = line.slice(4).trim();
      continue;
    }
    if (!areaTitle || !line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const [system, status] = cells;
    if (!system || !status || system === 'System' || /^-+$/.test(system)) continue;
    systems.push({
      area: slugOf(areaTitle.split(/[\s,]/)[0] ?? areaTitle),
      areaTitle,
      system,
      slug: slugOf(system),
      mapStatus: status,
    });
  }
  return systems;
}

/**
 * The titles of a suite's it.fails cases (test.fails too), read from its source: each title is
 * a single-quoted string or a concatenation of them, as the suites are written.
 */
export function knownDifferenceTitles(source: string): Set<string> {
  const titles = new Set<string>();
  const call = /\b(?:it|test)\.fails\(\s*((?:'(?:[^'\\]|\\.)*'\s*\+?\s*)+),/g;
  for (const match of source.matchAll(call)) {
    const pieces = (match[1] ?? '').match(/'(?:[^'\\]|\\.)*'/g) ?? [];
    titles.add(pieces.map((piece) => piece.slice(1, -1).replace(/\\(.)/g, '$1')).join(''));
  }
  return titles;
}

/** A suite file's area and system slugs (tests/conformance/<area>/<system>.test.ts). */
export function suiteSlugs(file: string): { area: string; slug: string } | undefined {
  const match = /conformance[\\/]([^\\/]+)[\\/]([^\\/]+?)(?:\.int)?\.test\.ts$/.exec(file);
  return match?.[1] && match[2] ? { area: match[1], slug: match[2] } : undefined;
}

/** Counts a suite's cases. */
export function countSuite(suite: SuiteResult): SystemCounts {
  let passing = 0;
  let failing = 0;
  let differs = 0;
  let fixed = 0;
  let todo = 0;
  let skipped = 0;
  for (const { title, status } of suite.cases) {
    if (status === 'todo') todo++;
    else if (status === 'skipped' || status === 'pending' || status === 'disabled') skipped++;
    else if (suite.knownDifferences.has(title)) {
      // it.fails: "passed" means it still fails as written; "failed" means it passes now.
      if (status === 'passed') differs++;
      else fixed++;
    } else if (status === 'passed') passing++;
    else failing++;
  }
  return {
    cases: suite.cases.length,
    passing,
    failing,
    differs,
    fixed,
    todo,
    skipped,
  };
}

function add(a: SystemCounts, b: SystemCounts): SystemCounts {
  return {
    cases: a.cases + b.cases,
    passing: a.passing + b.passing,
    failing: a.failing + b.failing,
    differs: a.differs + b.differs,
    fixed: a.fixed + b.fixed,
    todo: a.todo + b.todo,
    skipped: a.skipped + b.skipped,
  };
}

/** A system's status from its counts (docs/conformance.md). */
export function statusOf(counts: SystemCounts | undefined): SystemRow['status'] {
  if (!counts || counts.cases === 0) return 'no suite';
  if (counts.skipped === counts.cases) return 'skipped';
  if (counts.passing === 0) return 'missing';
  const open = counts.failing + counts.differs + counts.fixed + counts.todo + counts.skipped;
  return open === 0 ? 'complete' : 'partial';
}

/**
 * The engine map's systems with their suites' counts; suites that name no system of the map
 * are returned apart.
 */
export function conformanceTable(
  systems: readonly MapSystem[],
  suites: readonly SuiteResult[],
): { rows: SystemRow[]; unmapped: { file: string; counts: SystemCounts }[] } {
  const counts = new Map<string, SystemCounts>();
  const unmapped: { file: string; counts: SystemCounts }[] = [];
  const known = new Set(systems.map((system) => `${system.area}/${system.slug}`));
  for (const suite of suites) {
    const slugs = suiteSlugs(suite.file);
    const suiteCounts = countSuite(suite);
    const key = slugs && `${slugs.area}/${slugs.slug}`;
    if (!key || !known.has(key)) {
      unmapped.push({ file: suite.file, counts: suiteCounts });
      continue;
    }
    const before = counts.get(key);
    counts.set(key, before ? add(before, suiteCounts) : suiteCounts);
  }
  const rows = systems.map((system): SystemRow => {
    const found = counts.get(`${system.area}/${system.slug}`);
    return { ...system, counts: found, status: statusOf(found) };
  });
  return { rows, unmapped };
}

/** The table as text: one block per area. */
export function formatTable(table: ReturnType<typeof conformanceTable>): string {
  const lines: string[] = [];
  const headers = ['System', 'Map', 'Cases', 'Pass', 'Fail', 'Differs', 'Todo', 'Status'];
  const areas = [...new Set(table.rows.map((row) => row.areaTitle))];
  for (const area of areas) {
    const rows = table.rows.filter((row) => row.areaTitle === area);
    const cells = rows.map((row) => {
      const c = row.counts;
      return [
        row.system,
        row.mapStatus,
        c ? String(c.cases) : '',
        c ? String(c.passing) : '',
        c ? String(c.failing + c.fixed) : '',
        c ? String(c.differs) : '',
        c ? String(c.todo) : '',
        row.status,
      ];
    });
    const widths = headers.map((header, i) =>
      Math.max(header.length, ...cells.map((row) => (row[i] ?? '').length)),
    );
    const format = (row: readonly string[]): string =>
      row
        .map((cell, i) =>
          i >= 2 && i <= 6 ? cell.padStart(widths[i] ?? 0) : cell.padEnd(widths[i] ?? 0),
        )
        .join('  ')
        .trimEnd();
    lines.push(`## ${area}`, format(headers), format(widths.map((width) => '-'.repeat(width))));
    for (const row of cells) lines.push(format(row));
    lines.push('');
  }
  if (table.unmapped.length > 0) {
    lines.push('## Suites that name no system of the engine map');
    for (const { file, counts } of table.unmapped) {
      lines.push(`${file}: ${String(counts.cases)} cases, ${String(counts.passing)} passing`);
    }
    lines.push('');
  }
  const total = table.rows.reduce<SystemCounts | undefined>(
    (sum, row) => (row.counts ? (sum ? add(sum, row.counts) : row.counts) : sum),
    undefined,
  );
  const withSuites = table.rows.filter((row) => row.counts).length;
  lines.push(
    `${String(withSuites)} of ${String(table.rows.length)} systems have a suite; ` +
      `${String(total?.cases ?? 0)} cases: ${String(total?.passing ?? 0)} passing, ` +
      `${String((total?.failing ?? 0) + (total?.fixed ?? 0))} failing, ` +
      `${String(total?.differs ?? 0)} known differences, ${String(total?.todo ?? 0)} to write` +
      (total?.skipped ? `, ${String(total.skipped)} skipped (no game data)` : '') +
      (total?.fixed
        ? ` (${String(total.fixed)} it.fails case(s) pass now: make them plain cases)`
        : ''),
  );
  return lines.join('\n');
}
