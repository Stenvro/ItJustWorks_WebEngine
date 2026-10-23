// How fast the world's time runs and the player with it (docs/gameplay.md, "Magic effects"):
// Slow Time on the player slows the world's clock to its magnitude (the frame's clock in
// main.ts: animations, physics, the actors, the world's sounds) while the player keeps a pace
// of their own (the magic system's playerPace: 70 %, Quick Reflexes whole). A bow zoomed with
// Eagle Eye (Mod Bow Zoom: the view's factor, holding block with an arrow drawn) slows the
// world by the player's BowSpeedBonus (Steady Hand: −0.5, both ranks −0.75; UESP
// "Skyrim:Archery": 50 % and 75 %), the player with it, and costs stamina each second (Eagle
// Eye's Mod Power Attack Stamina on bows: 10; UESP: "drains Stamina at 10 per second"); it
// cannot be held without stamina nor under Slow Time. Falls take health, the player's and every
// other actor's (src/gameplay/falling.ts; Mod Falling Damage).

import { fallDamage, fallSettings } from '../gameplay/falling.ts';
import { EntryPoint } from '../gameplay/perk-entry-points.ts';
import { PLAYER_REF } from '../scripting/runtime/forms.ts';
import type { ScriptRuntime } from '../scripting/runtime/runtime.ts';
import { ActorValue, actorValueIndex } from '../world/actor-values.ts';

/** The player's part: their pace in slowed time, their falls (a viewer's player). */
export function connectPlayerTime(
  player: {
    pace: (() => number) | undefined;
    onLanded: ((height: number) => void) | undefined;
  },
  session: () =>
    { readonly time: TimeFlow; readonly scriptsReady: ScriptRuntime | undefined } | undefined,
): void {
  player.pace = () => session()?.time.playerPace ?? 1;
  player.onLanded = (height) => {
    const current = session();
    const runtime = current?.scriptsReady;
    if (current && runtime) void current.time.fell(runtime, height);
  };
}

/** How often the perks' values are asked again (real seconds). */
const REFRESH_SECONDS = 0.25;

const BOW_SPEED_BONUS = actorValueIndex('BowSpeedBonus') ?? 0;

export class TimeFlow {
  /** How fast the world's clock runs now (1: as the real one). */
  multiplier = 1;
  /**
   * The kill camera's shot's pace (src/shell/killmove-camera.ts; 1: none plays): while one
   * plays, it is the world's clock (the engine's VATS playback sets the global time multiplier).
   */
  killCam = 1;
  /** The player's own pace against the world's clock (Player.pace). */
  playerPace = 1;
  /** The bow's zoom (the view's factor) while it is held, and whether it is held now. */
  #zoomFactor = 1;
  #zoomWanted = false;
  #zoomWeapon: number | undefined;
  #canZoom = false;
  #bowSpeed = 0;
  /** The player's absolute pace in Slow Time. */
  #slowedPace = 1;
  #wait = 0;
  #asking = false;

  /** Whether the bow is zoomed now. */
  get bowZoomed(): boolean {
    return this.#zoomWanted && this.#canZoom && this.#zoomFactor < 1;
  }

  /**
   * The player holds block with an arrow drawn (`wanted`) on a bow: the view's factor to show
   * (1: no zoom: no Eagle Eye, no stamina, Slow Time).
   */
  bowZoom(wanted: boolean, weapon: number | undefined): number {
    this.#zoomWanted = wanted;
    this.#zoomWeapon = weapon;
    return this.bowZoomed ? this.#zoomFactor : 1;
  }

  /** Every frame of the running game: the clocks set, the zoom's stamina spent. */
  update(runtime: ScriptRuntime, realSeconds: number): void {
    const magic = runtime.magic.timeMultiplier();
    const zoomed = this.bowZoomed;
    const bow = zoomed ? Math.min(1, Math.max(0.05, 1 + this.#bowSpeed)) : 1;
    this.multiplier = this.killCam !== 1 ? this.killCam : Math.min(magic, bow);
    // In Slow Time the player keeps their pace; a zoom slows them with the world, so does a kill
    // camera's shot.
    const pace = magic < 1 && this.killCam === 1 ? this.#slowedPace : this.multiplier;
    this.playerPace = this.multiplier > 0 ? pace / this.multiplier : 1;
    if (zoomed && realSeconds > 0) void this.#spendZoom(runtime, realSeconds);
    this.#wait -= realSeconds;
    if (this.#wait > 0 || this.#asking) return;
    this.#wait = REFRESH_SECONDS;
    this.#asking = true;
    void this.#ask(runtime, magic).finally(() => {
      this.#asking = false;
    });
  }

  #zoomCost = 0;

  async #spendZoom(runtime: ScriptRuntime, seconds: number): Promise<void> {
    if (this.#zoomCost > 0)
      await runtime.progression.spend(PLAYER_REF, ActorValue.stamina, this.#zoomCost * seconds);
  }

  /** The perks' and values' parts, asked a few times a second. */
  async #ask(runtime: ScriptRuntime, magic: number): Promise<void> {
    const weapon = this.#zoomWeapon;
    const perks = runtime.perks;
    const actors = runtime.actors;
    const [factor, cost, stamina, bowSpeed, pace] = await Promise.all([
      perks.apply(EntryPoint.modBowZoom, PLAYER_REF, 1, [weapon]),
      perks.apply(EntryPoint.modPowerAttackStamina, PLAYER_REF, 0, [weapon]),
      actors.value(PLAYER_REF, ActorValue.stamina),
      actors.value(PLAYER_REF, BOW_SPEED_BONUS),
      runtime.magic.playerPace(),
    ]);
    this.#zoomFactor = factor > 0 ? factor : 1;
    this.#zoomCost = Math.max(0, cost);
    this.#canZoom = magic >= 1 && (this.#zoomCost <= 0 || stamina.current > 0);
    this.#bowSpeed = bowSpeed.current;
    this.#slowedPace = pace;
  }

  /** The player landed after falling `height` units (actorFell). */
  fell(runtime: ScriptRuntime, height: number): Promise<void> {
    return actorFell(runtime, PLAYER_REF, height);
  }
}

/**
 * An actor landed after falling `height` units (`share`: of the minimum height that hurts;
 * RAGDOLL_FALL_SHARE getting up from a ragdoll): the fall's damage (the player's settings for the
 * player, the NPCs' for any other actor, horses too; its perks' Mod Falling Damage) on its health.
 */
export async function actorFell(
  runtime: ScriptRuntime,
  reference: number,
  height: number,
  share = 1,
): Promise<void> {
  const npc = reference !== PLAYER_REF;
  const suffix = npc ? 'NPC' : '';
  const values = new Map<string, number | undefined>();
  for (const name of ['fJumpFallHeightMin', 'fJumpFallHeightMult', 'fJumpFallHeightExponent']) {
    const setting = await runtime.gameSetting(name + suffix);
    values.set(name + suffix, typeof setting === 'number' ? setting : undefined);
  }
  const damage = fallDamage(
    height,
    fallSettings((name) => values.get(name), npc),
    share,
  );
  if (damage <= 0) return;
  const taken = await runtime.perks.apply(EntryPoint.modFallingDamage, reference, damage);
  if (taken <= 0 || (await runtime.actors.isInvulnerable(reference))) return;
  await runtime.actors.damage(reference, ActorValue.health, taken, undefined);
}
