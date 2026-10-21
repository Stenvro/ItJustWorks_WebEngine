// Executions at a chopping block (docs/ai.md, "Executions"): the block is furniture whose markers
// take an executioner (its idle IdleExecutionerIdle), a guard behind the prisoner
// (IdleExecutionGuardIdle) and the prisoner (IdleExecutioneeIdle), each entering by the idle tree
// as furniture is entered (src/shell/actor-furniture.ts). All three graphs go from their idle to
// their chop on one event, IdleExecutionerChop (0_master's Behavior36, Behavior78, Behavior37), and
// their 20 s chop clips run together: the guard's pushes, the last words said on the block
// (MQ101's Scene4, phase 41) and the blow at 11.4 s, after which its KillActor kills the prisoner (the
// scene waits for GetDead). Nothing in the data sends that event (the chop idle shares its
// siblings' conditions, so the tree never picks it, and no script plays it): once all three are
// in, it goes to all three. Inferred from the graphs; TODO(M13): the engine's own trigger and its
// kill, the player's block (IdleExecutionerChop_Player, stage 95), and the decapitation itself
// (the head's dismemberment piece and the race's decapitation effect).

import type { FurnitureUser } from './actor-furniture.ts';
import type { StagedActor } from './actor-stage.ts';

/** The idle each role enters the block by (ActionActivate's ExecutionerRoot, ...). */
const EXECUTIONER = 'idleexecutioneridle';
const GUARD = 'idleexecutionguardidle';
const EXECUTIONEE = 'idleexecutioneeidle';
/** The event all three chop on. */
const CHOP = 'IdleExecutionerChop';

export interface ActorExecutionsOptions {
  /** The furniture an actor is in now and the idles it entered by. */
  readonly enteredBy: (
    reference: number,
  ) => { readonly furniture: number; readonly events: readonly string[] } | undefined;
  readonly userOf: (staged: StagedActor) => FurnitureUser;
  /** The prisoner dies, killed by the executioner. */
  readonly kill: (victim: number, killer: number) => void;
}

interface Execution {
  readonly executioner: number;
  readonly executionee: number;
}

export class ActorExecutions {
  readonly #options: ActorExecutionsOptions;
  /** The executions under way, by the prisoner. */
  readonly #running = new Map<number, Execution>();

  constructor(options: ActorExecutionsOptions) {
    this.#options = options;
  }

  /** Every frame: a block with all three in starts its chop. */
  frame(actors: Iterable<StagedActor>): void {
    const blocks = new Map<number, Map<string, StagedActor>>();
    for (const staged of actors) {
      if (staged.dead) continue;
      const using = this.#options.enteredBy(staged.reference);
      // (An instant enter has two: the instant one, then the idle.)
      const entered = using?.events
        .map((event) => event.toLowerCase())
        .find((event) => event === EXECUTIONER || event === GUARD || event === EXECUTIONEE);
      if (!using || entered === undefined) continue;
      let roles = blocks.get(using.furniture);
      if (!roles) {
        roles = new Map();
        blocks.set(using.furniture, roles);
      }
      roles.set(entered, staged);
    }
    for (const roles of blocks.values()) {
      const executioner = roles.get(EXECUTIONER);
      const executionee = roles.get(EXECUTIONEE);
      const guard = roles.get(GUARD);
      if (!executioner || !executionee || !guard) continue;
      if (this.#running.has(executionee.reference)) continue;
      this.#running.set(executionee.reference, {
        executioner: executioner.reference,
        executionee: executionee.reference,
      });
      for (const staged of [executioner, guard, executionee]) {
        this.#options.userOf(staged).send(CHOP);
      }
    }
  }

  /** A prisoner's graph raised events: KillActor, after the blow (Decapitate), kills it. */
  events(actor: number, events: readonly string[]): void {
    const execution = this.#running.get(actor);
    if (!execution) return;
    if (!events.some((event) => event.toLowerCase() === 'killactor')) return;
    this.#running.delete(actor);
    this.#options.kill(actor, execution.executioner);
  }

  /** An actor left the stage. */
  remove(reference: number): void {
    this.#running.delete(reference);
  }
}
