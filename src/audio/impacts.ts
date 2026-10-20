// The sounds of physics impacts: a simulated object hitting something plays the impact its
// material's impact data set (MATT HNAM → IPDS) gives for the material it hit (→ IPCT): the
// light sound (SNAM), or the heavy one (NAM1) from [Audio] fCollisionSoundHeavyThreshold up.
// Contacts below fMinSoundVel are not reported by the physics; one body sounds at most every
// iCollisionSoundTimeDelta milliseconds. A material without an impact data set uses its
// nearest parent's (PNAM), and an impact data set without an entry for the material hit uses
// that material's nearest parent's entry (inferred: TODO(M13)). Platform-independent. Notes:
// docs/audio.md ("Impacts").

import type { Vec3 } from '../render/math.ts';
import type { Impact, ImpactDataSet } from '../world/impact-records.ts';
import type { MaterialType } from '../world/material-type.ts';

/** A collision as the physics reports it (PhysicsImpact). */
export interface ImpactHit {
  readonly position: Vec3;
  /** Game units per second. */
  readonly speed: number;
  /** MATT ids (collision material ids); 0: unknown. */
  readonly material: number;
  readonly against: number;
  /** The landscape has no material of its own yet: the default land material. */
  readonly againstKind: 'object' | 'landscape' | 'actor' | undefined;
  readonly body: number;
}

/** Where impacts come from (the sound system's record caches). */
export interface ImpactRecords {
  /** A material by its collision id. */
  materialById(id: number): Promise<MaterialType | undefined>;
  /** A material by form id (parents). */
  material(formId: number): Promise<MaterialType | undefined>;
  impactDataSet(formId: number): Promise<ImpactDataSet | undefined>;
  impact(formId: number): Promise<Impact | undefined>;
  /** DLMT: the material of the landscape where its land texture names none. */
  readonly landMaterial: number | undefined;
  /** The material (MATT form id) of the land texture at a point (LTEX MNAM). */
  landMaterialAt(position: Vec3): number | undefined;
}

export interface ImpactSettings {
  /** fCollisionSoundHeavyThreshold: game units per second. */
  readonly heavySpeed: number;
  /** iCollisionSoundTimeDelta: seconds between one body's impact sounds. */
  readonly interval: number;
}

/** Parent chains are short; this bounds a broken (cyclic) one. */
const MAX_PARENTS = 8;

/** The material of the landscape at a point: its land texture's, else the default (DLMT). */
export async function landMaterial(
  records: ImpactRecords,
  position: Vec3,
): Promise<MaterialType | undefined> {
  const formId = records.landMaterialAt(position) ?? records.landMaterial;
  return formId === undefined ? undefined : records.material(formId);
}

/** An impact data set's impact for a material, or for its nearest parent with one. */
export async function impactAgainst(
  records: ImpactRecords,
  set: ImpactDataSet,
  material: MaterialType | undefined,
): Promise<Impact | undefined> {
  let against = material;
  for (let i = 0; against && i < MAX_PARENTS; i++) {
    const entry = set.impacts.get(against.formId);
    if (entry !== undefined) return records.impact(entry);
    against = against.parent === undefined ? undefined : await records.material(against.parent);
  }
  return undefined;
}

export class ImpactSounds {
  readonly #records: ImpactRecords;
  readonly #settings: ImpactSettings;
  readonly #play: (sound: number, position: Vec3) => void;
  /** When each body last sounded (seconds). */
  readonly #last = new Map<number, number>();

  constructor(
    records: ImpactRecords,
    settings: ImpactSettings,
    play: (sound: number, position: Vec3) => void,
  ) {
    this.#records = records;
    this.#settings = settings;
    this.#play = play;
  }

  /** Plays the sound of an impact (`now`: seconds). */
  async hit(hit: ImpactHit, now: number): Promise<Impact | undefined> {
    const last = this.#last.get(hit.body);
    if (last !== undefined && now - last < this.#settings.interval) return undefined;
    this.#last.set(hit.body, now);
    if (this.#last.size > 1024) this.#forget(now);
    const impact = await this.#impactOf(hit);
    if (!impact) return undefined;
    const heavy = hit.speed >= this.#settings.heavySpeed;
    const sound = (heavy ? impact.heavySound : undefined) ?? impact.sound;
    if (sound !== undefined) this.#play(sound, hit.position);
    // The impact that sounded (its sound level is a noise for detection).
    return impact;
  }

  async #impactOf(hit: ImpactHit): Promise<Impact | undefined> {
    const records = this.#records;
    // The impact data set of the moving material, or of its nearest parent with one.
    let material = await records.materialById(hit.material);
    for (let i = 0; material && material.impactDataSet === undefined && i < MAX_PARENTS; i++) {
      material =
        material.parent === undefined ? undefined : await records.material(material.parent);
    }
    const set =
      material?.impactDataSet === undefined
        ? undefined
        : await records.impactDataSet(material.impactDataSet);
    if (!set) return undefined;
    const against =
      hit.against !== 0
        ? await records.materialById(hit.against)
        : hit.againstKind === 'landscape'
          ? await landMaterial(records, hit.position)
          : undefined;
    return impactAgainst(records, set, against);
  }

  /** Drops bodies that have been quiet for a while. */
  #forget(now: number): void {
    for (const [body, time] of this.#last) {
      if (now - time > this.#settings.interval * 10) this.#last.delete(body);
    }
  }
}
