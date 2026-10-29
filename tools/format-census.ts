// Completeness census of the file formats: sweeps the whole load order and its archives and
// counts what our parsers do not read. The checklist it feeds is docs/completeness/formats.md.
//
//   node tools/format-census.ts files [ext...]  every file of the VFS by extension, with its
//                                                reader (and where the files of `ext` are)
//   node tools/format-census.ts bsa        every archive in Data: names against hashes, every
//                                          file read and decompressed
//   node tools/format-census.ts esm        every record type and subrecord in the load order,
//                                          against the subrecords the engine's code reads
//   node tools/format-census.ts strings    every string table of every language, and whether
//                                          every FULL id of the load order resolves
//   node tools/format-census.ts hkx        every Havok file by class, and which have a layout
//
// Without a section it runs files, esm and strings (bsa reads every byte, about a minute).
// The other formats have sweeps of their own: nif-stats --parse, dds-stats, pex-dump --verify,
// hkx-info --audit, audio-info --audit, tri-info --all, lod-info --meshes, swf-info --all.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BsaArchive } from '../src/formats/bsa/bsa.ts';
import { forEachRecord, indexPlugin } from '../src/formats/esm/plugin-index.ts';
import { parsePluginHeader, PluginFlag } from '../src/formats/esm/plugin-header.ts';
import { parseFields } from '../src/formats/esm/record.ts';
import {
  PluginStrings,
  STRING_TABLE_KINDS,
  StringTable,
  stringTablePath,
  type StringTableKind,
} from '../src/formats/esm/strings.ts';
import { HAVOK_LAYOUTS } from '../src/formats/hkx/layouts.ts';
import { Packfile } from '../src/formats/hkx/packfile.ts';
import { readAnimationContainer, TRANSFORM_FLOATS } from '../src/formats/hkx/animation.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder, resolveDataFile } from './gamedata-path.ts';
import { NodeFileSource } from './node-game-folder.ts';

const SECTIONS = ['files', 'bsa', 'esm', 'strings', 'hkx'];
const args = process.argv.slice(2);
const run = (name: string): boolean =>
  args.some((arg) => SECTIONS.includes(arg)) ? args.includes(name) : name !== 'bsa';

/**
 * The reader of each extension found in the game data, and the sweep that runs it over every
 * file. Formats the original engine does not load are named as such.
 */
const READERS: Readonly<Record<string, string>> = {
  nif: 'src/formats/nif (nif-stats --parse)',
  btr: 'src/formats/nif (lod-info --meshes)',
  bto: 'src/formats/nif (lod-info --meshes)',
  dds: 'src/formats/dds (dds-stats)',
  hkx: 'src/formats/hkx (format-census hkx)',
  hkt: 'src/formats/hkx/tagfile.ts (format-census hkx)',
  pex: 'src/formats/pex (pex-dump --verify)',
  xwm: 'src/formats/audio (audio-info --audit)',
  wav: 'src/formats/audio (audio-info --audit)',
  fuz: 'src/formats/audio (audio-info --audit)',
  swf: 'src/formats/swf (swf-info --all)',
  gfx: 'src/formats/swf (swf-info --all)',
  tri: 'src/formats/nif/tri.ts (tri-info --all)',
  btt: 'src/formats/lod (lod-info)',
  lst: 'src/formats/lod (lod-info)',
  lod: 'src/formats/lod (lod-info)',
  seq: 'src/formats/esm/seq.ts (seq-info)',
  txt: 'animdata, controlmap, fontconfig, translations',
  strings: 'src/formats/esm/strings.ts (format-census strings)',
  dlstrings: 'src/formats/esm/strings.ts (format-census strings)',
  ilstrings: 'src/formats/esm/strings.ts (format-census strings)',
  esm: 'src/formats/esm (esm-stats --verify)',
  esl: 'src/formats/esm (esm-stats --verify)',
  bsa: 'src/formats/bsa (format-census bsa)',
  png: 'the browser (book images, img:// in book text)',
  bik: 'src/audio/bink-video.ts (ffmpeg.wasm)',
  hkb: 'not loaded by the original: Havok editor source',
  hkc: 'not loaded by the original: Havok editor source',
  hkp: 'not loaded by the original: Havok editor project',
  psd: 'not loaded by the original: an image editor file',
  csv: 'not loaded by the original: console amiibo table',
  xlsx: 'not loaded by the original: console amiibo table',
  fxp: 'not loaded by the original: compiled shaders of the original',
};

function extensionOf(file: string): string {
  const base = file.slice(file.lastIndexOf('\\') + 1);
  const dot = base.lastIndexOf('.');
  return dot < 0 ? '(none)' : base.slice(dot + 1).toLowerCase();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const dataFolder = path.dirname(resolveDataFile('Skyrim.esm'));
const vfs = await Vfs.mount(openGameFolder());

if (run('files')) {
  // Every file the VFS resolves (loose files win over archives), by extension and top folder.
  const byExtension = new Map<string, { count: number; folders: Map<string, number> }>();
  for (const file of vfs.list('')) {
    const extension = extensionOf(file);
    const entry = byExtension.get(extension) ?? { count: 0, folders: new Map<string, number>() };
    entry.count++;
    const top = file.includes('\\') ? file.slice(0, file.indexOf('\\')) : '.';
    entry.folders.set(top, (entry.folders.get(top) ?? 0) + 1);
    byExtension.set(extension, entry);
  }
  console.log(`Files in the VFS by extension (${vfs.fileCount} files):`);
  for (const [extension, entry] of [...byExtension].sort((a, b) => b[1].count - a[1].count)) {
    const folders = [...entry.folders]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([folder, count]) => `${folder} ${count}`)
      .join(', ');
    console.log(
      `  ${extension.padEnd(10)} ${String(entry.count).padStart(7)}  ${(READERS[extension] ?? 'none').padEnd(48)} ${folders}`,
    );
  }
  // `files <ext>...`: where the files of those extensions are, by folder.
  const listed = args.filter((arg) => !SECTIONS.includes(arg));
  const byFolder = new Map<string, string[]>();
  for (const file of vfs.list('')) {
    if (!listed.includes(extensionOf(file))) continue;
    const key = `${extensionOf(file)} ${file.split('\\').slice(0, -1).slice(0, 3).join('\\')}`;
    byFolder.set(key, [...(byFolder.get(key) ?? []), file]);
  }
  for (const [key, list] of byFolder) {
    console.log(`  ${key}: ${list.length}  ${list.slice(0, 3).join(' | ')}`);
  }
  console.log(
    `Skyrim.ccc: ${vfs.hasCreationClubList ? 'read' : 'missing'}; Skyrim_Default.ini: ${vfs.defaultIni ? 'read' : 'missing'}`,
  );
}

if (run('bsa')) {
  // Every archive in Data, mounted or not (MarketplaceTextures.bsa is in no INI list and has no
  // plugin), with its names checked against the stored hashes; every file read and decompressed.
  let files = 0;
  let bytes = 0;
  const failures: string[] = [];
  const start = performance.now();
  const mounted = new Set(vfs.archives.map((archive) => archive.name.toLowerCase()));
  for (const name of readdirSync(dataFolder).filter((file) => /\.bsa$/i.test(file))) {
    const archiveStart = performance.now();
    const source = await NodeFileSource.open(path.join(dataFolder, name));
    let archiveFiles = 0;
    let compressed = 0;
    try {
      const archive = await BsaArchive.open(source, { verifyHashes: true });
      for (const entry of archive.entries) {
        try {
          if (entry.compressed) compressed++;
          bytes += (await archive.read(entry)).length;
          files++;
          archiveFiles++;
        } catch (error) {
          failures.push(`${name} ${entry.path ?? '(unnamed)'}: ${message(error)}`);
        }
      }
      console.log(
        `  ${name.padEnd(36)} v${archive.header.version} ${String(archiveFiles).padStart(7)} files, ${String(compressed).padStart(7)} compressed, ${((performance.now() - archiveStart) / 1000).toFixed(1)} s${mounted.has(name.toLowerCase()) ? '' : ', not mounted'}`,
      );
    } catch (error) {
      failures.push(`${name}: ${message(error)}`);
    }
    await source.close();
  }
  console.log(
    `BSA: ${files} files, ${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB in ${((performance.now() - start) / 1000).toFixed(0)} s, ${failures.length} failures`,
  );
  for (const failure of failures.slice(0, 20)) console.log(`    ${failure}`);
}

/** Every string literal of four record-code characters in the engine's code, per file. */
function codeLiteralsPerFile(): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
        const text = readFileSync(full, 'utf8');
        const codes = new Set<string>();
        for (const match of text.matchAll(/['"`]([A-Z0-9_]{4})['"`]/g)) codes.add(match[1] ?? '');
        // Codes a reader builds (`TX0${i}`, `${letter}IAD`): kept as patterns, ? for the part.
        for (const match of text.matchAll(/`([A-Z0-9_]{0,3})\$\{[^}`]*\}([A-Z0-9_]{0,3})`/g)) {
          const pattern = `${match[1] ?? ''}?${match[2] ?? ''}`;
          if (pattern.length === 4) codes.add(pattern);
        }
        result.set(path.relative(process.cwd(), full), codes);
      }
    }
  };
  walk(path.join(process.cwd(), 'src'));
  return result;
}

/** Every quoted identifier in the engine's code (class and block names its readers switch on). */
function quotedNames(): Set<string> {
  const names = new Set<string>();
  const walk = (folder: string): void => {
    for (const name of readdirSync(folder)) {
      const full = path.join(folder, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) {
        const text = readFileSync(full, 'utf8');
        for (const match of text.matchAll(/['"`]([A-Za-z_][A-Za-z0-9_]*)['"`]/g)) {
          names.add(match[1] ?? '');
        }
      }
    }
  };
  walk(path.join(process.cwd(), 'src'));
  return names;
}

/** Placed references share their subrecords (xEdit's common reference definitions). */
const REFERENCE_TYPES = ['REFR', 'ACHR', 'PGRE', 'PHZD', 'PMIS', 'PARW', 'PBAR', 'PBEA', 'PCON'];
/**
 * Subrecords xEdit defines once for many record types (model, destruction, keywords, scripts,
 * conditions, names), which our code reads with shared helpers that name no record type.
 */
const SHARED_SUBRECORDS = new Set([
  'EDID',
  'OBND',
  'FULL',
  'DESC',
  'VMAD',
  'KSIZ',
  'KWDA',
  'MODL',
  'MODT',
  'MODS',
  'MOD2',
  'MO2T',
  'MO2S',
  'MOD3',
  'MO3T',
  'MO3S',
  'MOD4',
  'MO4T',
  'MO4S',
  'MOD5',
  'MO5T',
  'MO5S',
  'DEST',
  'DSTD',
  'DSTF',
  'DMDL',
  'DMDT',
  'DMDS',
  'YNAM',
  'ZNAM',
  'CTDA',
  'CIS1',
  'CIS2',
  'CITC',
  'PRPS',
]);

/**
 * Count subrecords: the number of the repeated entries that follow (KWDA's keywords, CNTO's
 * items, SPLO's spells, LVLO's entries, PRKR's perks); reading the entries reads the count.
 */
const COUNT_SUBRECORDS: Readonly<Record<string, string>> = {
  KSIZ: 'KWDA',
  COCT: 'CNTO',
  SPCT: 'SPLO',
  LLCT: 'LVLO',
  PRKZ: 'PRKR',
  IDLC: 'IDLA',
};
/** Leftovers of earlier Creation Kit versions, marked unused by xEdit (old result scripts). */
const UNUSED = new Set(['SCHR', 'SCDA', 'SCTX', 'SCRO']);

if (run('esm')) {
  // (record type, subrecord) pairs in the data, against the code: a subrecord has a decoder for
  // a record type when one source file names both (a decoder names the types it reads, e.g.
  // `record.type !== 'FLOR'` beside `fields.first('PFIG')`); references share one set; the
  // shared subrecords count where any file reads them. That over-counts codes many types use
  // (DATA, DNAM): "with a decoder" is an upper bound, the open list is certain.
  const pairs = new Map<string, Map<string, number>>();
  const recordCounts = new Map<string, number>();
  for (const entry of vfs.loadOrder) {
    const source = await NodeFileSource.open(resolveDataFile(entry.name));
    const index = await indexPlugin(source);
    await forEachRecord(source, index, (_record, loaded) => {
      const type = loaded.header.type;
      recordCounts.set(type, (recordCounts.get(type) ?? 0) + 1);
      const subrecords = pairs.get(type) ?? new Map<string, number>();
      pairs.set(type, subrecords);
      const seen = new Set<string>();
      for (const field of parseFields(loaded.data)) {
        if (seen.has(field.type)) continue;
        seen.add(field.type);
        subrecords.set(field.type, (subrecords.get(field.type) ?? 0) + 1);
      }
    });
    await source.close();
  }
  const files = codeLiteralsPerFile();
  const readFor = new Map<string, Set<string>>();
  const readAnywhere = new Set<string>();
  for (const codes of files.values()) {
    for (const code of codes) readAnywhere.add(code);
    const types = new Set([...codes].filter((code) => pairs.has(code)));
    if (REFERENCE_TYPES.some((type) => types.has(type))) {
      for (const type of REFERENCE_TYPES) types.add(type);
    }
    for (const type of types) {
      const set = readFor.get(type) ?? new Set<string>();
      for (const code of codes) set.add(code);
      readFor.set(type, set);
    }
  }
  // Three tiers per pair: "read" (a file names both, or a shared subrecord read anywhere),
  // "elsewhere" (the code is read in files that do not name the type, or is built by the reader
  // like WTHR's cloud layers "00TX".."J0TX": to check by hand), "unread" (no code reads it).
  const generated = (code: string): boolean => !/^[A-Z0-9_]{4}$/.test(code);
  const has = (set: ReadonlySet<string>, code: string): boolean =>
    set.has(code) || [0, 1, 2, 3].some((i) => set.has(`${code.slice(0, i)}?${code.slice(i + 1)}`));
  const tiers = { read: 0, elsewhere: 0, unread: 0 };
  const lines: string[] = [];
  for (const [type, subrecords] of [...pairs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const read = readFor.get(type) ?? new Set<string>();
    const elsewhere: [string, number][] = [];
    const unread: [string, number][] = [];
    const isRead = (code: string): boolean =>
      has(read, code) || (SHARED_SUBRECORDS.has(code) && has(readAnywhere, code));
    for (const [code, count] of subrecords) {
      const counted = COUNT_SUBRECORDS[code];
      if (
        isRead(code) ||
        (counted !== undefined && has(readAnywhere, counted)) ||
        UNUSED.has(code)
      ) {
        tiers.read++;
      } else if (has(readAnywhere, code) || generated(code)) {
        tiers.elsewhere++;
        elsewhere.push([code, count]);
      } else {
        tiers.unread++;
        unread.push([code, count]);
      }
    }
    const list = (entries: [string, number][]): string =>
      entries
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => `${code} ${count}`)
        .join(', ');
    const status = unread.length > 0 ? 'open' : elsewhere.length > 0 ? 'check' : 'done';
    lines.push(
      `  ${type} ${String(recordCounts.get(type)).padStart(7)}  ${status.padEnd(5)} ${subrecords.size - elsewhere.length - unread.length}/${subrecords.size}${unread.length > 0 ? `  unread: ${list(unread)}` : ''}${elsewhere.length > 0 ? `  elsewhere: ${list(elsewhere)}` : ''}`,
    );
  }
  console.log(
    `ESM: ${pairs.size} record types, ${tiers.read + tiers.elsewhere + tiers.unread} (record, subrecord) pairs: ${tiers.read} read, ${tiers.elsewhere} read elsewhere (to check), ${tiers.unread} unread`,
  );
  for (const line of lines) console.log(line);
}

if (run('strings')) {
  // Every table of every language in the VFS, every string decoded.
  let tableCount = 0;
  let stringCount = 0;
  const failures: string[] = [];
  for (const file of vfs.list('strings')) {
    const kind = extensionOf(file);
    if (!(STRING_TABLE_KINDS as readonly string[]).includes(kind)) continue;
    try {
      const table = new StringTable(await vfs.read(file), kind as StringTableKind);
      for (const id of table.ids()) table.get(id);
      tableCount++;
      stringCount += table.size;
    } catch (error) {
      failures.push(`${file}: ${message(error)}`);
    }
  }
  console.log(`Strings: ${tableCount} tables, ${stringCount} strings, ${failures.length} failures`);
  for (const failure of failures.slice(0, 20)) console.log(`    ${failure}`);

  // FULL is a string id in every record of a localized plugin: each must resolve.
  for (const entry of vfs.loadOrder) {
    const source = await NodeFileSource.open(resolveDataFile(entry.name));
    const head = parsePluginHeader(await source.read(0, 24));
    if ((head.flags & PluginFlag.localized) === 0) {
      console.log(`  ${entry.name.padEnd(32)} not localized`);
      await source.close();
      continue;
    }
    const tables: StringTable[] = [];
    for (const kind of STRING_TABLE_KINDS) {
      const file = stringTablePath(entry.name, 'english', kind);
      if (vfs.has(file)) tables.push(new StringTable(await vfs.read(file), kind));
    }
    const all = new PluginStrings(tables);
    let names = 0;
    let unresolved = 0;
    const index = await indexPlugin(source);
    await forEachRecord(source, index, (_record, loaded) => {
      for (const field of parseFields(loaded.data)) {
        if (field.type !== 'FULL' || field.data.length !== 4) continue;
        names++;
        const id = new DataView(field.data.buffer, field.data.byteOffset, 4).getUint32(0, true);
        if (all.get(id) === undefined) unresolved++;
      }
    });
    await source.close();
    console.log(
      `  ${entry.name.padEnd(32)} ${tables.length} tables, ${names} FULL ids, ${unresolved} unresolved`,
    );
  }
}

if (run('hkx')) {
  // Every Havok file (packfiles, and the tagfiles Creation Club content ships) by class: a class
  // counts as read when the engine's code names it (behavior.ts, animation.ts and the physics read
  // packfile objects by class name; layouts.ts lays out the classes tagfiles carry; the root
  // container and the animation container's parts are read by position). Every animation
  // container is read and every animation sampled, so a class the readers refuse shows here.
  const named = quotedNames();
  for (const name of [
    'hkRootLevelContainer',
    'hkaAnimationBinding',
    'hkaSkeleton',
    'hkaDefaultAnimatedReferenceFrame',
    'hkaAnnotationTrack',
    'hkbBehaviorGraphStringData',
  ])
    named.add(name);
  const classes = new Map<string, { objects: number; files: number }>();
  const failures: string[] = [];
  const havokFiles = vfs.list('meshes').filter((file) => /\.(hkx|hkt)$/.test(file));
  let animations = 0;
  for (const file of havokFiles) {
    try {
      const pack = Packfile.parse(await vfs.read(file));
      for (const binding of readAnimationContainer(pack).bindings) {
        const { animation } = binding;
        const out = new Float32Array(animation.trackCount * TRANSFORM_FLOATS);
        animation.sample(animation.duration / 2, out, new Float32Array(animation.floatTrackCount));
        animations++;
      }
      const seen = new Set<string>();
      for (const object of pack.objects.values()) {
        const entry = classes.get(object.className) ?? { objects: 0, files: 0 };
        entry.objects++;
        if (!seen.has(object.className)) entry.files++;
        seen.add(object.className);
        classes.set(object.className, entry);
      }
    } catch (error) {
      failures.push(`${file}: ${message(error)}`);
    }
  }
  const open = [...classes].filter(([name]) => !named.has(name));
  console.log(
    `HKX: ${havokFiles.length} files, ${animations} animations sampled, ${failures.length} failures, ${classes.size} classes, ${classes.size - open.length} read, ${open.length} not read`,
  );
  for (const [name, entry] of [...classes].sort((a, b) => b[1].files - a[1].files)) {
    console.log(
      `  ${String(entry.files).padStart(6)} ${String(entry.objects).padStart(8)}  ${named.has(name) ? 'yes ' : '    '} ${HAVOK_LAYOUTS[name] ? 'layout' : '      '} ${name}`,
    );
  }
  for (const failure of failures.slice(0, 20)) console.log(`    ${failure}`);
}

await vfs.close();
