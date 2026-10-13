// Material types (MATT): what surfaces are made of. Collision shapes name their material by
// an id, the CRC-32 of the material's lower-case name (MNAM) without the final inversion;
// the record adds its buoyancy, flags (stairs, arrows stick) and the impacts it makes.
// Platform-independent.
// Notes: docs/formats/esm.md ("Material types").

/** The record fields a material type is read from. */
interface RecordSource {
  readonly formId: number;
  readonly editorId?: string | undefined;
  readonly fields: { first(type: string): Uint8Array | undefined };
  formIdAt(data: Uint8Array, offset?: number): number;
}

/** MATT FNAM flags. */
export const MaterialFlag = {
  /** The character controller climbs it as stairs. */
  stairs: 0x1,
  arrowsStick: 0x2,
} as const;

export interface MaterialType {
  readonly formId: number;
  readonly editorId: string;
  /** MNAM, e.g. "StairsStone". */
  readonly name: string;
  /** The id collision shapes use (SkyrimHavokMaterial). */
  readonly id: number;
  readonly parent: number | undefined;
  readonly buoyancy: number;
  readonly flags: number;
  /** HNAM: the impacts of this material hitting others (IPDS; impact-records.ts). */
  readonly impactDataSet: number | undefined;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

/** The engine's material id of a name: CRC-32 (start 0, no final inversion) of its ASCII. */
export function materialId(name: string): number {
  let crc = 0;
  for (const char of name.toLowerCase()) {
    crc = ((CRC_TABLE[(crc ^ (char.charCodeAt(0) & 0xff)) & 0xff] ?? 0) ^ (crc >>> 8)) >>> 0;
  }
  return crc;
}

export function parseMaterialType(record: RecordSource): MaterialType {
  const u32 = (type: string): number | undefined => {
    const data = record.fields.first(type);
    return data && data.length >= 4
      ? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true)
      : undefined;
  };
  const mnam = record.fields.first('MNAM');
  let name = '';
  if (mnam) for (const byte of mnam) if (byte !== 0) name += String.fromCharCode(byte);
  const bnam = record.fields.first('BNAM');
  const pnam = record.fields.first('PNAM');
  const hnam = record.fields.first('HNAM');
  const impactDataSet = hnam && hnam.length >= 4 ? record.formIdAt(hnam) : 0;
  return {
    formId: record.formId,
    editorId: record.editorId ?? '',
    name,
    id: materialId(name),
    parent: pnam && pnam.length >= 4 ? record.formIdAt(pnam) : undefined,
    buoyancy:
      bnam && bnam.length >= 4
        ? new DataView(bnam.buffer, bnam.byteOffset, bnam.byteLength).getFloat32(0, true)
        : 0,
    flags: u32('FNAM') ?? 0,
    impactDataSet: impactDataSet === 0 ? undefined : impactDataSet,
  };
}
