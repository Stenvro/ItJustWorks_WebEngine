import { describe, expect, it } from 'vitest';
import { readAnimationContainer } from './animation.ts';
import { projectCharacterFile } from './behavior.ts';
import { packfileFromTagfile } from './packfile-image.ts';
import { Packfile } from './packfile.ts';
import { parseTagfile, type TagObject } from './tagfile.ts';

// Member types: basic type | 0x10 (array) | 0x20 (tuple).
const VOID = 0;
const BYTE = 1;
const INT = 2;
const VEC4 = 4;
const VEC12 = 6;
const OBJECT = 8;
const STRUCT = 9;
const CSTRING = 10;
const ARRAY = 0x10;

type Member = readonly [name: string, type: number, className?: string];

/** Writes a tagfile stream: variable-length integers, strings, floats and tags. */
class TagWriter {
  readonly bytes: number[] = [0x1e, 0x0d, 0xb0, 0xca, 0xce, 0xfa, 0x11, 0xd0];

  int(value: number): this {
    let rest = Math.abs(value);
    let byte = ((rest & 0x3f) << 1) | (value < 0 ? 1 : 0);
    rest = Math.floor(rest / 64);
    for (;;) {
      this.bytes.push(rest > 0 ? byte | 0x80 : byte);
      if (rest === 0) return this;
      byte = rest & 0x7f;
      rest = Math.floor(rest / 128);
    }
  }

  string(text: string): this {
    this.int(text.length);
    for (const char of text) this.bytes.push(char.charCodeAt(0));
    return this;
  }

  floats(...values: number[]): this {
    const view = new DataView(new ArrayBuffer(4));
    for (const value of values) {
      view.setFloat32(0, value, true);
      this.bytes.push(...new Uint8Array(view.buffer));
    }
    return this;
  }

  raw(...bytes: number[]): this {
    this.bytes.push(...bytes);
    return this;
  }

  /** A class definition (tag 2). */
  type(name: string, parent: number, members: readonly Member[]): this {
    this.int(2).string(name).int(0).int(parent).int(members.length);
    for (const [member, type, className] of members) {
      this.string(member).int(type);
      if ((type & 0x0f) === OBJECT || (type & 0x0f) === STRUCT) this.string(className ?? '');
    }
    return this;
  }

  done(): Uint8Array {
    return Uint8Array.from(this.bytes);
  }
}

// Class indices as the definitions below number them.
const BASE = 1;
const REFERENCED = 2;
const ROOT = 4;

function bases(file: TagWriter): TagWriter {
  return file
    .type('hkBaseObject', 0, [])
    .type('hkReferencedObject', BASE, [
      ['memSizeAndFlags', VOID],
      ['referenceCount', VOID],
    ])
    .type('hkRootLevelContainerNamedVariant', 0, [
      ['name', CSTRING],
      ['className', CSTRING],
      ['variant', OBJECT, 'hkReferencedObject'],
    ])
    .type('hkRootLevelContainer', 0, [
      ['namedVariants', STRUCT | ARRAY, 'hkRootLevelContainerNamedVariant'],
    ]);
}

function skeletonTypes(file: TagWriter): TagWriter {
  return file
    .type('hkaBone', 0, [
      ['name', CSTRING],
      ['lockTranslation', BYTE],
    ])
    .type('hkaSkeleton', REFERENCED, [
      ['name', CSTRING],
      ['parentIndices', INT | ARRAY],
      ['bones', STRUCT | ARRAY, 'hkaBone'],
      ['referencePose', VEC12 | ARRAY],
    ])
    .type('hkaAnimationContainer', REFERENCED, [['skeletons', OBJECT | ARRAY, 'hkaSkeleton']]);
}
const SKELETON = 6;
const CONTAINER = 7;

/** A skeleton's members after its class: Root and Child, the child 10 units up. */
function skeletonBody(file: TagWriter, intWidth: boolean): TagWriter {
  file.raw(0b111100).string('Root');
  file.int(2);
  if (intWidth) file.int(2);
  file.int(-1).int(0);
  file.int(2).raw(0b01).string('Root').string('Child');
  file.int(2);
  file.floats(0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0);
  file.floats(0, 0, 10, 0, 0, 0, 0, 1, 1, 1, 1, 0);
  return file;
}

describe('Havok binary tagfiles', () => {
  it('reads classes, numbered objects and struct arrays (version 3)', () => {
    const file = bases(new TagWriter().int(1).int(3))
      .type('hkbProjectStringData', REFERENCED, [
        ['characterFilenames', CSTRING | ARRAY],
        ['fullPathToSource', CSTRING],
      ])
      .type('hkbProjectData', REFERENCED, [
        ['worldUpWS', VEC4],
        ['stringData', OBJECT, 'hkbProjectStringData'],
        ['defaultEventMode', INT],
      ]);
    // Object 1: the root, one variant naming object 2.
    file.int(4).int(ROOT).raw(1).int(1).raw(0b111);
    file.string('hkbProjectData').string('hkbProjectData').int(2);
    // Object 2: hkbProjectData (worldUpWS, stringData, defaultEventMode), object 3 its strings.
    file.int(4).int(6).raw(0b11100).floats(0, 0, 1, 0).int(3).int(2);
    file.int(4).int(5).raw(0b1100).int(1).string('Characters\\Character.hkt').int(0);
    const bytes = file.int(7).done();

    const tagfile = parseTagfile(bytes);
    expect(tagfile.version).toBe(3);
    const variants = tagfile.root?.fields.get('namedVariants') as readonly TagObject[];
    const project = variants[0]?.fields.get('variant') as TagObject;
    expect(project.classes).toEqual(['hkbProjectData', 'hkReferencedObject', 'hkBaseObject']);
    expect(project.fields.get('defaultEventMode')).toBe(2);
    // The full path was the empty string: a known one, index 0.
    const strings = project.fields.get('stringData') as TagObject;
    expect(strings.fields.get('fullPathToSource')).toBe('');

    // As a packfile, the readers take it.
    const pack = Packfile.parse(bytes);
    expect(projectCharacterFile(pack)).toBe('Characters\\Character.hkt');
    const data = pack.objectsOf('hkbProjectData')[0];
    expect(data && pack.f32(data.offset + 24)).toBe(1);
    expect(data && pack.i8(data.offset + 40)).toBe(2);
  });

  it('reads integer arrays with their width and vector arrays (version 3)', () => {
    const file = skeletonTypes(bases(new TagWriter().int(1).int(3)));
    file.int(4).int(ROOT).raw(1).int(1).raw(0b111);
    file.string('Merged Animation Container').string('hkaAnimationContainer').int(2);
    file.int(4).int(CONTAINER).raw(0b100).int(1).int(3);
    skeletonBody(file.int(4).int(SKELETON), true);
    const { skeletons } = readAnimationContainer(Packfile.parse(file.int(7).done()));
    const skeleton = skeletons[0];
    expect(skeleton?.name).toBe('Root');
    expect(skeleton?.bones.map((bone) => bone.name)).toEqual(['Root', 'Child']);
    expect(Array.from(skeleton?.parents ?? [])).toEqual([-1, 0]);
    // Translation xyz, rotation xyzw, scale xyz per bone.
    expect(Array.from(skeleton?.referencePose.subarray(10, 20) ?? [])).toEqual([
      0, 0, 10, 0, 0, 0, 1, 1, 1, 1,
    ]);
  });

  it('reads objects in place, references to them and files without an end tag (version 0)', () => {
    const file = skeletonTypes(bases(new TagWriter().int(1).int(0)));
    // The root in place (tag 3); two variants: a remembered container (tag 4, number 0), then a
    // reference to it (tag 5).
    file.int(3).int(ROOT).raw(1).int(2).raw(0b111);
    file.string('A').string('B').string('hkaAnimationContainer').string('hkaAnimationContainer');
    file.int(4).int(CONTAINER).raw(0b100).int(1);
    skeletonBody(file.int(3).int(SKELETON), false);
    file.int(5).int(0);
    const tagfile = parseTagfile(file.done());
    const variants = tagfile.root?.fields.get('namedVariants') as readonly TagObject[];
    expect(variants[1]?.fields.get('variant')).toBe(variants[0]?.fields.get('variant'));
    const { skeletons } = readAnimationContainer(Packfile.parse(file.done()));
    expect(Array.from(skeletons[0]?.parents ?? [])).toEqual([-1, 0]);
  });

  it('reports members without a known layout instead of placing them', () => {
    const file = bases(new TagWriter().int(1).int(3)).type('hkbMadeUpModifier', REFERENCED, [
      ['strength', INT],
    ]);
    file.int(4).int(ROOT).raw(1).int(1).raw(0b100).int(2);
    file.int(4).int(5).raw(0b100).int(7);
    const image = packfileFromTagfile(parseTagfile(file.int(7).done()));
    expect(image.skipped).toEqual(['hkbMadeUpModifier.strength']);
    expect(Packfile.parse(image.bytes).objectsOf('hkbMadeUpModifier')).toHaveLength(1);
  });

  it('rejects broken streams', () => {
    expect(() => parseTagfile(new Uint8Array(8))).toThrow('Not a Havok tagfile');
    expect(() => parseTagfile(new TagWriter().int(1).int(9).done())).toThrow('version');
    expect(() => parseTagfile(new TagWriter().int(1).int(3).int(4).done())).toThrow('cut off');
  });
});
