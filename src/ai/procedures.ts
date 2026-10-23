// The parameters of the package procedures (PACK PNAM): what each of a procedure's PKC2 slots
// is, in the engine's order. Not documented; read from the data: every template of the load
// order names the inputs it gives a procedure (BNAM: "Place to Travel", "Allow Sitting", ...),
// and over the 7,633 vanilla packages those names and the input types agree slot by slot
// (`node tools/package-info.ts --procedures`). Platform-independent. Notes: docs/ai.md
// ("Packages").

import type {
  PackageInput,
  PackageLocation,
  PackageTarget,
  ProcedureBranch,
} from './package-records.ts';

/**
 * A procedure's parameter: its name and the input types it takes (the first the most common: a
 * target slot also takes an object list a Find filled, a place to travel to a reference).
 */
export interface ProcedureParameter {
  readonly name: string;
  readonly types: readonly PackageInput['type'][];
}

const p = (name: string, ...types: PackageInput['type'][]): ProcedureParameter => ({
  name,
  types,
});

/** By lower-case procedure name, its parameters in slot order. */
export const PROCEDURE_PARAMETERS: Readonly<Record<string, readonly ProcedureParameter[]>> = {
  acquire: [
    p('Found Objects', 'ObjectList'),
    p('Number To Acquire', 'Int'),
    p('Allow Stealing', 'Bool'),
    p('Allow Pickpocketing', 'Bool'),
    p('Allow Killing', 'Bool'),
  ],
  activate: [p('Target', 'SingleRef', 'ObjectList'), p('Number To Activate', 'Int')],
  dialogueactivate: [
    p('Target', 'SingleRef'),
    p('Talk From', 'Location'),
    p('Look At Target', 'Bool'),
  ],
  eat: [p('Food Criteria', 'TargetSelector'), p('Create Fake Food', 'Bool')],
  escort: [
    p('Target To Escort', 'SingleRef', 'ObjectList'),
    p('Number Of Followers', 'Int'),
    p('Destination', 'Location', 'SingleRef'),
    p('Distance To Wait For Followers', 'Float'),
    p('Follower Min Distance', 'Float'),
    p('Follower Max Distance', 'Float'),
    p('Ride Horse If Possible', 'Bool'),
    p('Prefer Preferred Path', 'Bool'),
    p('Run If Behind', 'Float'),
  ],
  find: [
    p('Location', 'Location'),
    p('Search Criteria', 'TargetSelector'),
    p('Found Objects', 'ObjectList'),
    p('Allow Already Held', 'Bool'),
    p('Allow Stealing', 'Bool'),
  ],
  flee: [
    p('Flee From', 'SingleRef', 'ObjectList'),
    p('Flee To', 'Location', 'SingleRef'),
    p('Use Dynamic Goal', 'Bool'),
    p('Goal Radius', 'Float'),
    p('Avoid Node Radius', 'Float'),
    p('Flee Distance', 'Float'),
    p('Ride Horse If Possible', 'Bool'),
    p('Unknown 7', 'Bool'),
    p('Quiet', 'Bool'),
    p('Counts As Fleeing', 'Bool'),
  ],
  flightgrab: [p('Target', 'SingleRef'), p('Unknown 1', 'Bool')],
  follow: [
    p('Target', 'SingleRef'),
    p('Min Radius', 'Float'),
    p('Max Radius', 'Float'),
    p('Accompany', 'Bool'),
    p('Ride Horse If Possible', 'Bool'),
    p('Need LOS', 'Bool'),
  ],
  followto: [
    p('Target', 'SingleRef'),
    p('Destination', 'Location'),
    p('Min Radius', 'Float'),
    p('Max Radius', 'Float'),
    p('Accompany', 'Bool'),
    p('Ride Horse If Possible', 'Bool'),
    p('Need LOS', 'Bool'),
  ],
  forcegreet: [
    p('Topic', 'Topic'),
    p('Wait Location', 'Location'),
    p('Trigger Location', 'Location'),
  ],
  guard: [
    p('Location', 'Location', 'SingleRef'),
    p('Suspicious Of', 'TargetSelector'),
    p('Unknown 2', 'Float'),
    p('Unknown 3', 'Float'),
  ],
  holdposition: [p('Location', 'Location')],
  hover: [p('Location', 'Location'), p('Height', 'Float')],
  keepaneyeon: [
    p('Target', 'SingleRef'),
    p('Observation Area', 'Location'),
    p('End Pursuit Area', 'Location'),
  ],
  lockdoors: [p('Location', 'Location'), p('Warn Before Locking', 'Bool')],
  orbit: [
    p('Location', 'Location'),
    p('Inner Radius', 'Float'),
    p('Outer Radius', 'Float'),
    p('Height', 'Float'),
  ],
  patrol: [
    p('Patrol Start', 'SingleRef'),
    p('Point Radius', 'Float'),
    p('Repeatable', 'Bool'),
    p('Start At Nearest', 'Bool'),
    p('Ride Horse If Possible', 'Bool'),
    // PatrolStaticPathing's "Static Pathing?": straight from point to point, not over navmeshes.
    p('Static Pathing', 'Bool'),
  ],
  sandbox: [
    p('Location', 'Location', 'ObjectList'),
    p('Allow Eating', 'Bool'),
    p('Allow Sleeping', 'Bool'),
    p('Allow Conversation', 'Bool'),
    p('Allow Idle Markers', 'Bool'),
    p('Allow Sitting', 'Bool'),
    p('Allow Wandering', 'Bool'),
    p('Preferred Path Only', 'Bool'),
    p('Energy', 'Float'),
    p('Allow Special Furniture', 'Bool'),
    p('Min Wander Distance', 'Float'),
  ],
  say: [
    p('Topic', 'Topic'),
    p('Target', 'SingleRef', 'ObjectList'),
    p('Finish Speaking', 'Bool'),
    p('Look At Target', 'Bool'),
    p('Force Subtitle', 'Bool'),
  ],
  shout: [
    p('Location', 'Location', 'SingleRef'),
    p('Shout', 'TargetSelector'),
    p('Target', 'SingleRef'),
    p('Hold When Blocked', 'Bool'),
    p('Just Headtrack', 'Bool'),
  ],
  sit: [p('Target', 'SingleRef', 'ObjectList')],
  sleep: [p('Target', 'SingleRef', 'ObjectList')],
  travel: [
    p('Place To Travel', 'Location', 'SingleRef', 'ObjectList'),
    p('Ride Horse If Possible', 'Bool'),
    p('Prefer Preferred Path', 'Bool'),
  ],
  unlockdoors: [p('Location', 'Location')],
  useidlemarker: [p('Marker', 'SingleRef')],
  usemagic: [
    p('Location', 'Location'),
    p('Spell', 'TargetSelector'),
    p('Target', 'SingleRef'),
    p('Hold When Blocked', 'Bool'),
    p('Cast Time Min', 'Float'),
    p('Cast Time Max', 'Float'),
    p('Cooldown Time Min', 'Float'),
    p('Cooldown Time Max', 'Float'),
    p('Number To Cast Min', 'Int'),
    p('Number To Cast Max', 'Int'),
    p('Dual Cast', 'Bool'),
  ],
  useweapon: [
    p('Location', 'Location'),
    p('Weapon Type', 'TargetSelector'),
    p('Target', 'SingleRef'),
    p('Always Hit', 'Bool'),
    p('Never End', 'Bool'),
    p('Pause Between Barrages', 'Bool'),
    p('Crouch To Reload', 'Bool'),
    p('Do No Damage', 'Bool'),
    p('Hold When Blocked', 'Bool'),
    p('Min Pause', 'Float'),
    p('Max Pause', 'Float'),
    p('End After Barrages', 'Int'),
    p('Min Attacks Per Barrage', 'Int'),
    p('Max Attacks Per Barrage', 'Int'),
    p('Allow Combat Start On Hit', 'Bool'),
    p('Aim Only', 'Bool'),
    p('Always Power Attack', 'Bool'),
    p('Headtrack Target', 'Bool'),
  ],
  wait: [p('Seconds', 'Float'), p('Stop Movement', 'Bool')],
  wander: [
    p('Location', 'Location'),
    p('Preferred Path Only', 'Bool'),
    p('Allow Horse Wander', 'Bool'),
    // Read by the engine as a number (fAIWanderDefaultMinDist without it; original); no vanilla
    // template sets it.
    p('Min Wander Distance', 'Float'),
  ],
};

/** The inputs a running procedure reads, by its slots (PKC2 → the package's merged inputs). */
export class ProcedureInputs {
  readonly #branch: ProcedureBranch;
  readonly #inputs: ReadonlyMap<number, PackageInput>;

  constructor(branch: ProcedureBranch, inputs: ReadonlyMap<number, PackageInput>) {
    this.#branch = branch;
    this.#inputs = inputs;
  }

  /** The input in a slot (undefined: the slot is unused, 255, or the input has no value). */
  slot(index: number): PackageInput | undefined {
    const id = this.#branch.inputs[index];
    return id === undefined || id === 255 ? undefined : this.#inputs.get(id);
  }

  bool(index: number, fallback = false): boolean {
    const value = this.slot(index)?.value;
    return value?.kind === 'bool' ? value.value : fallback;
  }

  number(index: number, fallback = 0): number {
    const value = this.slot(index)?.value;
    return value?.kind === 'int' || value?.kind === 'float' ? value.value : fallback;
  }

  location(index: number): PackageLocation | undefined {
    const value = this.slot(index)?.value;
    return value?.kind === 'location' ? value.location : undefined;
  }

  target(index: number): PackageTarget | undefined {
    const value = this.slot(index)?.value;
    return value?.kind === 'singleRef' || value?.kind === 'targetSelector'
      ? value.target
      : undefined;
  }

  topic(index: number): number | string | undefined {
    const value = this.slot(index)?.value;
    return value?.kind === 'topic' ? value.topic : undefined;
  }
}
