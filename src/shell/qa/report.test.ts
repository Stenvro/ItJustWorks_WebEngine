import { describe, expect, it } from 'vitest';
import { AnomalyLog, FrameStats } from './detectors.ts';
import { buildScenarioReport, scenarioMarkdown, summaryMarkdown } from './report.ts';

function snapshot() {
  const log = new AnomalyLog();
  const guard = { id: '0003704E', name: 'Whiterun Guard', kind: 'npc' as const };
  const cart = { id: '000A1B2C', name: 'MQ101Cart', kind: 'object' as const };
  log.add({ kind: 'glide', subject: guard, time: 3, detail: 'moves 120 u/s', severity: 120 });
  log.add({ kind: 'glide', subject: guard, time: 9, detail: 'moves 300 u/s', severity: 300 });
  log.add({ kind: 'physics-jitter', subject: cart, time: 4, detail: 'flips 9×/s', severity: 9 });
  const line = log.add({
    kind: 'log-warning',
    subject: { id: 'papyrus', name: 'papyrus', kind: 'log' },
    time: 5,
    detail: 'no auto property',
    values: { count: 1 },
    severity: 1,
  });
  line.values.count = 4;
  const frames = new FrameStats();
  for (let i = 0; i < 60; i++) frames.add(16 + (i % 3));
  return log.snapshot(frames.stats(), 60, 12, 30);
}

describe('QA reports', () => {
  it('groups by kind and by system, worst first, repeats of a log line counted', () => {
    const report = buildScenarioReport({
      scenario: 'town',
      description: 'A town',
      startedAt: '2026-10-23T00:00:00Z',
      seconds: 120,
      outcome: 'done',
      notes: [],
      snapshot: snapshot(),
    });
    expect(report.total).toBe(7);
    expect(report.kinds[0]?.kind).toBe('log-warning');
    const glide = report.kinds.find((k) => k.kind === 'glide');
    expect(glide?.count).toBe(2);
    expect(glide?.subjects).toBe(1);
    expect(glide?.worst[0]?.detail).toBe('moves 300 u/s');
    expect(report.systems.map((s) => s.system).sort()).toEqual([
      'locomotion',
      'physics',
      'scripts',
    ]);
    const markdown = scenarioMarkdown(report);
    expect(markdown).toContain('## glide (locomotion): 2 on 1 subjects');
    expect(markdown).toContain('Whiterun Guard');
    const summary = summaryMarkdown([report]);
    expect(summary).toContain('[town](town/report.md)');
    expect(summary).toContain('### glide: 2');
  });
});
