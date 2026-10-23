# Automated QA harness

Glitches are found by the machine, not by playing: monitors in the running game watch every
actor, simulated body, scene and log line, and a scenario runner plays set situations
unattended with them on, then writes a report. Use it to verify a system's work and to sweep
for regressions.

- Monitors: `src/shell/qa/` (development builds only, `engineDev.qa`).
- Runner: `tools/qa-run.ts` (scenarios in `tools/qa-scenarios.ts`, CDP client in
  `tools/qa-cdp.ts`).

## Running it

```sh
node tools/qa-run.ts --out <folder outside the repo> [scenario ...] [--seconds N]
                     [--url http://localhost:5202] [--vite-port 5202] [--chrome-port 9362]
node tools/qa-run.ts --list
```

- Without `--url` it starts the repository's Vite on `--vite-port` (default 5202) and stops it
  at the end; with `--url` it uses a running dev server (a Vite started inside `.claude/`
  worktrees does not see source edits: restart it after editing).
- It starts its own headless Chrome on `--chrome-port` (default 9362): **muted**
  (`--mute-audio`), WebGPU on, background throttling off, its profile in the output folder.
  Each scenario gets a fresh tab, sized 1280×720, focus emulated and brought to the front, so
  `requestAnimationFrame` runs at the full rate (a hidden tab runs at ~1 fps and its numbers
  mean nothing). Never use the maintainer's ports (5173/5174/9333).
- `--out` must lie outside the repository: the screenshots show the game's content.
- `--seconds N` overrides every scenario's watch time (quick checks: `--seconds 60`).
- Running some scenarios again into the same folder replaces their reports; the summary always
  covers every scenario report in the folder.
- Scenarios run one after the other; each has a timeout (its boot time + watch time + 2
  minutes). A page that does not answer a ping within 15 s is a `hang`: the scenario ends there
  with what was seen, and the next one gets a new tab (a new Chrome if the browser died).

The output folder holds `summary.md` / `summary.json` (all scenarios: counts per system, frame
times, the worst anomalies per system) and per scenario `report.md`, `report.json` (every
anomaly kept, grouped by kind and by system, the worst first, the timeline of quest stages and
scenes) and `shots/` (a screenshot of the first anomaly of each kind per actor or body, taken
from a camera of the harness's own pointed at the place, `engineDev.qa.frame(id)`).

### Scenarios

| name              | what                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opening`         | New game: the cart ride, Helgen, the execution, Alduin. The player is AI-driven until MQ101 stage 160; the race menu is finished as a player would (R, yes, a name). Then a follow bot walks the player to the active quest marker (the guide, or the load door toward it) into the keep. MQ101 is watched (4 min per stage).                       |
| `whiterun-day`    | `coc WhiterunPlainsDistrict03` at 9:00: the market.                                                                                                                                                                                                                                                                                                 |
| `bannered-mare`   | `coc WhiterunBanneredMare` at 20:00.                                                                                                                                                                                                                                                                                                                |
| `riverwood`       | `coc Riverwood` at 13:00.                                                                                                                                                                                                                                                                                                                           |
| `windhelm-snow`   | `coc WindhelmMarketplaceExterior` at 11:00, `fw` SkyrimOvercastSnow.                                                                                                                                                                                                                                                                                |
| `combat`          | `coc Riverwood` at 12:00, `tgm`; three bandits and three Imperial guards placed at the player, each bandit set on a guard.                                                                                                                                                                                                                          |
| `combat-melee`    | The same fight with the six fighters' ammunition taken first (a bow without arrows is no option), so all close in with blades: the close movement (docs/ai.md, Combat movement).                                                                                                                                                                    |
| `creatures`       | `coc WhiterunExterior01` (the stables) at 10:00, `tgm`; two chickens, a cow, a goat, a dog, a horse, a deer, an elk and a hare placed around the player (idles, wandering, fleeing); the player rides a saddled horse placed beside them through its gaits on a minute's loop (walk, trot, gallop, sprint, stop, turns), the view turning smoothly. |
| `creature-combat` | `coc WhiterunExterior01` at 10:00, `tgm`; two wolves, a sabre cat, a bear, a mudcrab and a skeever placed around the player and set on them, a deer and an elk near them (fleeing).                                                                                                                                                                 |
| `deaths`          | `coc Riverwood` at 12:00, `tgm`; 28 kinds of actors (people, draugr, a skeleton, animals, Dwemer machines, a giant, a mammoth, atronachs) placed in a ring 700 units around the player, killed by script 10 s later; their deaths and ragdolls watched for 75 s.                                                                                    |

The `coc` scenarios start from the main menu's console (`PlayMode.runConsole`, no opening),
answer the Survival Mode box with No, set the hour and weather, wait until the actors' schedules
have settled, then watch for 3 minutes.

The follow bot (in the page, `FOLLOW_BOT` in `tools/qa-scenarios.ts`) reads the targets of the running
quests' shown objectives as the compass does (`questTargets`, but also for a quest the journal
has not made the active one: MQ101 is not), finds a navmesh path (`findPath`) to the nearest and
steers the player by `Player.yaw` and the Forward control. It waits when the guide is within 220
units (after 8 s it closes in to 90: a trigger may be by them), uses the load door toward a
target in another space (`firstDoorToward`, aiming and pressing Activate), and when stuck steps
left, right or back (every other time with a jump) and searches again. The scenario ends a
minute after the player is in an interior (the keep), or when MQ101's stage stands 8 minutes
(the opening stalled, or the bot got nowhere). Its log goes into the report's notes.

## The monitors in the page

```js
engineDev.qa.start({ thresholds: { glideSpeed: 50 }, watchQuests: { [0x3372b]: 240 } });
// ... play ...
engineDev.qa.snapshot(); // anomalies, frame times, timeline
engineDev.qa.stop();
```

Nothing of them runs until `start()`: no frame hook, no wrapped method, no cost. Started, they
take one `requestAnimationFrame` callback; the slower checks (poses, ground rays, travels,
scenes) run every 0.25 s. They pause while the game is in menu mode or loading. While running
they wrap the engine log (`Terminal.log`), `console.error`, the window's `error` and
`unhandledrejection`, and each watched actor graph's `sendEvent`; `stop()` undoes all of it.

Each anomaly carries the actor or reference (name, form id, kind: player, npc, creature,
horse, object, scene, quest, log), its graph's active states (`machine:state`) and clips, its
position and cell, the time since the start and the game hour, what it was doing (package,
scene, furniture, AI-driven, a reaction holding it, or the reason motion without animation is by
design), a detail line, the numbers behind it, a severity (the report sorts by it) and, for
episodes, how long it lasted. `first` marks the first of a kind per subject (it gets the
screenshot). At most 400 are kept per kind; the rest are counted (`dropped`) with the worst
replacing the mildest.

What counts as moving "by design" without animation (no glide, no speed mismatch, no ground
check): riders of a vehicle (MQ101's carts), riders on a horse, knocked down or ragdolled
actors, fliers held by the flight. Dead and hidden actors are not watched. Teleports (over 300
units in a frame) reset the speed meters.

| kind               | system      | what it means                                                                                                                                                                                   | default threshold                                                  |
| ------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `glide`            | locomotion  | An actor (the player too) moves horizontally while its graph walks nowhere: no locomotion clip plays (walk, run, sprint, turn, gallop, swim, fly… by name) and its root motion is still.        | over 40 u/s for 0.5 s, root motion under 15 u/s                    |
| `speed-mismatch`   | locomotion  | The graph's root-motion speed and the real speed disagree (running in place, a walk clip at a sprint's speed). Only for graphs that have given root motion.                                     | difference over 80 u/s and 60 % of the larger speed, for 1.5 s     |
| `state-chatter`    | animation   | A state machine changes state many times a second ("hangs in one step, repeated very fast"); the states visited are listed.                                                                     | 8 changes in a second, for 0.5 s                                   |
| `clip-restart`     | animation   | One clip starts over (back near its start without looping, or gone and back within 0.5 s) many times a second before getting anywhere.                                                          | 5 restarts in a second, reaching under 0.2 s on average, for 0.5 s |
| `move-chatter`     | locomotion  | `moveStart`/`moveStop` sent to the graph many times a second.                                                                                                                                   | 6 in a second, for 0.5 s                                           |
| `turn-chatter`     | locomotion  | `turnLeft`/`turnRight`/`turnStop` sent many times a second.                                                                                                                                     | 8 in a second, for 0.5 s                                           |
| `bind-pose`        | animation   | A shown skeleton stays at its bind (reference) pose, or has no behavior graph at all.                                                                                                           | 1 s                                                                |
| `corpse-upright`   | physics     | A dead actor (died here, or placed dead: `TreasCorpse…`) whose drawn head is still high above its feet: no ragdoll laid it down, it stands at its bind pose. Corpses are otherwise not watched. | head over 60 % of its standing height, 5 s                         |
| `ragdoll-restless` | physics     | A dead actor's ragdoll keeps a simulated body awake: it never came to rest (trembling against the ground or a rock).                                                                            | 20 s                                                               |
| `bad-bone`         | animation   | A bone of the drawn pose is NaN/infinite or far from the actor.                                                                                                                                 | 20000 units                                                        |
| `floating`         | physics     | A grounded actor's feet are well above what a ray straight down finds (or nothing within 512 units). Actors, clutter, debris and triggers under it are no ground.                               | 40 units, for 1.5 s                                                |
| `sunk`             | physics     | A surface is above a grounded actor's feet: inside geometry or under the ground.                                                                                                                | 30 units, for 1.5 s                                                |
| `stuck`            | ai          | An actor (or the AI-driven player) with a travel gets no nearer its destination (64 units nearer, or 256 moved as a detour, is progress).                                                       | 10 s                                                               |
| `physics-jitter`   | physics     | A simulated body awake flips its vertical velocity many times a second (the carts bouncing).                                                                                                    | 6 flips in a second above 30 u/s, for 1 s                          |
| `velocity-spike`   | physics     | A simulated body's velocity changes by a lot in one frame.                                                                                                                                      | 1500 u/s                                                           |
| `scene-stall`      | scenes      | A playing, unpaused scene with an actor in the loaded area keeps its phase while none of its actors moves; the actions not complete are listed.                                                 | 45 s, under 64 units moved                                         |
| `quest-stall`      | scenes      | A watched quest's stage does not change (`watchQuests`).                                                                                                                                        | per quest                                                          |
| `log-error`        | scripts     | An error line of the engine's log (Papyrus, actors, assets…); repeats counted on one anomaly.                                                                                                   |                                                                    |
| `log-warning`      | scripts     | A warning line of the engine's log.                                                                                                                                                             |                                                                    |
| `console-error`    | shell       | `console.error`, an uncaught exception or rejection.                                                                                                                                            |                                                                    |
| `long-frame`       | performance | A frame far over budget (with the loading line if a place was loading).                                                                                                                         | 100 ms                                                             |
| `hang`             | shell       | The page stopped answering (the runner's ping).                                                                                                                                                 | 15 s                                                               |

Frame times: every `requestAnimationFrame` interval while watching (menus included), as p50,
p95, p99, the worst, frames over 33 and 50 ms, and long tasks (`PerformanceObserver`
'longtask': count, total, longest). On a shared machine (other agents' browsers on the same GPU)
they are only comparable between runs on the same load.

Thresholds are in `DEFAULT_THRESHOLDS` (`src/shell/qa/types.ts`); a run may change any of them
(`start({ thresholds })`). They were calibrated on the scenarios above so that normal play
(walk cycles, short looping pose clips such as `MT_Idle_Skinny`, idles, a turn on the spot)
stays quiet; the detectors' arithmetic is unit-tested in `src/shell/qa/detectors.test.ts`.

## Adding a scenario

A scenario (`tools/qa-scenarios.ts`) names how the game starts (`new`, or `coc <cell>`), an hour
and weather, its boot and watch seconds, quests to watch, and optional `setup` (before the
monitors start: spawn, start a fight), `tick` (every second while watching: drive the player,
answer a menu; `true` ends early) and `finish` (before the snapshot). `ctx.console(line)` runs a
console line, `ctx.page.eval` any expression in the page.
