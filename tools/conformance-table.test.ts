import { describe, expect, it } from 'vitest';
import {
  conformanceTable,
  countSuite,
  formatTable,
  knownDifferenceTitles,
  parseEngineMap,
  slugOf,
  suiteSlugs,
} from './conformance-table.ts';

const MAP = `# Engine map

## What is already complete

| Not | an area |

## Areas

### Scripting, events, world state, audio

| System        | Status   | Main gaps |
| ------------- | -------- | --------- |
| Story manager | partial  | sources   |
| Papyrus VM    | different | threads  |

### AI

| System             | Status  | Main gaps |
| ------------------ | ------- | --------- |
| Package evaluation | partial | flags     |

## Order of work

| Phase | Work |
`;

describe('the conformance table', () => {
  it('reads the engine map’s area tables only', () => {
    expect(parseEngineMap(MAP)).toEqual([
      {
        area: 'scripting',
        areaTitle: 'Scripting, events, world state, audio',
        system: 'Story manager',
        slug: 'story-manager',
        mapStatus: 'partial',
      },
      {
        area: 'scripting',
        areaTitle: 'Scripting, events, world state, audio',
        system: 'Papyrus VM',
        slug: 'papyrus-vm',
        mapStatus: 'different',
      },
      {
        area: 'ai',
        areaTitle: 'AI',
        system: 'Package evaluation',
        slug: 'package-evaluation',
        mapStatus: 'partial',
      },
    ]);
  });

  it('names systems as their suites’ files do', () => {
    expect(slugOf('Followers, horses, furniture')).toBe('followers-horses-furniture');
    expect(slugOf('Per-reference state')).toBe('per-reference-state');
    expect(suiteSlugs('tests/conformance/ai/package-evaluation.test.ts')).toEqual({
      area: 'ai',
      slug: 'package-evaluation',
    });
    expect(suiteSlugs('tests\\conformance\\scripting\\story-manager.int.test.ts')).toEqual({
      area: 'scripting',
      slug: 'story-manager',
    });
    expect(suiteSlugs('tests/actors.int.test.ts')).toBeUndefined();
  });

  it('finds the it.fails titles in a suite’s source, concatenated ones too', () => {
    const source = [
      "it.fails('one', () => {});",
      "  it.fails(\n    'two ' +\n      'parts',\n    () => {},\n  );",
      "it('plain', () => {});",
      "test.fails('it\\'s three', () => {});",
    ].join('\n');
    expect([...knownDifferenceTitles(source)]).toEqual(['one', 'two parts', "it's three"]);
  });

  it('counts cases: it.fails that still fail are known differences, those that pass are fixed', () => {
    expect(
      countSuite({
        file: 'tests/conformance/ai/package-evaluation.test.ts',
        cases: [
          { title: 'a', status: 'passed' },
          { title: 'b', status: 'failed' },
          { title: 'c', status: 'passed' },
          { title: 'd', status: 'failed' },
          { title: 'e', status: 'todo' },
          { title: 'f', status: 'skipped' },
        ],
        knownDifferences: new Set(['c', 'd']),
      }),
    ).toEqual({ cases: 6, passing: 1, failing: 1, differs: 1, fixed: 1, todo: 1, skipped: 1 });
  });

  it('gives each system its status: complete, partial, missing, or no suite', () => {
    const systems = parseEngineMap(MAP);
    const table = conformanceTable(systems, [
      {
        file: 'tests/conformance/scripting/story-manager.test.ts',
        cases: [{ title: 'a', status: 'passed' }],
        knownDifferences: new Set(),
      },
      {
        file: 'tests/conformance/ai/package-evaluation.test.ts',
        cases: [
          { title: 'a', status: 'passed' },
          { title: 'b', status: 'todo' },
        ],
        knownDifferences: new Set(),
      },
      {
        file: 'tests/conformance/ai/unknown-system.test.ts',
        cases: [{ title: 'a', status: 'failed' }],
        knownDifferences: new Set(),
      },
    ]);
    expect(table.rows.map((row) => [row.slug, row.status])).toEqual([
      ['story-manager', 'complete'],
      ['papyrus-vm', 'no suite'],
      ['package-evaluation', 'partial'],
    ]);
    expect(table.unmapped.map((entry) => entry.file)).toEqual([
      'tests/conformance/ai/unknown-system.test.ts',
    ]);
    const text = formatTable(table);
    expect(text).toContain('## AI');
    expect(text).toContain('2 of 3 systems have a suite; 3 cases: 2 passing, 0 failing');
  });
});
