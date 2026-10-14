// Loading screens (LSCR): the text the loading menu shows and the model the mist menu shows
// behind it while the game loads (UESP, "Skyrim Mod:Mod File Format/LSCR"): DESC the text
// (localized), CTDA the conditions under which it may be chosen, NNAM the static whose model is
// shown, SNAM its initial scale, RNAM its initial rotation (X, Y, Z in degrees, int16),
// ONAM the rotation offset constraints (min, max), XNAM its initial translation offset, MOD2 a
// camera path. Platform-independent. Notes: docs/ui.md.

import { parseConditions, type Condition } from '../scripting/conditions.ts';
import type { GameRecord } from './record-db.ts';

export interface LoadingScreen {
  readonly formId: number;
  readonly editorId: string;
  readonly text: string;
  readonly conditions: readonly Condition[];
  /** The static (STAT) whose model is shown. */
  readonly model: number | undefined;
  readonly scale: number;
  /** Degrees about X, Y and Z. */
  readonly rotation: readonly [number, number, number];
  /** The rotation offset constraints: min and max degrees. */
  readonly rotationLimits: readonly [number, number] | undefined;
  readonly translation: readonly [number, number, number];
  readonly cameraPath: string | undefined;
}

export function parseLoadingScreen(record: GameRecord): LoadingScreen {
  const view = (type: string): DataView | undefined => {
    const data = record.fields.first(type);
    return data ? new DataView(data.buffer, data.byteOffset, data.byteLength) : undefined;
  };
  const snam = view('SNAM');
  const rnam = view('RNAM');
  const onam = view('ONAM');
  const xnam = view('XNAM');
  const camera = record.fields.zstring('MOD2');
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    text: record.text('DESC') ?? '',
    conditions: parseConditions(record),
    model: record.formIdField('NNAM'),
    scale: snam && snam.byteLength >= 4 ? snam.getFloat32(0, true) : 1,
    rotation:
      rnam && rnam.byteLength >= 6
        ? [rnam.getInt16(0, true), rnam.getInt16(2, true), rnam.getInt16(4, true)]
        : [0, 0, 0],
    rotationLimits:
      onam && onam.byteLength >= 4 ? [onam.getInt16(0, true), onam.getInt16(2, true)] : undefined,
    translation:
      xnam && xnam.byteLength >= 12
        ? [xnam.getFloat32(0, true), xnam.getFloat32(4, true), xnam.getFloat32(8, true)]
        : [0, 0, 0],
    cameraPath: camera && camera.trim() !== '' ? camera : undefined,
  };
}

/**
 * The loading screen to show: one at random among those whose conditions hold (the engine
 * picks among the matching ones), `holds` judging them.
 */
export function pickLoadingScreen(
  screens: readonly LoadingScreen[],
  holds: (screen: LoadingScreen) => boolean,
  random: () => number = Math.random,
): LoadingScreen | undefined {
  const matching = screens.filter((screen) => holds(screen));
  if (matching.length === 0) return undefined;
  return matching[Math.min(matching.length - 1, Math.floor(random() * matching.length))];
}
