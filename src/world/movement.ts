// Movement types (MOVT): how fast an actor moves in each direction while walking and running,
// and how fast it turns. The behavior graph picks the movement type by its name (MNAM), e.g.
// "NPCDefault", "NPCSprinting", "NPCSneaking", "NPCSwimming". Platform-independent.
// Notes: docs/formats/esm.md ("Movement types").

/** The record fields a movement type is read from. */
interface RecordSource {
  readonly formId: number;
  readonly editorId?: string | undefined;
  readonly fields: { first(type: string): Uint8Array | undefined };
}

/** Speeds in game units per second by direction. */
export interface DirectionSpeeds {
  readonly left: number;
  readonly right: number;
  readonly forward: number;
  readonly back: number;
}

export interface MovementType {
  readonly formId: number;
  readonly editorId: string;
  /** MNAM: the name the behavior graph asks for. */
  readonly name: string;
  readonly walk: DirectionSpeeds;
  readonly run: DirectionSpeeds;
  /** Turning on the spot, radians per second. */
  readonly rotateInPlace: { readonly walk: number; readonly run: number };
  /** Turning while moving (running), radians per second (older records: the in-place run). */
  readonly rotateWhileMoving: number;
}

export function parseMovementType(record: RecordSource): MovementType {
  const sped = record.fields.first('SPED') ?? new Uint8Array(0);
  const view = new DataView(sped.buffer, sped.byteOffset, sped.byteLength);
  const f = (index: number): number =>
    (index + 1) * 4 <= sped.length ? view.getFloat32(index * 4, true) : 0;
  const mnam = record.fields.first('MNAM');
  let name = '';
  if (mnam) for (const byte of mnam) if (byte !== 0) name += String.fromCharCode(byte);
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    name,
    walk: { left: f(0), right: f(2), forward: f(4), back: f(6) },
    run: { left: f(1), right: f(3), forward: f(5), back: f(7) },
    rotateInPlace: { walk: f(8), run: f(9) },
    rotateWhileMoving: sped.length >= 44 ? f(10) : f(9),
  };
}

/**
 * The player's pace moved by a gamepad's stick: at full deflection the walk or the run, and in
 * between as far as the stick is pushed (`deflection` 0..1; keys: 1): running, from the walk up
 * to the run; walking, up to the walk. TODO(M13): inferred from the game (a partly pushed stick
 * walks slower than the full walk); the engine's own curve is not read.
 */
export function stickPace(walk: number, run: number, running: boolean, deflection: number): number {
  const share = Math.max(0, Math.min(1, deflection));
  return running ? walk + (run - walk) * share : walk * share;
}

/**
 * Speed along a direction in the actor's frame (`x` right, `y` forward; any length): the
 * direction's point on the ellipse through the four directional speeds of its quadrant.
 */
export function directionalSpeed(speeds: DirectionSpeeds, x: number, y: number): number {
  const length = Math.hypot(x, y);
  if (length === 0) return 0;
  const ux = x / length;
  const uy = y / length;
  const side = ux >= 0 ? speeds.right : speeds.left;
  const ahead = uy >= 0 ? speeds.forward : speeds.back;
  if (side <= 0) return Math.abs(uy) > 1e-6 ? ahead : 0;
  if (ahead <= 0) return Math.abs(ux) > 1e-6 ? side : 0;
  return 1 / Math.hypot(ux / side, uy / ahead);
}
