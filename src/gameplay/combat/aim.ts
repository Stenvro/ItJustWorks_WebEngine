// How shots are aimed (docs/gameplay.md, "Aiming projectiles"; observed in the original):
// the angles a projectile leaves along, the player's aim assistance toward the crosshair, an
// NPC's aim at its target (the point it aims at, leading a moving target, the arc of a falling
// shot) and the stray of an NPC's arrows. Angles are radians: heading 0 north (+Y), π/2 east
// (+X); pitch up positive. Platform-independent.

type Vec3 = readonly [number, number, number];

/** The game settings aiming reads (GMST), with the engine's built-in values. */
export interface AimSettings {
  /** fAutoAimMaxDistance: how far the player's aim assistance looks (units). */
  readonly autoAimMaxDistance: number;
  /** fAutoAimScreenPercentage: the middle of the screen an actor must show in (percent). */
  readonly autoAimScreenPercentage: number;
  /** fAutoAimMaxDegrees, fAutoAimMaxDegrees3rdPerson: the most it turns a shot (degrees). */
  readonly autoAimMaxDegrees: number;
  readonly autoAimMaxDegrees3rdPerson: number;
  /** fBowNPCSpreadAngle: an NPC's arrows stray up to this far at Archery 0 (degrees). */
  readonly bowNpcSpreadAngle: number;
  /** fCombatAimProjectileRandomOffset: the most an NPC's aim point is off, per axis (units). */
  readonly aimProjectileRandomOffset: number;
  /** iCombatAimMaxIterations, fCombatAimDeltaThreshold: how a moving target is led. */
  readonly aimMaxIterations: number;
  readonly aimDeltaThreshold: number;
  /**
   * fCombatRangedAimVariance, fCombatMagicImmediateAimVariance,
   * fCombatMagicConcentrationAimVariance: how much of that offset a bow, a fire and forget
   * spell and a concentration spell take. TODO(M13): inferred: the engine reads them where the
   * combat AI sets its aim controller up; the controller's own factor was not traced to them.
   */
  readonly rangedAimVariance: number;
  readonly magicImmediateAimVariance: number;
  readonly magicConcentrationAimVariance: number;
}

/** The engine's built-in values (the plugins set none of them). */
export const AIM_DEFAULTS: AimSettings = {
  autoAimMaxDistance: 2500,
  autoAimScreenPercentage: 7,
  autoAimMaxDegrees: 1.2,
  autoAimMaxDegrees3rdPerson: 1.5,
  bowNpcSpreadAngle: 5,
  aimProjectileRandomOffset: 16,
  aimMaxIterations: 10,
  aimDeltaThreshold: 0.05,
  rangedAimVariance: 0.9,
  magicImmediateAimVariance: 0.5,
  magicConcentrationAimVariance: 0,
};

/** The settings by their GMST editor ids (the load order's, else the built-in value). */
export function readAimSettings(get: (name: string) => number | undefined): AimSettings {
  const d = AIM_DEFAULTS;
  return {
    autoAimMaxDistance: get('fAutoAimMaxDistance') ?? d.autoAimMaxDistance,
    autoAimScreenPercentage: get('fAutoAimScreenPercentage') ?? d.autoAimScreenPercentage,
    autoAimMaxDegrees: get('fAutoAimMaxDegrees') ?? d.autoAimMaxDegrees,
    autoAimMaxDegrees3rdPerson: get('fAutoAimMaxDegrees3rdPerson') ?? d.autoAimMaxDegrees3rdPerson,
    bowNpcSpreadAngle: get('fBowNPCSpreadAngle') ?? d.bowNpcSpreadAngle,
    aimProjectileRandomOffset:
      get('fCombatAimProjectileRandomOffset') ?? d.aimProjectileRandomOffset,
    aimMaxIterations: get('iCombatAimMaxIterations') ?? d.aimMaxIterations,
    aimDeltaThreshold: get('fCombatAimDeltaThreshold') ?? d.aimDeltaThreshold,
    rangedAimVariance: get('fCombatRangedAimVariance') ?? d.rangedAimVariance,
    magicImmediateAimVariance:
      get('fCombatMagicImmediateAimVariance') ?? d.magicImmediateAimVariance,
    magicConcentrationAimVariance:
      get('fCombatMagicConcentrationAimVariance') ?? d.magicConcentrationAimVariance,
  };
}

/** A direction as angles. */
export interface Angles {
  readonly heading: number;
  readonly pitch: number;
}

const DEGREES = Math.PI / 180;
/** The steepest a shot is aimed (the engine's limit, just short of straight up or down). */
const MAX_PITCH = 89 * DEGREES;

export function anglesOf(direction: Vec3): Angles {
  return {
    heading: Math.atan2(direction[0], direction[1]),
    pitch: Math.atan2(direction[2], Math.hypot(direction[0], direction[1])),
  };
}

export function directionOf(angles: Angles): [number, number, number] {
  const c = Math.cos(angles.pitch);
  return [Math.sin(angles.heading) * c, Math.cos(angles.heading) * c, Math.sin(angles.pitch)];
}

/** An angle brought into -π..π. */
function wrap(angle: number): number {
  let a = angle;
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/**
 * The pitch a shot at `speed` falling at `gravity` (units/s²) is launched at to pass a point
 * `horizontal` away and `rise` above (the flatter of the two arcs); undefined: out of reach.
 */
export function ballisticPitch(
  horizontal: number,
  rise: number,
  speed: number,
  gravity: number,
): number | undefined {
  if (!(gravity > 0) || !(speed > 0)) return Math.atan2(rise, horizontal);
  if (horizontal < 1e-6) return rise >= 0 ? MAX_PITCH : -MAX_PITCH;
  const v2 = speed * speed;
  const disc = v2 * v2 - gravity * (gravity * horizontal * horizontal + 2 * rise * v2);
  if (disc < 0) return undefined;
  return Math.atan((v2 - Math.sqrt(disc)) / (gravity * horizontal));
}

/**
 * The angles a shot leaves `from` along to reach `to`: straight at it, or for a falling shot
 * (gravity > 0) on the arc through it. Out of its reach it goes straight at it.
 */
export function aimAngles(from: Vec3, to: Vec3, speed: number, gravity: number): Angles {
  const way: Vec3 = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
  const straight = anglesOf(way);
  if (!(gravity > 0)) return straight;
  const pitch = ballisticPitch(Math.hypot(way[0], way[1]), way[2], speed, gravity);
  return pitch === undefined ? straight : { heading: straight.heading, pitch };
}

/**
 * The player's aim assistance as a shot is launched: the angles it leaves at are the view's
 * (`reference`, already tilted up), turned toward the angles that reach what it aims at
 * (`desired`) by at most `maxDegrees` each way. A shot of ammunition (an arrow, a bolt) is
 * never turned down.
 */
export function assistAim(
  reference: Angles,
  desired: Angles,
  maxDegrees: number,
  ammunition: boolean,
): Angles {
  const max = Math.max(0, maxDegrees) * DEGREES;
  const clamp = (v: number): number => Math.min(max, Math.max(-max, v));
  const heading = clamp(wrap(desired.heading - reference.heading));
  let pitch = clamp(desired.pitch - reference.pitch);
  if (ammunition && pitch < 0) pitch = 0;
  return {
    heading: wrap(reference.heading + heading),
    pitch: Math.min(MAX_PITCH, Math.max(-MAX_PITCH, reference.pitch + pitch)),
  };
}

/**
 * An NPC's arrow strays: up to `spreadDegrees` (fBowNPCSpreadAngle) times what its Archery
 * lacks of 100, in a direction around the aim (`radius`, `turn`: draws 0..1).
 */
export function npcSpread(
  angles: Angles,
  archery: number,
  spreadDegrees: number,
  radius: number,
  turn: number,
): Angles {
  const lack = Math.min(1, Math.max(0, (100 - archery) / 100));
  const r = radius * spreadDegrees * DEGREES * lack;
  const a = turn * 2 * Math.PI;
  return { heading: angles.heading + Math.sin(a) * r, pitch: angles.pitch + Math.cos(a) * r };
}

/**
 * Where on an actor shots are aimed, as shares of its height (where its skeleton's head or
 * torso node is not used): the upper body (the combat AI's), the middle (a shot at a target
 * outside combat) and the feet. Crouched (sneaking), the actor is 0.57 of its height.
 */
export const AIM_HEIGHT = { upper: 0.85, middle: 0.5, feet: 0.15 } as const;
export const SNEAK_HEIGHT = 0.57;

/** The point aimed at on an actor standing at `feet`, `height` tall. */
export function aimPoint(
  feet: Vec3,
  height: number,
  share: number,
  sneaking = false,
): [number, number, number] {
  return [feet[0], feet[1], feet[2] + height * share * (sneaking ? SNEAK_HEIGHT : 1)];
}

/**
 * The point an NPC aims a shot at to meet a target that moves (the combat AI's projectile aim):
 * the target's point where it will be once the shot gets there, found again from the flight
 * time to the last guess until it changes by less than the threshold (seconds) or the
 * iterations run out. A falling shot's point is raised onto the line of its arc's launch, so a
 * shot aimed straight at the point leaves on that arc.
 */
export function leadPoint(
  from: Vec3,
  target: Vec3,
  velocity: Vec3,
  speed: number,
  gravity: number,
  settings: Pick<AimSettings, 'aimMaxIterations' | 'aimDeltaThreshold'>,
): [number, number, number] {
  let point: [number, number, number] = [target[0], target[1], target[2]];
  if (!(speed > 0)) return point;
  let last = 0;
  let pitch: number | undefined;
  for (let i = 0; i < settings.aimMaxIterations; i++) {
    const horizontal = Math.hypot(point[0] - from[0], point[1] - from[1]);
    const rise = point[2] - from[2];
    let time: number;
    if (gravity > 0) {
      pitch = ballisticPitch(horizontal, rise, speed, gravity);
      time = horizontal / (speed * Math.cos(pitch ?? Math.PI / 4));
    } else {
      time = Math.hypot(horizontal, rise) / speed;
    }
    if (Math.abs(time - last) < settings.aimDeltaThreshold) break;
    point = [
      target[0] + velocity[0] * time,
      target[1] + velocity[1] * time,
      target[2] + velocity[2] * time,
    ];
    last = time;
  }
  if (gravity > 0) {
    const horizontal = Math.hypot(point[0] - from[0], point[1] - from[1]);
    pitch = ballisticPitch(horizontal, point[2] - from[2], speed, gravity);
    if (pitch !== undefined) point = [point[0], point[1], from[2] + Math.tan(pitch) * horizontal];
  }
  return point;
}

/**
 * An NPC's aim point is off by up to `variance` × fCombatAimProjectileRandomOffset on each axis
 * and, by a share up to `variance`, toward its target's middle (draws: four numbers 0..1).
 */
export function aimOffset(
  point: Vec3,
  towardMiddle: Vec3,
  variance: number,
  settings: Pick<AimSettings, 'aimProjectileRandomOffset'>,
  draws: readonly [number, number, number, number],
): [number, number, number] {
  if (!(variance > 0)) return [point[0], point[1], point[2]];
  const r = variance * settings.aimProjectileRandomOffset;
  const share = draws[3] * variance;
  return [
    point[0] + (draws[0] * 2 - 1) * r + (towardMiddle[0] - point[0]) * share,
    point[1] + (draws[1] * 2 - 1) * r + (towardMiddle[1] - point[1]) * share,
    point[2] + (draws[2] * 2 - 1) * r + (towardMiddle[2] - point[2]) * share,
  ];
}
