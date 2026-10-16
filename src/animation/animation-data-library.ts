// The behavior projects' animation data as the runtime asks for it: by a behavior project (as
// a race names it, meshes\actors\character\defaultmale.hkx) and a clip generator's name, the
// clip's root motion; by a project and an equip state (the graph variables the animation
// sets test), its attacks; by a project, locomotion state, direction and goal speed, the
// locomotion blend parameter (BSSpeedSamplerModifier). Read from the single files, which hold
// the DLC projects and the patched blocks (the per-project files do not).
// Notes: docs/formats/hkx.md ("Animation data").

import { FormatError } from '../formats/binary-reader.ts';
import {
  parseAnimationData,
  type AnimationDataProject,
  type ClipData,
  type ClipMotion,
} from '../formats/animdata/animation-data.ts';
import {
  animationSetApplies,
  parseAnimationSetData,
  projectName,
  type AnimationSet,
  type AnimationSetAttack,
  type AnimationSetDataProject,
} from '../formats/animdata/animation-set-data.ts';
import {
  animationResponse,
  parseAnimationResponses,
  type AnimationResponses,
} from '../formats/animdata/responses.ts';
import {
  rootMotionAt,
  rootMotionDelta,
  rootMotionTotal,
  type RootTransform,
} from '../formats/animdata/root-motion.ts';
import {
  parseSpeedData,
  speedAtParameter,
  speedParameter,
  type SpeedDataProject,
  type SpeedTable,
} from '../formats/animdata/speed-data.ts';
import { decodeWindows1252 } from '../formats/text.ts';

export const ANIMATION_DATA_FILES = {
  animationData: 'meshes\\animationdatasinglefile.txt',
  animationSetData: 'meshes\\animationsetdatasinglefile.txt',
  speedData: 'meshes\\speeddatasinglefile.txt',
  actorResponses: 'meshes\\responses\\actorresponse.txt',
  playerResponses: 'meshes\\responses\\playercharacterresponse.txt',
} as const;

/** The key the data name a project by: its file name without extension, lower case. */
export function animationDataKey(project: string): string {
  return projectName(project.trim()).toLowerCase();
}

/**
 * The graph variables an equip state is tested by (iLeftHandType, iRightHandType,
 * iWantMountedWeaponAnims), by name in any case; one not named counts as 0.
 */
export type EquipState = Readonly<Record<string, number>>;

/** One behavior project's animation data, sets and speed tables. */
export class ProjectAnimationData {
  readonly name: string;
  readonly data: AnimationDataProject | undefined;
  readonly setData: AnimationSetDataProject | undefined;
  readonly speedData: SpeedDataProject | undefined;
  readonly #clips = new Map<string, ClipData>();
  readonly #motions = new Map<number, ClipMotion>();

  constructor(
    name: string,
    data: AnimationDataProject | undefined,
    setData: AnimationSetDataProject | undefined,
    speedData: SpeedDataProject | undefined,
  ) {
    this.name = name;
    this.data = data;
    this.setData = setData;
    this.speedData = speedData;
    for (const clip of data?.clips ?? []) {
      const key = clip.name.toLowerCase();
      if (!this.#clips.has(key)) this.#clips.set(key, clip);
    }
    for (const motion of data?.motions ?? []) {
      if (!this.#motions.has(motion.clipId)) this.#motions.set(motion.clipId, motion);
    }
  }

  /** A clip generator's data by its name (any case). */
  clip(generator: string): ClipData | undefined {
    return this.#clips.get(generator.toLowerCase());
  }

  /** A clip generator's root motion. */
  motion(generator: string): ClipMotion | undefined {
    const clip = this.clip(generator);
    return clip ? this.#motions.get(clip.clipId) : undefined;
  }

  motionById(clipId: number): ClipMotion | undefined {
    return this.#motions.get(clipId);
  }

  /** Where the clip has moved the actor at a local time of the clip (seconds, uncropped). */
  rootMotionAt(generator: string, time: number): RootTransform | undefined {
    const motion = this.motion(generator);
    return motion ? rootMotionAt(motion, time) : undefined;
  }

  /** What the clip moves the actor by between two local times (looped when `to` < `from`). */
  rootMotionDelta(generator: string, from: number, to: number): RootTransform | undefined {
    const motion = this.motion(generator);
    return motion ? rootMotionDelta(motion, from, to) : undefined;
  }

  /** The whole clip's displacement, turn and mean speed. */
  rootMotionTotal(generator: string): ReturnType<typeof rootMotionTotal> | undefined {
    const motion = this.motion(generator);
    return motion ? rootMotionTotal(motion) : undefined;
  }

  /** The animation sets whose conditions the equip state meets, in file order. */
  sets(equip: EquipState): AnimationSet[] {
    const values = new Map(
      Object.entries(equip).map(([name, value]) => [name.toLowerCase(), value]),
    );
    return (this.setData?.sets ?? []).filter((set) =>
      animationSetApplies(set, (variable) => values.get(variable.toLowerCase()) ?? 0),
    );
  }

  /**
   * The attacks of an equip state, one per attack event: from the sets whose conditions it
   * meets, then from the sets without conditions (a creature's only set); the first set naming
   * an event wins.
   */
  attacks(equip: EquipState): AnimationSetAttack[] {
    const sets = this.sets(equip);
    const attacks = new Map<string, AnimationSetAttack>();
    for (const set of [
      ...sets.filter((candidate) => candidate.conditions.length > 0),
      ...sets.filter((candidate) => candidate.conditions.length === 0),
    ]) {
      for (const attack of set.attacks) {
        const key = attack.event.toLowerCase();
        if (!attacks.has(key)) attacks.set(key, attack);
      }
    }
    return [...attacks.values()];
  }

  /** The attack an attack event (any case) starts in an equip state. */
  attack(equip: EquipState, event: string): AnimationSetAttack | undefined {
    const key = event.toLowerCase();
    return this.attacks(equip).find((attack) => attack.event.toLowerCase() === key);
  }

  /** A locomotion state's (iState) speed table, if it has one with curves. */
  #speedTable(state: number): SpeedTable | undefined {
    return this.speedData?.tables.find((table) => table.state === state && table.curves.length > 0);
  }

  /**
   * BSSpeedSamplerModifier: the locomotion blend parameter (SpeedSampled) that moves the actor
   * at the goal speed (Speed) in a state (iState) and direction (Direction).
   */
  speedParameter(state: number, direction: number, goal: number): number | undefined {
    const table = this.#speedTable(state);
    return table ? speedParameter(table, direction, goal) : undefined;
  }

  /** The speed the locomotion blend moves the actor at for a blend parameter. */
  speedAtParameter(state: number, direction: number, parameter: number): number | undefined {
    const table = this.#speedTable(state);
    return table ? speedAtParameter(table, direction, parameter) : undefined;
  }
}

export interface AnimationDataSources {
  readonly animationData?: string;
  readonly animationSetData?: string;
  readonly speedData?: Uint8Array;
  readonly actorResponses?: string;
  readonly playerResponses?: string;
}

/** Every behavior project's animation data. */
export class AnimationDataLibrary {
  /** What could not be read: whole files, or project blocks skipped. */
  readonly failures: readonly string[];
  readonly actorResponses: AnimationResponses | undefined;
  readonly playerResponses: AnimationResponses | undefined;
  readonly #projects = new Map<string, ProjectAnimationData>();

  /** `readFailures`: files that could not be read at all, to report with the rest. */
  constructor(sources: AnimationDataSources, readFailures: readonly string[] = []) {
    const failures = [...readFailures];
    const attempt = <T>(file: string, read: () => T): T | undefined => {
      try {
        return read();
      } catch (error) {
        if (!(error instanceof FormatError)) throw error;
        failures.push(`${file}: ${error.message}`);
        return undefined;
      }
    };
    const { animationData, animationSetData, speedData } = sources;
    const data =
      animationData === undefined
        ? undefined
        : attempt(ANIMATION_DATA_FILES.animationData, () => parseAnimationData(animationData));
    for (const failure of data?.failures ?? []) {
      failures.push(
        `${ANIMATION_DATA_FILES.animationData}: ${failure.project}: ${failure.message}`,
      );
    }
    const sets =
      (animationSetData === undefined
        ? undefined
        : attempt(ANIMATION_DATA_FILES.animationSetData, () =>
            parseAnimationSetData(animationSetData),
          )) ?? [];
    const speeds =
      (speedData === undefined
        ? undefined
        : attempt(ANIMATION_DATA_FILES.speedData, () => parseSpeedData(speedData))) ?? [];
    const responses = (text: string | undefined): AnimationResponses | undefined =>
      text === undefined ? undefined : parseAnimationResponses(text);
    this.actorResponses = responses(sources.actorResponses);
    this.playerResponses = responses(sources.playerResponses);
    this.failures = failures;

    // A name listed twice (ten object projects in vanilla): the first block with clip data,
    // else the first.
    const byName = new Map<string, AnimationDataProject>();
    for (const project of data?.projects ?? []) {
      const key = project.name.toLowerCase();
      const known = byName.get(key);
      if (!known || (!known.hasClipData && project.hasClipData)) byName.set(key, project);
    }
    const setsByName = new Map(sets.map((project) => [project.name.toLowerCase(), project]));
    const speedsByName = new Map(speeds.map((project) => [project.name.toLowerCase(), project]));
    for (const key of new Set([...byName.keys(), ...setsByName.keys(), ...speedsByName.keys()])) {
      const data = byName.get(key);
      this.#projects.set(
        key,
        new ProjectAnimationData(
          data?.name ?? setsByName.get(key)?.name ?? speedsByName.get(key)?.name ?? key,
          data,
          setsByName.get(key),
          speedsByName.get(key),
        ),
      );
    }
  }

  /** Reads the files from the VFS; a missing or corrupt file leaves its part empty. */
  static async load(read: (path: string) => Promise<Uint8Array>): Promise<AnimationDataLibrary> {
    const failures: string[] = [];
    const bytes = async (path: string): Promise<Uint8Array | undefined> => {
      try {
        return await read(path);
      } catch (error) {
        failures.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
        return undefined;
      }
    };
    const text = async (path: string): Promise<string | undefined> => {
      const data = await bytes(path);
      return data ? decodeWindows1252(data) : undefined;
    };
    const [animationData, animationSetData, speedData, actorResponses, playerResponses] =
      await Promise.all([
        text(ANIMATION_DATA_FILES.animationData),
        text(ANIMATION_DATA_FILES.animationSetData),
        bytes(ANIMATION_DATA_FILES.speedData),
        text(ANIMATION_DATA_FILES.actorResponses),
        text(ANIMATION_DATA_FILES.playerResponses),
      ]);
    return new AnimationDataLibrary(
      { animationData, animationSetData, speedData, actorResponses, playerResponses },
      failures,
    );
  }

  /** A project by its path (meshes\actors\character\defaultmale.hkx) or name (DefaultMale). */
  project(project: string): ProjectAnimationData | undefined {
    return this.#projects.get(animationDataKey(project));
  }

  get projects(): ProjectAnimationData[] {
    return [...this.#projects.values()];
  }

  /** The engine handler of an animation event, for the player or another actor. */
  response(event: string, player: boolean): string | undefined {
    if (!this.actorResponses) return undefined;
    return player && this.playerResponses
      ? animationResponse(event, this.playerResponses, this.actorResponses)
      : animationResponse(event, this.actorResponses);
  }
}
