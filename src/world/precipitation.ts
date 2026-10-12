// Precipitation (SPGD, "shader particle geometry"): rain and snow that fill a box around the
// camera while a weather with it is on (WTHR MNAM). Platform-independent.
// Notes: docs/formats/esm.md ("Climate and weather").

/** The record fields precipitation is read from. */
interface PrecipitationSource {
  readonly formId: number;
  readonly editorId?: string | undefined;
  readonly fields: {
    first(type: string): Uint8Array | undefined;
    zstring(type: string): string | undefined;
  };
}

export interface Precipitation {
  readonly formId: number;
  readonly editorId: string;
  readonly type: 'rain' | 'snow';
  /** Fall speed (units per second; negative rises: blowing leaves). */
  readonly gravityVelocity: number;
  /** Snow: degrees per second the flakes turn and circle. */
  readonly rotationVelocity: number;
  /** Particle size (see PRECIPITATION_SIZE_SCALE). */
  readonly sizeX: number;
  readonly sizeY: number;
  /** Snow: radius range of the circles flakes drift on. */
  readonly centerOffsetMin: number;
  readonly centerOffsetMax: number;
  /** Degrees of random starting rotation. */
  readonly initialRotationRange: number;
  /** Texture atlas: columns and rows. */
  readonly subtexturesX: number;
  readonly subtexturesY: number;
  /** Edge of the box around the camera that the particles fill. */
  readonly boxSize: number;
  readonly density: number;
  /** `textures\...` path of the particle texture. */
  readonly texture: string;
}

export function parsePrecipitation(record: PrecipitationSource): Precipitation {
  const data = record.fields.first('DATA') ?? new Uint8Array(48);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const f = (offset: number, fallback = 0): number =>
    offset + 4 <= data.length ? view.getFloat32(offset, true) : fallback;
  const u = (offset: number, fallback = 0): number =>
    offset + 4 <= data.length ? view.getUint32(offset, true) : fallback;
  const icon = record.fields.zstring('ICON') ?? '';
  const normalized = icon.replaceAll('/', '\\').replace(/^\\+/, '').toLowerCase();
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    gravityVelocity: f(0),
    rotationVelocity: f(4),
    sizeX: f(8, 1),
    sizeY: f(12, 1),
    centerOffsetMin: f(16),
    centerOffsetMax: f(20),
    initialRotationRange: f(24),
    subtexturesX: Math.max(1, u(28, 1)),
    subtexturesY: Math.max(1, u(32, 1)),
    type: u(36) === 0 ? 'rain' : 'snow',
    boxSize: Math.max(64, u(40, 1024)),
    density: f(44, 1),
    texture:
      normalized === ''
        ? ''
        : normalized.startsWith('textures\\')
          ? normalized
          : `textures\\${normalized}`,
  };
}

/**
 * How much of a weather's precipitation shows during a change of weather (`transition` 0..1
 * from the previous weather to the current): the new weather's begins at its Precipitation
 * Begin Fade In and is full at the end; the old weather's fades out until its Precipitation
 * End Fade Out.
 */
export function precipitationAmounts(
  current: { readonly precipitation: number | undefined; readonly precipitationFadeIn: number },
  previous:
    | { readonly precipitation: number | undefined; readonly precipitationFadeOut: number }
    | undefined,
  transition: number,
): { readonly formId: number; readonly amount: number }[] {
  const amounts: { formId: number; amount: number }[] = [];
  if (current.precipitation !== undefined) {
    const begin = Math.min(0.999, Math.max(0, current.precipitationFadeIn));
    const amount = previous ? Math.max(0, Math.min(1, (transition - begin) / (1 - begin))) : 1;
    if (amount > 0) amounts.push({ formId: current.precipitation, amount });
  }
  if (previous?.precipitation !== undefined) {
    const end = Math.max(0.001, previous.precipitationFadeOut);
    const amount = Math.max(0, 1 - transition / end);
    if (amount > 0) {
      const same = amounts.find((entry) => entry.formId === previous.precipitation);
      if (same) same.amount = Math.min(1, same.amount + amount);
      else amounts.push({ formId: previous.precipitation, amount });
    }
  }
  return amounts;
}
