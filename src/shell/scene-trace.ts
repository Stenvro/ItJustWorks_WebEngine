// A development trace of the scenes as they play, for checking them against their data
// (`node tools/scene-audit.ts --trace <file>`, docs/ai.md "Checking a scene against its
// data"): the scene director's own trace (phases, actions starting, lines said, packages done,
// actions ending), each scene's phase, and for every actor a scene casts the package it runs,
// whether it fights, watches a fight, flees, is carried (a horse, a cart), its graph's states
// and where it walks. One line per change, each led by the seconds since the trace began:
//
//   12.5 TRACE MQ101Scene4: #147 package starts for 000654fb
//   12.5 scene cd68e playing phase 8
//   13.0 actor 654fb cd68e:14 pack f7b59/Patrol travel yes graph Default_State>...
//   13.0 pos 654fb 14843,-81654,8210
//
// An actor's line names the scene and alias that cast it ('-': none now, followed on after its
// scene), its package (id/procedure), its flags (COMBAT, OBSERVE, FLEE, CARRIED, FLYING,
// FURNITURE:<furniture>, unstaged, dead), whether it travels, and its graph's innermost states.
//
// Started from the browser console: `engineDev.sceneTrace()` begins (or begins again) and
// returns the trace so far; `engineDev.sceneTrace(false)` stops it.

import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import type { ActorStage } from './actor-stage.ts';

/** How often the actors are looked at (ms). */
const SAMPLE_MS = 500;
/** An actor's position is written again once it has moved this far (units). */
const MOVED = 40;
/** The most lines kept (the oldest go). */
const KEEP = 60000;

const hex = (id: number): string => (id >>> 0).toString(16);

export class SceneTrace {
  readonly #runtime: ScriptRuntime;
  readonly #stage: () => ActorStage | undefined;
  readonly #lines: string[] = [];
  readonly #last = new Map<string, string>();
  readonly #positions = new Map<number, readonly number[]>();
  /** The actors any scene cast while the trace ran. */
  readonly #followed = new Set<number>();
  readonly #start = performance.now();
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(runtime: ScriptRuntime, stage: () => ActorStage | undefined) {
    this.#runtime = runtime;
    this.#stage = stage;
  }

  /** The game's scripts it traces. */
  get runtime(): ScriptRuntime {
    return this.#runtime;
  }

  /** Begins tracing. */
  start(): void {
    this.stop();
    this.#runtime.scenes.listen((text) => {
      this.#push(`TRACE ${text}`);
    });
    this.#timer = setInterval(() => {
      this.#sample();
    }, SAMPLE_MS);
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#runtime.scenes.listen(undefined);
  }

  /** The trace so far, a line per event. */
  text(): string {
    return this.#lines.join('\n');
  }

  #push(text: string): void {
    const seconds = (performance.now() - this.#start) / 1000;
    this.#lines.push(`${seconds.toFixed(1)} ${text}`);
    if (this.#lines.length > KEEP) this.#lines.shift();
  }

  /** Writes a keyed state only when it changed. */
  #changed(key: string, state: string): void {
    if (this.#last.get(key) === state) return;
    this.#last.set(key, state);
    this.#push(`${key} ${state}`);
  }

  #sample(): void {
    const stage = this.#stage();
    const cast = new Map<number, string>();
    for (const playing of this.#runtime.scenes.playing()) {
      this.#changed(
        `scene ${hex(playing.scene)}`,
        `playing phase ${String(playing.phase)}${playing.paused ? ' paused' : ''}`,
      );
      for (const [alias, reference] of playing.cast) {
        cast.set(reference, `${hex(playing.scene)}:${String(alias)}`);
      }
    }
    // Once cast, an actor is followed on after its scene (what its own packages make of it).
    for (const reference of this.#followed) if (!cast.has(reference)) cast.set(reference, '-');
    for (const reference of cast.keys()) this.#followed.add(reference);
    for (const [reference, where] of cast) {
      const staged = stage?.get(reference);
      const pack = stage?.ai.current(reference);
      const combat = this.#runtime.world.combat?.(reference);
      const carried =
        stage !== undefined &&
        (stage.vehicles.holds(reference) || stage.mounts.horseOf(reference) !== undefined);
      // The innermost states: what it plays now (a furniture's idle, a locomotion state).
      const graph =
        staged?.placed.behavior
          ?.states()
          .map((state) => state.state)
          .slice(-3)
          .join('>') ?? '-';
      const furniture = stage?.furniture.interaction(reference);
      const flags = [
        combat?.inCombat === true ? 'COMBAT' : '',
        combat?.observingCombat === true ? 'OBSERVE' : '',
        stage?.ai.fleeing(reference) === true ? 'FLEE' : '',
        carried ? 'CARRIED' : '',
        stage?.flight.isFlying(reference) === true ? 'FLYING' : '',
        furniture ? `FURNITURE:${hex(furniture.furniture)}` : '',
        staged ? '' : 'unstaged',
        staged?.dead === true ? 'dead' : '',
      ].filter((flag) => flag !== '');
      const travel = stage?.movers.travelOf(reference) !== undefined ? 'yes' : 'no';
      this.#changed(
        `actor ${hex(reference)}`,
        `${where} pack ${pack ? `${hex(pack.id)}/${pack.procedure ?? '?'}` : '-'}${flags.length > 0 ? ` ${flags.join(' ')}` : ''} travel ${travel} graph ${graph}`,
      );
      if (!staged) continue;
      const before = this.#positions.get(reference);
      const position = staged.position;
      if (
        !before ||
        Math.hypot(position[0] - (before[0] ?? 0), position[1] - (before[1] ?? 0)) > MOVED
      ) {
        this.#positions.set(reference, [...position]);
        this.#push(`pos ${hex(reference)} ${position.map(Math.round).join(',')}`);
      }
    }
  }
}
