// Recognizes game files by extension, size and content (magic bytes), so that
// renamed files cannot end up in the repo either (hard rule 1).

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const BLOCKED_EXTENSIONS = new Set([
  '.bsa', '.ba2', '.esm', '.esp', '.esl', '.nif', '.kf', '.dds', '.hkx', '.pex', '.psc',
  '.tri', '.lip', '.fuz', '.xwm', '.wav', '.swf', '.gfx', '.bik', '.ess', '.skse',
  '.strings', '.dlstrings', '.ilstrings', '.seq', '.btr', '.bto', '.lod',
]); // prettier-ignore

interface Signature {
  readonly label: string;
  readonly offset: number;
  readonly bytes: readonly number[];
}

const ascii = (text: string): number[] =>
  Array.from({ length: text.length }, (_, i) => text.charCodeAt(i));

const SIGNATURES: readonly Signature[] = [
  { label: 'BSA archive', offset: 0, bytes: ascii('BSA\0') },
  { label: 'BA2 archive', offset: 0, bytes: ascii('BTDX') },
  { label: 'plugin (ESM/ESP/ESL)', offset: 0, bytes: ascii('TES4') },
  { label: 'NIF model', offset: 0, bytes: ascii('Gamebryo File Format') },
  { label: 'DDS texture', offset: 0, bytes: ascii('DDS ') },
  { label: 'Papyrus bytecode (PEX)', offset: 0, bytes: [0xfa, 0x57, 0xc0, 0xde] },
  {
    label: 'Havok packfile (HKX)',
    offset: 0,
    bytes: [0x57, 0xe0, 0xe0, 0x57, 0x10, 0xc0, 0xc0, 0x10],
  },
  { label: 'xWMA audio', offset: 8, bytes: ascii('XWMA') },
  { label: 'FUZ dialogue', offset: 0, bytes: ascii('FUZE') },
  { label: 'savegame (ESS)', offset: 0, bytes: ascii('TESV_SAVEGAME') },
  { label: 'Bink video', offset: 0, bytes: ascii('BIK') },
  { label: 'Scaleform/SWF', offset: 0, bytes: ascii('FWS') },
  { label: 'Scaleform/SWF', offset: 0, bytes: ascii('CWS') },
  { label: 'Scaleform/GFX', offset: 0, bytes: ascii('GFX') },
  { label: 'Scaleform/GFX', offset: 0, bytes: ascii('CFX') },
];

function matches(head: Uint8Array, signature: Signature): boolean {
  return signature.bytes.every((byte, i) => head[signature.offset + i] === byte);
}

/**
 * Returns a reason if the file looks like a game file, otherwise `undefined`.
 * `head` only needs to contain the first 64 bytes.
 */
export function detectGameFile(path: string, size: number, head: Uint8Array): string | undefined {
  const dot = path.lastIndexOf('.');
  const extension = dot > path.lastIndexOf('/') ? path.slice(dot).toLowerCase() : '';
  if (BLOCKED_EXTENSIONS.has(extension)) return `extension ${extension}`;

  const signature = SIGNATURES.find((s) => matches(head, s));
  if (signature) return `content matches ${signature.label}`;

  if (size > MAX_FILE_BYTES) {
    return `larger than ${MAX_FILE_BYTES / 1024 / 1024} MB (${(size / 1024 / 1024).toFixed(1)} MB)`;
  }
  return undefined;
}
