// The crosshair's check of a Target Location spell (hudmenu.swf's ValidateCrosshair), as observed
// in the original: the player's magic casters keep a list of the hands whose current spell is
// delivered at a Target Location (a hand joins as such a spell becomes its spell, leaves as
// another does or it is cleared). For the first hand on that list, at most every 200 ms, the
// engine aims the spell (a pick on the spell layer from the caster along its aim, as far as the
// spell's range in feet × fMagicUnitsPerFoot after the perks' Mod Spell Range (Target Loc.), 5000
// units without a range) and checks each of its effects at the point met: an effect delivered at
// a Target Location with a projectile (a summon, a rune) needs a surface it can stand on there:
// the collision layers Static, Terrain or Ground. The HUD's base clip goes to its "Normal" frame
// when every effect holds, else to "Alert" (its other crosshair clip), and then hears
// ValidateCrosshair (which shows the frame's crosshair as the HUD's mode allows). A pick that meets
// nothing is Alert; the list becoming empty sets Normal once more.
// TODO(M13): the original's pick starts at the caster's magic node and goes along the actor's
// aim; ours goes along the camera's ray. The pick result's second "no target" flag is not read.
// Notes: docs/ui.md ("The HUD").

import { Layer } from '../physics/collision-layers.ts';
import type { Vec3 } from '../render/math.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import { Delivery } from '../world/magic-records.ts';

/** How often the aimed spell is checked (ms), as the original's caster does. */
export const CROSSHAIR_CHECK_MS = 200;
/** The aim's reach without a range on the spell (units). */
export const CROSSHAIR_DEFAULT_REACH = 5000;

/** The surfaces a Target Location effect may land on. */
const SURFACES: ReadonlySet<number> = new Set([Layer.static, Layer.terrain, Layer.ground]);

/** What the check reads of an effect (its MGEF). */
export interface CrosshairEffect {
  readonly delivery: number;
  readonly projectile: number | undefined;
}

/** Whether one effect holds at what the aim met (undefined: nothing). */
export function effectHoldsAt(effect: CrosshairEffect, layer: number | undefined): boolean {
  if (effect.delivery !== Delivery.targetLocation || effect.projectile === undefined) return true;
  return layer !== undefined && SURFACES.has(layer);
}

/** Whether every effect holds at what the aim met: the crosshair's "Normal" frame, else "Alert". */
export function crosshairValid(
  effects: readonly CrosshairEffect[],
  layer: number | undefined,
): boolean {
  if (layer === undefined) return false;
  return effects.every((effect) => effectHoldsAt(effect, layer));
}

/** The reach of the aim for a spell's range in feet (≤ 0: the default reach). */
export function crosshairReach(rangeFeet: number, unitsPerFoot: number): number {
  return rangeFeet > 0 ? rangeFeet * unitsPerFoot : CROSSHAIR_DEFAULT_REACH;
}

/** What the aim reads of the player's play (a PlayerView: its physics, its camera). */
export interface AimingPlayer<C> {
  readonly play: {
    readonly player: {
      readonly character: {
        readonly physics: {
          readonly queriesCurrent: boolean;
          raycast(
            origin: Vec3,
            direction: Vec3,
            maxDistance: number,
            layer: number,
            exclude?: C,
          ):
            | {
                readonly distance: number;
                readonly layer: number;
                readonly owner: { readonly reference?: number } | undefined;
              }
            | undefined;
        };
        readonly collider: C;
      };
    };
    readonly view: { readonly position: Vec3; readonly forward?: Vec3 | undefined };
    readonly forward: Vec3;
  };
}

/** The aim passes the player's own bodies this many times at most (units a step). */
const SELF_TRIES = 4;
const SELF_STEP = 4;

/**
 * The spell's aim from the player's view: the collision layer the camera's ray meets within
 * `reach` on the spell layer (the player's own bodies passed; undefined: nothing), or undefined
 * while there is no world to aim in.
 */
export function spellAim<C>(
  player: AimingPlayer<C> | undefined,
  reach: number,
): { readonly layer: number | undefined } | undefined {
  const play = player?.play;
  if (!play) return undefined;
  const physics = play.player.character.physics;
  if (!physics.queriesCurrent) return undefined;
  const from = play.view.position;
  const forward = play.view.forward ?? play.forward;
  let start = 0;
  for (let tries = 0; tries < SELF_TRIES; tries++) {
    const origin: Vec3 = [
      from[0] + forward[0] * start,
      from[1] + forward[1] * start,
      from[2] + forward[2] * start,
    ];
    const hit = physics.raycast(
      origin,
      forward,
      reach - start,
      Layer.spell,
      play.player.character.collider,
    );
    if (!hit) break;
    if (hit.owner?.reference !== PLAYER_REF) return { layer: hit.layer };
    start += hit.distance + SELF_STEP;
  }
  return { layer: undefined };
}

/** The hands (casting sources: 0 left, 1 right) with a Target Location spell, in joining order. */
export class AimedHands {
  readonly #hands: number[] = [];

  /**
   * The hands' spells now (true: a Target Location spell). Returns the hand to check (the first
   * on the list), and whether the list has just become empty (the crosshair goes back to Normal).
   */
  update(aimed: ReadonlyMap<number, boolean>): { hand: number | undefined; emptied: boolean } {
    const before = this.#hands.length;
    for (const [hand, on] of aimed) {
      const index = this.#hands.indexOf(hand);
      if (on && index < 0) this.#hands.push(hand);
      else if (!on && index >= 0) this.#hands.splice(index, 1);
    }
    return { hand: this.#hands[0], emptied: before > 0 && this.#hands.length === 0 };
  }
}
