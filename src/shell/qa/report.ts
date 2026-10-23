// The QA harness's reports (docs/qa.md): a scenario's snapshot grouped by kind and by system,
// the worst examples first, as JSON and Markdown; and a summary over several scenarios. Pure:
// the Node scenario runner (tools/qa-run.ts) writes them.

import {
  KIND_SYSTEM,
  type QaAnomaly,
  type QaFrameStats,
  type QaKind,
  type QaSnapshot,
  type QaSystem,
} from './types.ts';

/** How a scenario ended. */
export type QaOutcome = 'done' | 'timeout' | 'hang' | 'error';

export interface QaTimelineEvent {
  readonly time: number;
  readonly text: string;
}

export interface QaKindSummary {
  readonly kind: QaKind;
  readonly system: QaSystem;
  /** Anomalies seen (dropped ones included). */
  readonly count: number;
  /** Subjects (actors, bodies, scenes, log tags) it was seen on. */
  readonly subjects: number;
  readonly worst: readonly QaAnomaly[];
}

export interface QaSystemSummary {
  readonly system: QaSystem;
  readonly count: number;
  readonly kinds: readonly { readonly kind: QaKind; readonly count: number }[];
}

export interface QaScenarioReport {
  readonly scenario: string;
  readonly description: string;
  readonly startedAt: string;
  /** Seconds the scenario ran in all (setup included) and the monitors watched. */
  readonly seconds: number;
  readonly watched: number;
  readonly outcome: QaOutcome;
  readonly notes: readonly string[];
  readonly frames: QaFrameStats | undefined;
  readonly actorsWatched: number;
  readonly bodiesWatched: number;
  readonly total: number;
  readonly kinds: readonly QaKindSummary[];
  readonly systems: readonly QaSystemSummary[];
  readonly timeline: readonly QaTimelineEvent[];
  readonly anomalies: readonly QaAnomaly[];
}

/** Worst examples kept per kind in a report. */
const WORST = 6;

export function buildScenarioReport(input: {
  readonly scenario: string;
  readonly description: string;
  readonly startedAt: string;
  readonly seconds: number;
  readonly outcome: QaOutcome;
  readonly notes: readonly string[];
  readonly snapshot: (QaSnapshot & { readonly events?: readonly QaTimelineEvent[] }) | undefined;
  /** Anomalies the runner saw itself (hangs, steps that failed). */
  readonly extra?: readonly QaAnomaly[];
}): QaScenarioReport {
  const snapshot = input.snapshot;
  const anomalies = [...(snapshot?.anomalies ?? []), ...(input.extra ?? [])];
  const byKind = new Map<QaKind, QaAnomaly[]>();
  for (const anomaly of anomalies) {
    const list = byKind.get(anomaly.kind) ?? [];
    list.push(anomaly);
    byKind.set(anomaly.kind, list);
  }
  const dropped = snapshot?.dropped ?? {};
  const kinds: QaKindSummary[] = [...byKind]
    .map(([kind, list]) => ({
      kind,
      system: KIND_SYSTEM[kind],
      count: countOf(list) + (dropped[kind] ?? 0),
      subjects: new Set(list.map((a) => a.subject?.id ?? a.detail)).size,
      worst: worstOf(list, WORST),
    }))
    .sort((a, b) => b.count - a.count);
  const systems = new Map<QaSystem, { count: number; kinds: { kind: QaKind; count: number }[] }>();
  for (const summary of kinds) {
    const entry = systems.get(summary.system) ?? { count: 0, kinds: [] };
    entry.count += summary.count;
    entry.kinds.push({ kind: summary.kind, count: summary.count });
    systems.set(summary.system, entry);
  }
  return {
    scenario: input.scenario,
    description: input.description,
    startedAt: input.startedAt,
    seconds: Math.round(input.seconds),
    watched: Math.round(snapshot?.seconds ?? 0),
    outcome: input.outcome,
    notes: input.notes,
    frames: snapshot?.frames,
    actorsWatched: snapshot?.actorsWatched ?? 0,
    bodiesWatched: snapshot?.bodiesWatched ?? 0,
    total: kinds.reduce((sum, k) => sum + k.count, 0),
    kinds,
    systems: [...systems]
      .map(([system, entry]) => ({ system, count: entry.count, kinds: entry.kinds }))
      .sort((a, b) => b.count - a.count),
    timeline: snapshot?.events ?? [],
    anomalies,
  };
}

/** Log lines that repeat count each time they came (their `count`). */
function countOf(list: readonly QaAnomaly[]): number {
  return list.reduce(
    (sum, a) =>
      sum + (a.kind.startsWith('log-') || a.kind === 'console-error' ? (a.values.count ?? 1) : 1),
    0,
  );
}

/** The worst of a list: by severity, one per subject first (so one actor does not fill it). */
function worstOf(list: readonly QaAnomaly[], n: number): QaAnomaly[] {
  const sorted = [...list].sort((a, b) => b.severity - a.severity);
  const picked: QaAnomaly[] = [];
  const subjects = new Set<string>();
  for (const anomaly of sorted) {
    const key = anomaly.subject?.id ?? anomaly.detail;
    if (subjects.has(key)) continue;
    subjects.add(key);
    picked.push(anomaly);
    if (picked.length === n) return picked;
  }
  for (const anomaly of sorted) {
    if (picked.length === n) break;
    if (!picked.includes(anomaly)) picked.push(anomaly);
  }
  return picked;
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

function describeAnomaly(anomaly: QaAnomaly, shots: string): string[] {
  const subject = anomaly.subject
    ? `${anomaly.subject.name} (${anomaly.subject.kind} ${anomaly.subject.id})`
    : '-';
  const lines = [
    `- **${cell(subject)}** at ${anomaly.time.toFixed(1)} s` +
      (anomaly.gameHour === undefined ? '' : `, ${anomaly.gameHour.toFixed(2)} h`) +
      (anomaly.duration > 0 ? `, lasted ${anomaly.duration.toFixed(1)} s` : '') +
      `: ${cell(anomaly.detail)}`,
  ];
  const where = [
    anomaly.position ? `at ${anomaly.position.join(', ')}` : '',
    anomaly.cell ? `cell ${anomaly.cell}` : '',
    anomaly.context ?? '',
  ].filter(Boolean);
  if (where.length > 0) lines.push(`  - ${cell(where.join('; '))}`);
  if (anomaly.states && anomaly.states.length > 0)
    lines.push(
      `  - states: ${cell(anomaly.states.slice(0, 8).join(', '))}${anomaly.states.length > 8 ? ', …' : ''}`,
    );
  if (anomaly.clips && anomaly.clips.length > 0)
    lines.push(
      `  - clips: ${cell(anomaly.clips.slice(0, 6).join(', '))}${anomaly.clips.length > 6 ? ', …' : ''}`,
    );
  if (anomaly.shot) lines.push(`  - ![#${anomaly.id}](${shots}${anomaly.shot})`);
  return lines;
}

function framesTable(frames: QaFrameStats): string[] {
  return [
    '| fps | p50 | p95 | p99 | worst | >33 ms | >50 ms | long tasks (total, worst) |',
    '|---:|---:|---:|---:|---:|---:|---:|---|',
    `| ${frames.fps} | ${frames.p50} | ${frames.p95} | ${frames.p99} | ${frames.worst} | ${frames.over33} | ${frames.over50} | ${frames.longTasks} (${frames.longTaskTotal} ms, ${frames.longTaskWorst} ms) |`,
  ];
}

/** A scenario's report as Markdown (`shots`: the screenshots' folder, relative). */
export function scenarioMarkdown(report: QaScenarioReport, shots = 'shots/'): string {
  const out: string[] = [
    `# QA: ${report.scenario}`,
    '',
    report.description,
    '',
    `Started ${report.startedAt}; ran ${report.seconds} s, watched ${report.watched} s; outcome **${report.outcome}**; ${report.actorsWatched} actors at most, ${report.bodiesWatched} simulated bodies awake; **${report.total} anomalies**.`,
    '',
  ];
  for (const note of report.notes) out.push(`- ${cell(note)}`);
  if (report.notes.length > 0) out.push('');
  if (report.frames) out.push('## Frame time (ms)', '', ...framesTable(report.frames), '');
  out.push('## By system', '', '| system | anomalies | kinds |', '|---|---:|---|');
  for (const system of report.systems)
    out.push(
      `| ${system.system} | ${system.count} | ${system.kinds.map((k) => `${k.kind} ${k.count}`).join(', ')} |`,
    );
  out.push('');
  for (const kind of report.kinds) {
    out.push(`## ${kind.kind} (${kind.system}): ${kind.count} on ${kind.subjects} subjects`, '');
    for (const anomaly of kind.worst) out.push(...describeAnomaly(anomaly, shots));
    out.push('');
  }
  if (report.timeline.length > 0) {
    out.push('## Timeline', '');
    for (const event of report.timeline.slice(0, 200))
      out.push(`- ${event.time.toFixed(1)} s: ${cell(event.text)}`);
    if (report.timeline.length > 200) out.push(`- … ${report.timeline.length - 200} more`);
    out.push('');
  }
  return out.join('\n');
}

/** The summary over a run's scenarios: counts per system, frame times, the worst per system. */
export function summaryMarkdown(reports: readonly QaScenarioReport[], title = 'QA run'): string {
  const systems = [...new Set(reports.flatMap((r) => r.systems.map((s) => s.system)))].sort();
  const out: string[] = [
    `# ${title}`,
    '',
    '| scenario | outcome | watched s | fps | p95 ms | p99 ms | worst ms | ' +
      systems.join(' | ') +
      ' |',
    '|---|---|---:|---:|---:|---:|---:|' + systems.map(() => '---:').join('|') + '|',
  ];
  for (const report of reports) {
    const counts = systems.map((system) =>
      String(report.systems.find((s) => s.system === system)?.count ?? 0),
    );
    const f = report.frames;
    out.push(
      `| [${report.scenario}](${report.scenario}/report.md) | ${report.outcome} | ${report.watched} | ${f?.fps ?? '-'} | ${f?.p95 ?? '-'} | ${f?.p99 ?? '-'} | ${f?.worst ?? '-'} | ${counts.join(' | ')} |`,
    );
  }
  out.push('');
  for (const system of systems) {
    const kinds = new Map<
      QaKind,
      { count: number; examples: { scenario: string; anomaly: QaAnomaly }[] }
    >();
    for (const report of reports) {
      for (const kind of report.kinds) {
        if (kind.system !== system) continue;
        const entry = kinds.get(kind.kind) ?? { count: 0, examples: [] };
        entry.count += kind.count;
        for (const anomaly of kind.worst)
          entry.examples.push({ scenario: report.scenario, anomaly });
        kinds.set(kind.kind, entry);
      }
    }
    out.push(`## ${system}`, '');
    for (const [kind, entry] of [...kinds].sort((a, b) => b[1].count - a[1].count)) {
      out.push(`### ${kind}: ${entry.count}`, '');
      const examples = entry.examples
        .sort((a, b) => b.anomaly.severity - a.anomaly.severity)
        .slice(0, 4);
      for (const { scenario, anomaly } of examples) {
        const lines = describeAnomaly(anomaly, `${scenario}/shots/`);
        lines[0] = `${lines[0] ?? ''} _(${scenario})_`;
        out.push(...lines);
      }
      out.push('');
    }
  }
  return out.join('\n');
}
