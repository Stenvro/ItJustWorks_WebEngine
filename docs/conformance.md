# Conformance: every system against the original's expected output

We don't measure progress by playtesting. Every system of the original engine
([engine-map.md](engine-map.md)) gets a conformance suite. A suite gives the system an input and
checks that our engine produces what the original produces. A system is complete when its suite is
complete and passes. The engine is complete when every suite is.

## Where the expected output comes from

Each case names its source in a comment. The sources, in order of preference:

1. **The game data.** What a record, a script or a graph says must happen. For example: a quest's
   stage after a script fires, a package's conditions at a given hour, a leveled list's picks at a
   given level.
2. **The engine's own rule**, as the original game behaves. It is described in our own
   words, with its numbers taken from game settings by name. Code and addresses from the original never
   enter the repository.
3. **The game settings' built-in defaults** (GMST, INI).
4. **UESP and community tools** (xEdit, nif.xml, CommonLibSSE), for formulas and structures.

A case whose expected value we chose ourselves is not a conformance case.

## The cases

Each case is one of three kinds.

- **Unit case.** One system, its input built in the test, for example a formula, a state machine or
  a parser.
- **Data case.** One system over the local game data (`*.int.test.ts`, skipped without game data).
  Where a rule applies to a whole class, the case sweeps the whole class across the load order: every
  door, every package, every effect archetype. It reports the counts, not just one example.
- **Interaction case.** Several systems at once in the headless simulation (`tests/helpers/sim.ts`):
  the real records, scripts, AI, physics and animation graphs, with no renderer, audio device or
  menus. The case sets up a world state, steps it at a fixed time step, and asserts what it can
  observe:
  - script events sent;
  - quest stages;
  - packages chosen;
  - positions;
  - HUD notices;
  - sounds asked for;
  - items moved.

Suites live in `tests/conformance/<area>/<system>.test.ts`. The areas are the ones in the engine map:
scripting, ai, combat, magic, animation, physics, rendering, ui.

- A behaviour the original has but we don't yet is written down as `it.todo('…')`, with its source,
  so the suite lists the whole system from the start.
- A behaviour known to differ is written as `it.fails('…')`, with a `TODO(Mx)`.

Writing the full list of a system's behaviours first is what makes "complete" countable.

## The report

`node tools/conformance-report.ts` runs the suites and prints, for every system in the engine map, how
many cases there are and how many pass, fail or are still todo. The status words in
[engine-map.md](engine-map.md) follow from that table:

- **complete:** every case is written and passes;
- **partial:** some pass;
- **missing:** none pass.

## Working rules

- No browser for conformance work. The browser QA runner (`docs/qa.md`) checks rendering and the
  final playable build. It does not decide whether a system is right.
- One system at a time:
  1. write its full case list from the sources above;
  2. make the cases pass;
  3. update the engine map.
- Interactions between systems get their own cases: the event that one system raises and another
  answers (see the engine map's cross-cutting findings: event sources, settings, time and budget,
  persistence).
