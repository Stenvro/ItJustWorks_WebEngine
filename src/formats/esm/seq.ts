// SEQ files (Data\Seq\<plugin>.seq): the form ids of a plugin's start-game-enabled quests
// that hold dialogue, as the Creation Kit writes them for the engine to start with the game.
// The file is nothing but little-endian u32 form ids in the plugin's own form id space (its
// masters' indices in the high byte, the plugin's own after them). Platform-independent.
// Notes: docs/formats/esm.md ("SEQ files").

import { FormatError } from '../binary-reader.ts';

export function parseSeq(bytes: Uint8Array): Uint32Array {
  if (bytes.length % 4 !== 0) {
    throw new FormatError(`SEQ file of ${bytes.length} bytes is not a list of form ids`, 0);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Uint32Array.from({ length: bytes.length / 4 }, (_, i) => view.getUint32(i * 4, true));
}

/** Path of a plugin's SEQ file in the VFS, e.g. `seq\dawnguard.seq`. */
export function seqPath(plugin: string): string {
  const dot = plugin.lastIndexOf('.');
  return `seq\\${(dot < 0 ? plugin : plugin.slice(0, dot)).toLowerCase()}.seq`;
}
