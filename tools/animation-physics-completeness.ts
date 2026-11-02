// The animation and physics areas' completeness sweep (docs/completeness/animation.md,
// physics.md): what the archives' behavior graphs, animations and meshes and the load order's
// records use of animation and physics, each against the engine code that reads it.
//
// Animation: every Havok class of the behavior graphs (characters and projects too) and every
// member the files set; every annotation of every animation by its tag (the engine's handler of
// it); the response files' handlers; the IDLE records' fields and condition functions; the
// actions (AACT); the animation game settings.
// Physics: every collision block type of the meshes and every field the files set; the motion
// systems, qualities, layers and materials the bodies use; the fields of the projectiles (PROJ),
// explosions (EXPL), material types (MATT) and impact data (IPDS, IPCT); the physics game
// settings.
//
// An item is done when the engine reads it: a class the behavior parser maps to a node the
// runtime runs (never to its catch-all 'other'), a member the parser reads (every read of every
// packfile is recorded) whose name the runtime's code names, an annotation tag or event named in
// the engine's code (or answered by a handler the code implements), a record field named outside
// the file that parses it, a block type with a parser whose node the physics names, a setting
// read by a settings reader or named in the code. A name found is a strong hint, not proof (a
// common member name such as `flags` is found anywhere): the mechanics are kept by hand in the
// checklists against docs/animation.md and docs/physics.md. The counts are the objects (blocks,
// annotations, records) that use the item.
//
//   node tools/animation-physics-completeness.ts           the counts and every open item
//   node tools/animation-physics-completeness.ts --all     every item with its status
//   node tools/animation-physics-completeness.ts --area physics   one area only (faster)

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAnimationResponses } from '../src/formats/animdata/responses.ts';
import { parseBehaviorGraph } from '../src/formats/hkx/behavior.ts';
import { HAVOK_LAYOUTS, inlineSize, type InlineType } from '../src/formats/hkx/layouts.ts';
import { observePackfileReads, Packfile } from '../src/formats/hkx/packfile.ts';
import { readAnimationContainer } from '../src/formats/hkx/animation.ts';
import { COLLISION_PARSERS } from '../src/formats/nif/collision-blocks.ts';
import { parseNifHeader } from '../src/formats/nif/header.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { decodeWindows1252 } from '../src/formats/text.ts';
import { parseIdle } from '../src/ai/idle-records.ts';
import { conditionFunctionName } from '../src/scripting/condition-functions.ts';
import { parseCollisionLayer } from '../src/physics/collision-layers.ts';
import { parseImpact, parseImpactDataSet } from '../src/world/impact-records.ts';
import { parseFootstep } from '../src/world/footstep-records.ts';
import { parseMaterialType } from '../src/world/material-type.ts';
import { parseExplosion, parseProjectile } from '../src/world/projectile-data.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { NOT_YET } from './condition-usage.ts';
import { openGameFolder } from './gamedata-path.ts';

const ROOT = path.resolve(import.meta.dirname, '..');

export type Area = 'animation' | 'physics';

export interface CompletenessItem {
  readonly area: Area;
  /** The checklist's section ("Behavior classes", "Collision blocks", ...). */
  readonly part: string;
  readonly name: string;
  /** Objects (blocks, annotations, records) using it. */
  readonly uses: number;
  readonly done: boolean;
  /** Where the engine reads it (a source file), or why it is open. */
  readonly where: string;
}

/** The game setting name patterns of each area (the load order's GMSTs matching them). */
const ANIMATION_SETTINGS = /^[fiub](HeadTrack|AIHeadTrack|Blink|LipMorph|Anim)/;
const PHYSICS_SETTINGS =
  /^[fiub](ExplosionForce|ExplosionSourceRef|ExplosionSplash|ExplosionWater|GameplayImpulse|Jump|ActorSwim|MagicGrab|MagicTelekines|ZKey|PhysicsDamage|WaterKnockdown|MoveWeight|Grenade|Havok|Ragdoll|DeathForce)/;

/** Serialized members that carry no data (format-census.ts NOT_DATA), with the reason. */
const NOT_DATA: ReadonlyMap<string, string> = new Map([
  ['hkbClipGenerator.animationBindingIndex', 'the runtime binds the clip as it activates (-1)'],
  ['BSSynchronizedClipGenerator.sAnimationBindingIndex', "as the clip generator's (-1)"],
]);

/**
 * Collision fields with one value in every mesh, which the physics has nothing to do with (the
 * value censuses "Collision responses", "Time factors", "Deactivator types" show it), by field.
 */
const INERT_FIELDS: ReadonlyMap<string, string> = new Map([
  ['collisionResponse', '1 (simple contact) in every body: contacts are solved, as ours are'],
  ['timeFactor', '1 in every body: each steps with the world'],
  [
    'constraintForceMixing',
    "float epsilon in every chain (bhkBallSocketConstraintChain): no softness, as Rapier's joints have none",
  ],
  [
    'deactivatorType',
    "1 in every body, and bodies come to rest in the original: its world's deactivation runs for all (PhysicsWorld.#deactivate)",
  ],
]);

/** Behavior classes read through the object that points to them, not by their name. */
const READ_BY_PLACE: ReadonlyMap<string, string> = new Map([
  [
    'hkbBehaviorGraphStringData',
    "src/formats/hkx/behavior.ts (the graph's event, variable and property names, through its data)",
  ],
]);

/**
 * Handlers the response files name that the original has no class of: their events do nothing
 * there (tests/conformance/animation/engine-handlers.test.ts keeps them unanswered).
 */
const NO_HANDLER_CLASS: ReadonlyMap<string, string> = new Map([
  ['StopHorseCameraHandler', 'the original has no such handler: its event does nothing'],
  ['RemoveCharacterControllerHandler', 'the original has no such handler: its event does nothing'],
]);

/** Parsed node fields the runtime has no use for, by "kind.field", with the reason. */
const NOT_RUNTIME: ReadonlyMap<string, string> = new Map([
  ['other.name', 'a node of no class the runtime runs'],
]);

interface Source {
  readonly file: string;
  readonly text: string;
}

/** The engine's sources (src/, without the tests), comments left out. */
function readSources(): Source[] {
  const out: Source[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
        out.push({
          file: path.relative(ROOT, full).replaceAll('\\', '/'),
          text: readFileSync(full, 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/^\s*\/\/.*$/gm, ''),
        });
    }
  };
  walk(path.join(ROOT, 'src'));
  return out;
}

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const add = <K>(map: Map<K, number>, key: K, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

/** Whether a parsed value is set (not zero, empty, false or missing). */
function isSet(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === '')
    return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof Map || value instanceof Set) return value.size > 0;
  if (ArrayBuffer.isView(value)) return (value as Uint8Array).length > 0;
  return true;
}

/** Every set leaf of a parsed object as "path.to.leaf" (objects followed `depth` deep). */
function setFields(value: unknown, prefix: string, depth: number, out: Set<string>): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    ArrayBuffer.isView(value)
  )
    return;
  for (const [key, child] of Object.entries(value)) {
    if (key === 'kind' || key === 'type') continue;
    const name = prefix === '' ? key : `${prefix}.${key}`;
    const nested =
      typeof child === 'object' &&
      child !== null &&
      !Array.isArray(child) &&
      !ArrayBuffer.isView(child) &&
      !(child instanceof Map) &&
      !(child instanceof Set);
    if (nested && depth > 0) setFields(child, name, depth - 1, out);
    else if (isSet(child)) out.add(name);
  }
}

export async function animationPhysicsCompleteness(
  vfs: Vfs,
  db: RecordDatabase,
  areas: ReadonlySet<Area>,
): Promise<CompletenessItem[]> {
  const sources = readSources();
  const items: CompletenessItem[] = [];
  const readIn = (pattern: RegExp, within: (file: string) => boolean): string | undefined =>
    sources.find((s) => within(s.file) && pattern.test(s.text))?.file;
  const push = (
    area: Area,
    part: string,
    name: string,
    uses: number,
    where: string | undefined,
    open = 'not read',
  ): void => {
    items.push({ area, part, name, uses, done: where !== undefined, where: where ?? open });
  };
  const everywhere = (): boolean => true;
  /** Every string literal of the engine's code, lower-case. */
  const literals = new Set<string>();
  for (const { text } of sources) {
    for (const match of text.matchAll(/'([^'\n]{1,80})'|"([^"\n]{1,80})"/g))
      literals.add((match[1] ?? match[2] ?? '').toLowerCase());
  }
  /** A record field: done when named outside its parser (and the file formats). */
  const recordFields = (
    area: Area,
    part: string,
    counts: Map<string, number>,
    parser: string,
  ): void => {
    for (const [field, uses] of [...counts].sort((a, b) => b[1] - a[1])) {
      const leaf = field.split('.').pop() ?? field;
      push(
        area,
        part,
        field,
        uses,
        readIn(
          new RegExp(`(\\.|\\{\\s*|,\\s*)${escape(leaf)}\\b`),
          (file) => file !== parser && !file.startsWith('src/formats/'),
        ),
      );
    }
  };
  const settings = (area: Area, pattern: RegExp): Promise<void> =>
    (async () => {
      for (const formId of db.formIdsOfType('GMST')) {
        const record = await db.get(formId);
        const name = record?.editorId;
        if (!record || record.deleted || name === undefined || !pattern.test(name)) continue;
        push(
          area,
          'Game settings (GMST)',
          name,
          1,
          readIn(new RegExp(`\\b${name}\\b`), everywhere),
        );
      }
    })();

  if (areas.has('animation')) {
    // ---- Behavior graphs: classes and members; animations: annotations.
    const runtime = (file: string): boolean =>
      file.startsWith('src/animation/') || file.startsWith('src/shell/');
    const behaviorSource =
      sources.find((s) => s.file === 'src/formats/hkx/behavior.ts')?.text ?? '';
    // The parser's class → node kind (its switch: cases fall through to the kind they return).
    const kindOf = new Map<string, string>();
    {
      let pending: string[] = [];
      for (const line of behaviorSource.split('\n')) {
        const cases = [...line.matchAll(/case '(\w+)':/g)].map((m) => m[1] ?? '');
        if (cases.length > 0) pending.push(...cases);
        const kind = /kind: '([\w-]+)'/.exec(line)?.[1];
        if (kind && pending.length > 0) {
          for (const name of pending) kindOf.set(name, kind);
          pending = [];
        }
        if (/^\s*default:/.test(line)) pending = [];
      }
    }
    const reads = new Map<Packfile, Uint8Array>();
    observePackfileReads((file, offset, size) => {
      let bits = reads.get(file);
      if (!bits || offset + size > bits.length) {
        const grown = new Uint8Array(Math.max(offset + size, (bits?.length ?? 1 << 15) * 2));
        if (bits) grown.set(bits);
        bits = grown;
        reads.set(file, bits);
      }
      bits.fill(1, offset, offset + size);
    });
    const classes = new Map<string, number>();
    const others = new Set<string>();
    /** "kind.field" of the parsed nodes → nodes that set it. */
    const nodeFields = new Map<string, number>();
    const graphEvents = new Set<string>();
    const annotations = new Map<string, number>();
    const annotationTexts = new Map<string, string>();
    const behaviorPacks: Packfile[] = [];
    for (const file of vfs.list('meshes').filter((f) => /\.(hkx|hkt)$/.test(f))) {
      let pack: Packfile;
      try {
        pack = Packfile.parse(await vfs.read(file));
      } catch {
        continue;
      }
      try {
        for (const { animation } of readAnimationContainer(pack).bindings) {
          for (const { text } of animation.annotations) {
            const tag = annotationTag(text);
            add(annotations, tag);
            if (!annotationTexts.has(tag)) annotationTexts.set(tag, text);
          }
        }
      } catch {
        // Not an animation container.
      }
      if (pack.objectsOf('hkbBehaviorGraph').length === 0) {
        reads.delete(pack);
        continue;
      }
      behaviorPacks.push(pack);
      for (const object of pack.objects.values()) add(classes, object.className);
      try {
        const graph = parseBehaviorGraph(pack);
        collectNodes(graph.root, others, nodeFields, new Set());
        for (const event of graph.events) graphEvents.add(event.toLowerCase());
      } catch {
        // Counted by the formats' sweep.
      }
    }
    observePackfileReads(undefined);
    for (const [name, uses] of [...classes].sort((a, b) => b[1] - a[1])) {
      const kind = kindOf.get(name);
      let where: string | undefined;
      let open = 'not read';
      if (others.has(name)) open = "parsed as 'other': the runtime does not run it";
      else if (kind !== undefined) {
        const runner = readIn(new RegExp(`'${escape(kind)}'`), runtime);
        where = runner === undefined ? undefined : `${runner} ('${kind}')`;
        if (!where) open = `parsed as '${kind}', which the runtime never names`;
      } else {
        where = readIn(new RegExp(`'${escape(name)}'`), everywhere) ?? READ_BY_PLACE.get(name);
      }
      push('animation', 'Behavior classes', name, uses, where, open);
    }
    // Members set in the files: read by the parser and named by the runtime.
    const members = new Map<string, [number, number, number]>();
    const visit = (
      pack: Packfile,
      bits: Uint8Array,
      className: string,
      at: number,
      depth: number,
    ): void => {
      if (depth > 8) return;
      for (let name: string | undefined = className; name; name = HAVOK_LAYOUTS[name]?.parent) {
        const layout = HAVOK_LAYOUTS[name];
        if (!layout) break;
        for (const [member, [offset, type, count = 1]] of Object.entries(layout.members)) {
          const start = at + offset;
          const array = type.startsWith('array:');
          const element = array ? type.slice('array:'.length) : type;
          const size = array ? 16 : inlineSize(element as InlineType) * count;
          let wasRead = false;
          for (let i = start; i < start + size && !wasRead; i++) wasRead = bits[i] === 1;
          if (array && !wasRead) {
            const { data, size: length } = pack.array(start);
            const end = data + length * inlineSize(element as InlineType);
            for (let i = data; i < end && !wasRead; i++) wasRead = bits[i] === 1;
          }
          const set = array
            ? pack.array(start).size > 0
            : pack.bytes(start, size).some((byte) => byte !== 0) ||
              pack.pointer(start) !== undefined ||
              pack.object(start) !== undefined;
          const key = `${name}.${member}`;
          const entry = members.get(key) ?? [0, 0, 0];
          if (set) entry[0]++;
          if (wasRead) entry[1]++;
          members.set(key, entry);
          if (element.startsWith('struct:')) {
            const struct = element.slice('struct:'.length);
            if (array) {
              const { data, size: length } = pack.array(start);
              const stride = inlineSize(element as InlineType);
              for (let i = 0; i < length; i++)
                visit(pack, bits, struct, data + i * stride, depth + 1);
            } else {
              visit(pack, bits, struct, start, depth + 1);
            }
          }
        }
      }
    };
    for (const pack of behaviorPacks) {
      const bits = reads.get(pack) ?? new Uint8Array(0);
      for (const object of pack.objects.values())
        visit(pack, bits, object.className, object.offset, 0);
    }
    for (const [key, [set, read]] of [...members].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (set === 0) continue;
      const reason = NOT_DATA.get(key);
      push(
        'animation',
        'Behavior members',
        key,
        set,
        read > 0
          ? 'src/formats/hkx/behavior.ts'
          : reason === undefined
            ? undefined
            : `no data: ${reason}`,
        'not read by the parser',
      );
    }
    // The parsed nodes' fields (the parser's names for the members): named by the runtime.
    for (const [key, uses] of [...nodeFields].sort((a, b) => a[0].localeCompare(b[0]))) {
      const field = key.slice(key.indexOf('.') + 1);
      const reason = NOT_RUNTIME.get(key);
      push(
        'animation',
        'Behavior node fields',
        key,
        uses,
        reason !== undefined
          ? `not run: ${reason}`
          : readIn(new RegExp(`(\\.|\\{\\s*|,\\s*)${escape(field)}\\b`), runtime),
        'parsed, not run',
      );
    }
    // Annotations: the tag, named by the engine or answered by a handler it implements.
    const responses = await Promise.all(
      [
        'meshes\\responses\\actorresponse.txt',
        'meshes\\responses\\playercharacterresponse.txt',
      ].map(async (file) => parseAnimationResponses(decodeWindows1252(await vfs.read(file)))),
    );
    const handled = new Map<string, string>();
    for (const list of responses)
      for (const [event, handler] of list.handlers) handled.set(event, handler);
    const handlerNamed = (handler: string): string | undefined =>
      readIn(new RegExp(`\\b${escape(handler)}\\b`), everywhere);
    // Footsteps answer the tags their records name (FSTP ANAM).
    const footsteps = new Set<string>();
    for (const formId of db.formIdsOfType('FSTP')) {
      const record = await db.get(formId);
      if (record) footsteps.add(parseFootstep(record).tag.toLowerCase());
    }
    for (const [tag, uses] of [...annotations].sort((a, b) => b[1] - a[1])) {
      const handler = handled.get(tag);
      const where = literals.has(tag)
        ? readIn(new RegExp(`['"]${escape(tag)}['"]`, 'i'), everywhere)
        : handler !== undefined && handlerNamed(handler)
          ? `${handlerNamed(handler)} (${handler})`
          : footsteps.has(tag)
            ? "src/shell/actor-sounds.ts (a footstep record's tag)"
            : graphEvents.has(tag)
              ? 'src/animation/behavior-runtime.ts (an event of a graph: raised in it)'
              : undefined;
      push(
        'animation',
        'Annotations',
        tag,
        uses,
        where,
        `not handled (e.g. "${annotationTexts.get(tag) ?? tag}")`,
      );
    }
    for (const [event, handler] of handled) {
      const none = NO_HANDLER_CLASS.get(handler);
      push(
        'animation',
        'Response handlers',
        `${event} : ${handler}`,
        1,
        none === undefined ? handlerNamed(handler) : `none: ${none}`,
      );
    }
    // ---- Idles, actions.
    const idleFields = new Map<string, number>();
    const idleFunctions = new Map<number, number>();
    for (const formId of db.formIdsOfType('IDLE')) {
      const record = await db.get(formId);
      if (!record || record.deleted) continue;
      const idle = parseIdle(record);
      const fields = new Set<string>();
      setFields(idle, '', 0, fields);
      for (const field of fields)
        if (field !== 'formId' && field !== 'editorId') add(idleFields, field);
      for (const condition of idle.conditions) add(idleFunctions, condition.function);
    }
    recordFields('animation', 'Idles (IDLE)', idleFields, 'src/ai/idle-records.ts');
    for (const [fn, uses] of [...idleFunctions].sort((a, b) => b[1] - a[1])) {
      const reason = NOT_YET.get(fn);
      push(
        'animation',
        'Idle conditions',
        conditionFunctionName(fn),
        uses,
        reason === undefined ? 'src/scripting/condition-functions.ts' : undefined,
        reason ?? 'not valued',
      );
    }
    for (const formId of db.formIdsOfType('AACT')) {
      const record = await db.get(formId);
      const name = record?.editorId;
      if (!record || record.deleted || name === undefined) continue;
      push(
        'animation',
        'Actions (AACT)',
        name,
        1,
        readIn(new RegExp(`['"]${escape(name)}['"]`), everywhere),
        'the engine never performs it',
      );
    }
    await settings('animation', ANIMATION_SETTINGS);
  }

  if (areas.has('physics')) {
    // ---- Meshes: collision blocks and their fields, motion systems, qualities, layers.
    const physicsCode = (file: string): boolean =>
      !file.startsWith('src/formats/') &&
      (file.startsWith('src/physics/') ||
        file.startsWith('src/shell/') ||
        file.startsWith('src/world/') ||
        file.startsWith('src/render/'));
    const blockTypes = new Map<string, number>();
    const fields = new Map<string, number>();
    const motions = new Map<number, number>();
    const qualities = new Map<number, number>();
    const layers = new Map<number, number>();
    const kinds = new Map<string, string>();
    const responses = new Map<number, number>();
    const timeFactors = new Map<number, number>();
    const deactivators = new Map<number, number>();
    for (const file of vfs.list('meshes').filter((f) => f.endsWith('.nif'))) {
      const bytes = await vfs.read(file);
      let header;
      try {
        header = parseNifHeader(bytes);
      } catch {
        continue;
      }
      if (!header.blockTypes.some((type) => type.startsWith('bhk') || type.startsWith('hkPacked')))
        continue;
      let nif;
      try {
        nif = parseNif(bytes);
      } catch {
        continue;
      }
      nif.blocks.forEach((block, i) => {
        const type = header.blockTypes[header.blockTypeIndices[i] ?? -1] ?? '';
        if (!type.startsWith('bhk') && !type.startsWith('hkPacked')) return;
        add(blockTypes, type);
        const record = block as unknown as Record<string, unknown>;
        if (typeof record.kind === 'string') kinds.set(type, record.kind);
        const set = new Set<string>();
        setFields(block, '', 1, set);
        for (const field of set) add(fields, `${type}.${field}`);
        if (record.kind === 'rigid-body') {
          add(motions, Number(record.motionSystem));
          add(qualities, Number(record.qualityType));
          add(layers, (record.filter as { layer?: number } | undefined)?.layer ?? 0);
          add(responses, Number(record.collisionResponse));
          add(timeFactors, Number(record.timeFactor));
          add(deactivators, Number(record.deactivatorType));
        }
      });
    }
    for (const [type, uses] of [...blockTypes].sort((a, b) => b[1] - a[1])) {
      const kind = kinds.get(type);
      const parsed = COLLISION_PARSERS.has(type) || kind !== undefined;
      const where =
        !parsed || kind === undefined
          ? undefined
          : readIn(new RegExp(`'${escape(kind)}'|\\b${escape(type)}\\b`), physicsCode);
      push(
        'physics',
        'Collision blocks (NIF)',
        type,
        uses,
        where,
        parsed ? 'parsed, not used' : 'no parser',
      );
    }
    for (const [field, uses] of [...fields].sort((a, b) => a[0].localeCompare(b[0]))) {
      const leaf = field.split('.').pop() ?? field;
      const inert = INERT_FIELDS.get(leaf);
      push(
        'physics',
        'Collision fields (NIF)',
        field,
        uses,
        inert === undefined
          ? readIn(new RegExp(`(\\.|\\{\\s*|,\\s*)${escape(leaf)}\\b`), physicsCode)
          : `inert: ${inert}`,
      );
    }
    // hkpMotion::MotionType (nif.xml hkMotionType): what collision-data.ts motionOf / inertiaOf
    // make of each.
    const MOTIONS: Record<number, string> = {
      1: 'dynamic (box inertia)',
      2: 'sphere inertia',
      3: 'sphere stabilized (sphere inertia)',
      4: 'box inertia',
      5: 'box stabilized (box inertia)',
      6: 'keyframed',
      7: 'fixed',
      8: 'thin box (box inertia)',
      9: 'character',
    };
    for (const [value, uses] of [...motions].sort((a, b) => a[0] - b[0]))
      push(
        'physics',
        'Motion systems',
        `${String(value)} ${MOTIONS[value] ?? 'unknown'}`,
        uses,
        'src/physics/collision-data.ts (motionOf, inertiaOf)',
      );
    // hkpCollidableQualityType: the engine's debris rule (physics-world.ts sweptBody).
    for (const [value, uses] of [...qualities].sort((a, b) => a[0] - b[0]))
      push(
        'physics',
        'Collidable qualities',
        String(value),
        uses,
        'src/physics/physics-world.ts (sweptBody)',
      );
    // hkpResponseModifier's collision response (nif.xml hkResponseType): 1 simple contact (the
    // solver's contacts), 2 reporting, 3 none (no contact solved: it passes through).
    const RESPONSES: Record<number, string | undefined> = {
      1: 'src/physics/physics-world.ts (contacts solved)',
    };
    for (const [value, uses] of [...responses].sort((a, b) => a[0] - b[0]))
      push('physics', 'Collision responses', String(value), uses, RESPONSES[value]);
    for (const [value, uses] of [...timeFactors].sort((a, b) => a[0] - b[0]))
      push(
        'physics',
        'Time factors',
        String(value),
        uses,
        value === 1 ? 'every body steps with the world (1: nothing to apply)' : undefined,
      );
    for (const [value, uses] of [...deactivators].sort((a, b) => a[0] - b[0]))
      push(
        'physics',
        'Deactivator types',
        String(value),
        uses,
        value === 1 ? `inert: ${INERT_FIELDS.get('deactivatorType') ?? ''}` : undefined,
      );
    const collisionLayers = new Set<number>();
    for (const formId of db.formIdsOfType('COLL')) {
      const record = await db.get(formId);
      if (record) collisionLayers.add(parseCollisionLayer(record).index);
    }
    for (const [layer, uses] of [...layers].sort((a, b) => a[0] - b[0]))
      push(
        'physics',
        'Body layers',
        String(layer),
        uses,
        collisionLayers.has(layer)
          ? 'src/physics/collision-layers.ts (the COLL records)'
          : undefined,
        'no COLL record',
      );
    push(
      'physics',
      'Collision layers (COLL)',
      `${String(collisionLayers.size)} layers, their filter matrix`,
      collisionLayers.size,
      'src/physics/collision-layers.ts',
    );
    // ---- Records: projectiles, explosions, material types, impact data.
    const recordSweep = async (
      type: string,
      parse: (record: NonNullable<Awaited<ReturnType<RecordDatabase['get']>>>) => unknown,
      part: string,
      parser: string,
    ): Promise<void> => {
      const counts = new Map<string, number>();
      for (const formId of db.formIdsOfType(type)) {
        const record = await db.get(formId);
        if (!record || record.deleted) continue;
        const set = new Set<string>();
        setFields(parse(record), '', 1, set);
        for (const field of set) if (field !== 'formId' && field !== 'editorId') add(counts, field);
      }
      recordFields('physics', part, counts, parser);
    };
    await recordSweep(
      'PROJ',
      parseProjectile,
      'Projectiles (PROJ)',
      'src/world/projectile-data.ts',
    );
    await recordSweep('EXPL', parseExplosion, 'Explosions (EXPL)', 'src/world/projectile-data.ts');
    await recordSweep(
      'MATT',
      parseMaterialType,
      'Material types (MATT)',
      'src/world/material-type.ts',
    );
    await recordSweep(
      'IPDS',
      parseImpactDataSet,
      'Impact data sets (IPDS)',
      'src/world/impact-records.ts',
    );
    await recordSweep('IPCT', parseImpact, 'Impacts (IPCT)', 'src/world/impact-records.ts');
    await settings('physics', PHYSICS_SETTINGS);
  }
  return items;
}

/**
 * An annotation's tag, lower-case: the text before its first dot ("SoundPlay.WPNSwing"), the
 * paired partner's "2_" left off, without a trailing number argument ("CameraShake 0.5").
 */
export function annotationTag(text: string): string {
  let tag = text.trim().toLowerCase();
  if (tag.startsWith('2_')) tag = tag.slice(2);
  const dot = tag.indexOf('.');
  if (dot > 0) tag = tag.slice(0, dot);
  return tag.split(/\s/)[0] ?? tag;
}

/**
 * Walks a parsed graph: the class names of the nodes the parser left as 'other', and every
 * node's set fields by "kind.field".
 */
function collectNodes(
  node: unknown,
  others: Set<string>,
  fields: Map<string, number>,
  seen: Set<unknown>,
): void {
  if (typeof node !== 'object' || node === null || seen.has(node)) return;
  seen.add(node);
  const record = node as Record<string, unknown>;
  if (record.kind === 'other' && typeof record.className === 'string') others.add(record.className);
  if (typeof record.kind === 'string' && record.kind !== 'other') {
    for (const [key, value] of Object.entries(record))
      if (key !== 'kind' && isSet(value)) add(fields, `${record.kind}.${key}`);
  }
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) for (const each of value) collectNodes(each, others, fields, seen);
    else if (typeof value === 'object') collectNodes(value, others, fields, seen);
  }
}

if (import.meta.main) {
  const all = process.argv.includes('--all');
  const areaArg = process.argv[process.argv.indexOf('--area') + 1];
  const areas = new Set<Area>(
    process.argv.includes('--area') && (areaArg === 'animation' || areaArg === 'physics')
      ? [areaArg]
      : ['animation', 'physics'],
  );
  const vfs = await Vfs.mount(openGameFolder());
  const db = await RecordDatabase.open(vfs);
  const items = await animationPhysicsCompleteness(vfs, db, areas);
  for (const area of areas) {
    const mine = items.filter((item) => item.area === area);
    console.log(`\n== ${area}: ${mine.filter((i) => i.done).length} of ${mine.length} done`);
    const parts = [...new Set(mine.map((item) => item.part))];
    for (const part of parts) {
      const list = mine.filter((item) => item.part === part);
      const open = list.filter((item) => !item.done);
      console.log(`  ${part}: ${list.length - open.length}/${list.length}`);
      for (const item of all ? list : open)
        console.log(`    [${item.done ? 'x' : ' '}] ${item.name} (${item.uses}): ${item.where}`);
    }
  }
  await db.close();
  await vfs.close();
}
