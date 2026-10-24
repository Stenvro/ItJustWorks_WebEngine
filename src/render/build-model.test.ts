import { describe, expect, it } from 'vitest';
import { decodeVertexDesc, VertexAttribute } from '../formats/nif/blocks.ts';
import type { NifHeader } from '../formats/nif/header.ts';
import type { NifFile } from '../formats/nif/nif.ts';
import type {
  BSLightingShaderPropertyBlock,
  BSTriShapeBlock,
  NifBlock,
  NifTransform,
  NiNodeBlock,
} from '../formats/nif/types.ts';
import {
  PALETTE_BONE_FLOATS,
  skinPositions,
  writePosedPalette,
  writeRestPalette,
} from './bone-palette.ts';
import { buildModel } from './model-data.ts';
import { identity, toHalf, transformPoint } from './math.ts';

const IDENTITY: NifTransform = {
  translation: [0, 0, 0],
  rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  scale: 1,
};
/** 90° about Z (row-major, v' = R·v): x → y. */
const TURN: NifTransform = {
  translation: [100, 0, 0],
  rotation: [0, -1, 0, 1, 0, 0, 0, 0, 1],
  scale: 2,
};

function node(children: number[], transform = IDENTITY, name = 'Node'): NiNodeBlock {
  return {
    kind: 'node',
    name,
    extraData: [],
    controller: -1,
    flags: 0,
    transform,
    collision: -1,
    children,
    effects: [],
  };
}

const shader: BSLightingShaderPropertyBlock = {
  kind: 'lighting-shader',
  name: '',
  extraData: [],
  controller: -1,
  shaderType: 0,
  flags1: 0x80000000,
  flags2: 0x1,
  uvOffset: [0, 0],
  uvScale: [1, 1],
  textureSet: -1,
  emissiveColor: [0, 0, 0],
  emissiveMultiple: 1,
  textureClampMode: 3,
  alpha: 1,
  refractionStrength: 0,
  glossiness: 1,
  specularColor: [1, 1, 1],
  specularStrength: 1,
  lightingEffect1: 0,
  lightingEffect2: 0,
};

/** Positions-only vertex data (stride 16: xyz + bitangent X). */
function positions(points: readonly [number, number, number][]): Uint8Array {
  const bytes = new Uint8Array(points.length * 16);
  const view = new DataView(bytes.buffer);
  points.forEach(([x, y, z], i) => {
    view.setFloat32(i * 16, x, true);
    view.setFloat32(i * 16 + 4, y, true);
    view.setFloat32(i * 16 + 8, z, true);
  });
  return bytes;
}

const VERTEX_ONLY = decodeVertexDesc(
  4,
  (VertexAttribute.vertex | VertexAttribute.fullPrecision) << 12,
);

function shape(
  name: string,
  shaderProperty: number,
  vertexData: Uint8Array,
  vertexCount: number,
  skin = -1,
): BSTriShapeBlock {
  return {
    kind: 'tri-shape',
    name,
    extraData: [],
    controller: -1,
    flags: 0,
    transform: IDENTITY,
    collision: -1,
    boundCenter: [0, 0, 0],
    boundRadius: 1,
    skin,
    shaderProperty,
    alphaProperty: -1,
    vertexDesc: VERTEX_ONLY,
    vertexCount,
    triangleCount: 1,
    vertexData,
    triangles: Uint16Array.of(0, 1, 2),
  };
}

function file(blocks: NifBlock[]): NifFile {
  return {
    header: {} as NifHeader,
    blocks,
    blockTypes: blocks.map((b) => b.kind),
    roots: [0],
    problems: [],
  };
}

const TRIANGLE: [number, number, number][] = [
  [0, 0, 0],
  [10, 0, 0],
  [0, 10, 0],
];

describe('buildModel', () => {
  it("ignores the root node's own transform, like the engine", () => {
    const model = buildModel(
      file([
        node([1], TURN, 'Root'),
        node([2], TURN, 'Child'),
        shape('Shape', 3, positions(TRIANGLE), 3),
        shader,
      ]),
    );
    const [part] = model.parts;
    // Only the child's transform applies: (10, 0, 0) → 2·(0, 10, 0) + (100, 0, 0).
    expect(part && transformPoint(part.world, [10, 0, 0]).map(Math.round)).toEqual([100, 20, 0]);
  });

  it('culls the EditorMarker objects of a model flagged so, and keeps the rest drawn', () => {
    // BSXFlags with Editor Marker (0x20), as fxcobwebwall01 has: a cobweb and its marker.
    const bsx = { kind: 'integer-extra-data', name: 'BSX', value: 0x220 } as const;
    const root = { ...node([1, 2, 3]), extraData: [4] };
    const flagged = buildModel(
      file([
        root,
        shape('Cylinder01', 5, positions(TRIANGLE), 3),
        shape('EditorMarker', 5, positions(TRIANGLE), 3),
        shape('EditorMarker:1', 5, positions(TRIANGLE), 3),
        bsx,
        shader,
      ]),
    );
    expect(flagged.parts.map((p) => p.name)).toEqual(['Cylinder01']);
    expect(flagged.editorMarker).toBe(false);
    // Only a marker (an xmarker): nothing drawn, an editor marker.
    const marker = buildModel(
      file([
        { ...node([1]), extraData: [2] },
        shape('EditorMarker', 3, positions(TRIANGLE), 3),
        bsx,
        shader,
      ]),
    );
    expect(marker.parts).toEqual([]);
    expect(marker.editorMarker).toBe(true);
  });

  it('draws nothing for shapes without a shader', () => {
    const model = buildModel(
      file([
        node([1, 2]),
        shape('CurrentPlane:0', -1, positions(TRIANGLE), 3),
        shape('Visible', 3, positions(TRIANGLE), 3),
        shader,
      ]),
    );
    expect(model.parts.map((p) => p.name)).toEqual(['Visible']);
  });

  it("leaves hidden shapes out but keeps a weapon's hidden blood shapes, marked", () => {
    const hidden = (name: string, shaderRef: number): BSTriShapeBlock => ({
      ...shape(name, shaderRef, positions(TRIANGLE), 3),
      flags: 0x1,
    });
    // SLSF1 Decal and Dynamic_Decal, as the blood shapes' shaders have them.
    const bloodShader = { ...shader, flags1: 0x8c000000 };
    const model = buildModel(
      file([
        node([1, 2, 3]),
        shape('Blade', 4, positions(TRIANGLE), 3),
        hidden('Hidden', 4),
        hidden('BloodLighting', 5),
        shader,
        bloodShader,
      ]),
    );
    expect(model.parts.map((p) => [p.name, p.weaponBlood === true])).toEqual([
      ['Blade', false],
      ['BloodLighting', true],
    ]);
  });

  it('keeps skinned shapes with their bones; the rest palette places them', () => {
    // Vertex: position (16 bytes) + skinning (4 half weights, 4 bone indices) = 28 bytes.
    const desc = decodeVertexDesc(
      7 | (4 << 28),
      (VertexAttribute.vertex | VertexAttribute.fullPrecision | VertexAttribute.skinned) << 12,
    );
    const data = new Uint8Array(3 * 28);
    const view = new DataView(data.buffer);
    TRIANGLE.forEach(([x, y, z], i) => {
      view.setFloat32(i * 28, x, true);
      view.setFloat32(i * 28 + 4, y, true);
      view.setFloat32(i * 28 + 8, z, true);
      // Vertex 0 follows bone 1 only; the others half bone 0, half bone 1.
      const weights = i === 0 ? [0, 1] : [0.5, 0.5];
      view.setUint16(i * 28 + 16, toHalf(weights[0] ?? 0), true);
      view.setUint16(i * 28 + 18, toHalf(weights[1] ?? 0), true);
      view.setUint8(i * 28 + 24, 0);
      view.setUint8(i * 28 + 25, 1);
    });
    const boneAt = (x: number): NifTransform => ({ ...IDENTITY, translation: [x, 0, 0] });
    const blocks: NifBlock[] = [
      node([1, 2, 3], IDENTITY, 'Root'),
      node([], boneAt(50), 'Bone0'),
      node([], boneAt(70), 'Bone1'),
      { ...shape('Skinned', 4, new Uint8Array(0), 0, 5), vertexDesc: desc },
      shader,
      { kind: 'skin-instance', data: 6, partition: 7, skeletonRoot: 0, bones: [1, 2] },
      {
        kind: 'skin-data',
        skinTransform: IDENTITY,
        // Bind pose: skin space → bone space undoes the bones' placement.
        bones: [
          { transform: boneAt(-50), boundCenter: [0, 0, 0], boundRadius: 1 },
          { transform: boneAt(-60), boundCenter: [0, 0, 0], boundRadius: 1 },
        ],
      },
      {
        kind: 'skin-partition',
        vertexDesc: desc,
        vertexCount: 3,
        vertexData: data,
        partitions: [
          {
            vertexCount: 3,
            bones: Uint16Array.of(0, 1),
            vertexMap: undefined,
            triangles: Uint16Array.of(0, 1, 2),
          },
        ],
      },
    ];
    const [part] = buildModel(file(blocks)).parts;
    const skin = part?.skin;
    if (!part || !skin) throw new Error('no skinned part');
    // The vertices stay as stored (the GPU skins them), the part sits at the instance.
    expect(part.vertices).toBe(data);
    expect(part.layout.skinning).toBe(16);
    expect(Array.from(part.world)).toEqual(Array.from(identity()));
    expect(skin.names).toEqual(['Bone0', 'Bone1']);
    expect(Array.from(skin.bones)).toEqual([1, 2]);
    const palette = new Float32Array(2 * PALETTE_BONE_FLOATS);
    writeRestPalette(skin, palette);
    const positions = skinPositions(part.vertices, 28, 16, 3, palette);
    // Bone 1 is 10 units past its bind position; bone 0 is at it.
    expect([positions[0], positions[3], positions[6]]).toEqual([10, 15, 5]);
    expect(Array.from(part.indices)).toEqual([0, 1, 2]);
    // Bounds of the rest pose.
    expect(part.center[0]).toBeCloseTo(10);
    // A pose: bone 1 moved 20 more units.
    const moved = Float32Array.from(identity());
    moved[12] = 90;
    writePosedPalette(skin, (i) => (i === 1 ? moved : undefined), palette);
    const posed = skinPositions(part.vertices, 28, 16, 3, palette);
    expect([posed[0], posed[3], posed[6]]).toEqual([30, 25, 15]);
  });
});
