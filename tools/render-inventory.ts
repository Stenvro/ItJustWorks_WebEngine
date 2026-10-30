// The rendering inventory (docs/completeness/rendering.md): sweeps every model of the load order
// and the rendering records of every plugin, counts each shader type, shader flag, texture slot,
// blend mode, controller and particle block the data uses, and each subrecord of the rendering
// records, and marks every one handled or open by the status tables below.
//
//   node tools/render-inventory.ts             the sweep's counts with their status
//   node tools/render-inventory.ts --markdown  the same as the checklist's tables
//   node tools/render-inventory.ts --open      only what is used and not done
//
// The status tables are kept by hand against the shaders (src/render/shaders) and the record
// readers (src/world): an item is "done" only when every use in the data is drawn as the
// original draws it. A used item without a status counts as open.

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseNifHeader } from '../src/formats/nif/header.ts';
import { parseNif } from '../src/formats/nif/nif.ts';
import { geometryOrder } from '../src/render/actor-model.ts';
import { lightingSlots } from '../src/render/material-slots.ts';
import { alternateTextures } from '../src/world/actor-records.ts';
import { baseModelPath } from '../src/world/cell-records.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values } = parseArgs({
  options: {
    markdown: { type: 'boolean', default: false },
    open: { type: 'boolean', default: false },
  },
});

type Status = 'done' | 'open' | 'n/a';
/** [name, status, where it lives or why it is open]. */
type Entry = readonly [string, Status, string];

// --- Status tables --------------------------------------------------------------------------

/** BSLightingShaderType (nif.xml), by value. */
const SHADER_TYPES: Record<number, Entry> = {
  0: ['Default', 'done', 'lighting.wgsl'],
  1: ['Environment Map', 'done', 'lighting.wgsl: cube map × mask × scale × diffuse light'],
  2: ['Glow Shader', 'done', 'lighting.wgsl: emit × glow map (SLSF2 Glow_Map)'],
  3: ['Parallax', 'done', 'lighting.wgsl: height map offset (the vanilla model-space bug kept)'],
  4: ['Face Tint', 'done', 'lighting.wgsl: FaceGen detail and tint maps, character light'],
  5: ['Skin Tint', 'done', 'lighting.wgsl: skin tint colour (FaceGen RGB tint)'],
  6: ['Hair Tint', 'done', 'lighting.wgsl: tint by vertex green, anisotropic'],
  7: ['Parallax Occ', 'open', 'parallax occlusion (height-map ray march) not built'],
  8: ['Multitexture Landscape', 'done', 'terrain.wgsl (LAND, not meshes)'],
  9: ['LOD Landscape', 'done', 'lighting.wgsl: model-space normals, LOD land'],
  10: ['Snow', 'done', 'snow.wgsl'],
  11: ['MultiLayer Parallax', 'done', 'lighting.wgsl: inner layer, slot 6'],
  12: ['Tree Anim', 'done', 'common.wgsl leafShift'],
  13: ['LOD Objects', 'done', 'scene-renderer LOD materials'],
  14: [
    'Sparkle Snow',
    'done',
    'lighting.wgsl sparkle technique (every use carries Snow, whose variant has no sparkles)',
  ],
  15: ['LOD Objects HD', 'done', 'scene-renderer LOD materials'],
  16: ['Eye Envmap', 'done', 'lighting.wgsl, common.wgsl eyeNormal: the reflection centres'],
  17: ['Cloud', 'n/a', 'cloud LOD shapes (sky.ts draws clouds)'],
  18: ['LOD Landscape Noise', 'done', 'lighting.wgsl: noise.dds'],
  19: ['Multitexture Landscape LOD Blend', 'done', 'terrain.wgsl'],
};

/** SkyrimShaderPropertyFlags1 (nif.xml) on BSLightingShaderProperty, by bit. */
const LIGHTING_SLSF1: Record<number, Entry> = {
  0: ['Specular', 'done', 'lighting.wgsl'],
  1: ['Skinned', 'done', 'skinning.ts (the skin instance decides)'],
  2: ['Temp_Refraction', 'open', 'unread'],
  3: ['Vertex_Alpha', 'done', 'lighting.wgsl'],
  4: ['Greyscale_To_PaletteColor', 'open', 'effect-shader only in our shaders'],
  5: ['Greyscale_To_PaletteAlpha', 'open', 'effect-shader only in our shaders'],
  6: ['Use_Falloff', 'open', 'effect-shader only in our shaders'],
  7: ['Environment_Mapping', 'done', 'lighting.wgsl'],
  8: ['Receive_Shadows', 'done', 'lighting.wgsl'],
  9: ['Cast_Shadows', 'done', 'scene-renderer shadow casters'],
  10: ['Facegen_Detail_Map', 'done', 'lighting.wgsl FaceGen detail map'],
  11: ['Parallax', 'done', 'with shader type 3'],
  12: ['Model_Space_Normals', 'done', 'lighting.wgsl'],
  13: ['Non_Projective_Shadows', 'open', 'unread'],
  14: ['Landscape', 'done', 'terrain.wgsl'],
  15: ['Refraction', 'done', 'refraction.ts'],
  16: [
    'Fire_Refraction',
    'done',
    'refraction.wgsl: its falloff variant, the strength × normal · direction to the viewer',
  ],
  17: ['Eye_Environment_Mapping', 'done', 'lighting.wgsl'],
  18: ['Hair_Soft_Lighting', 'done', 'lighting.wgsl: picks the hair technique (the hair tint)'],
  19: [
    'Screendoor_Alpha_Fade',
    'done',
    'lighting.wgsl blendedFade: blended while fading, no shadow mask',
  ],
  20: ['Localmap_Hide_Secret', 'open', 'unread by the local map'],
  21: ['FaceGen_RGB_Tint', 'done', 'lighting.wgsl skin tint'],
  22: ['Own_Emit', 'done', 'lighting.wgsl'],
  23: ['Projected_UV', 'done', 'directional materials (material-object.ts)'],
  24: ['Multiple_Textures', 'open', 'unread'],
  25: ['Remappable_Textures', 'n/a', 'the lighting technique never reads it'],
  26: ['Decal', 'done', 'depth bias, decal pipelines'],
  27: ['Dynamic_Decal', 'done', 'weapon blood, decal pipelines'],
  28: ['Parallax_Occlusion', 'open', 'with shader type 7'],
  29: ['External_Emittance', 'done', 'XEMI on references'],
  30: ['Soft_Effect', 'open', 'effect-shader only in our shaders'],
  31: ['ZBuffer_Test', 'done', 'pipeline depth test'],
};

/** SkyrimShaderPropertyFlags2 (nif.xml) on BSLightingShaderProperty, by bit. */
const LIGHTING_SLSF2: Record<number, Entry> = {
  0: ['ZBuffer_Write', 'done', 'pipeline depth write'],
  1: ['LOD_Landscape', 'done', 'LOD materials'],
  2: ['LOD_Objects', 'done', 'LOD materials'],
  3: ['No_Fade', 'done', 'lighting.wgsl, refraction.wgsl: no decal or refraction distance fade'],
  4: ['Double_Sided', 'done', 'cull mode'],
  5: ['Vertex_Colors', 'done', 'lighting.wgsl'],
  6: ['Glow_Map', 'done', 'lighting.wgsl'],
  7: ['Assume_Shadowmask', 'done', 'lighting.wgsl: shadows on blended shapes'],
  8: ['Packed_Tangent', 'done', 'vertex format (the vertex descriptor decides)'],
  9: ['Multi_Index_Snow', 'open', 'unread (the snow pass is by the STAT flag)'],
  10: ['Vertex_Lighting', 'open', 'unread'],
  11: ['Uniform_Scale', 'open', 'unread'],
  12: ['Fit_Slope', 'open', 'unread'],
  13: ['Billboard', 'open', 'unread on lighting shapes'],
  14: ['No_LOD_Land_Blend', 'open', 'unread'],
  15: ['EnvMap_Light_Fade', 'n/a', 'the lighting technique never reads it'],
  16: ['Wireframe', 'open', 'unread'],
  17: ['Weapon_Blood', 'done', 'effect.wgsl blood technique'],
  18: ['Hide_On_Local_Map', 'open', 'unread by the local map'],
  19: ['Premult_Alpha', 'open', 'unread'],
  20: ['Cloud_LOD', 'open', 'unread'],
  21: ['Anisotropic_Lighting', 'done', 'lighting.wgsl'],
  22: ['No_Transparency_Multisampling', 'open', 'unread'],
  23: ['Unused01', 'n/a', ''],
  24: ['Multi_Layer_Parallax', 'done', 'with shader type 11'],
  25: ['Soft_Lighting', 'done', 'lighting.wgsl'],
  26: ['Rim_Lighting', 'done', 'lighting.wgsl'],
  27: ['Back_Lighting', 'done', 'lighting.wgsl'],
  28: ['Snow (Unused02 in nif.xml)', 'done', 'snow.wgsl'],
  29: ['Tree_Anim', 'done', 'common.wgsl leafShift'],
  30: ['Effect_Lighting', 'open', 'effect-shader only in our shaders'],
  31: ['HD_LOD_Objects', 'done', 'LOD materials'],
};

/** SLSF1 on BSEffectShaderProperty. Unlisted bits fall back to the lighting entry's name. */
const EFFECT_SLSF1: Record<number, Entry> = {
  0: ['Specular', 'open', 'no specular in the effect shader'],
  1: ['Skinned', 'done', 'skinning.ts'],
  3: ['Vertex_Alpha', 'done', 'effect.wgsl'],
  4: ['Greyscale_To_PaletteColor', 'done', 'effect.wgsl'],
  5: ['Greyscale_To_PaletteAlpha', 'done', 'effect.wgsl'],
  6: ['Use_Falloff', 'done', 'effect.wgsl'],
  7: ['Environment_Mapping', 'open', 'effect.wgsl has no environment map'],
  8: ['Receive_Shadows', 'open', 'effects take no shadows'],
  9: ['Cast_Shadows', 'open', 'effects cast no shadows'],
  15: ['Refraction', 'done', 'refraction.ts'],
  22: ['Own_Emit', 'n/a', "neither the effect's technique nor its pass reads it"],
  26: ['Decal', 'done', 'decal pipelines'],
  27: ['Dynamic_Decal', 'done', 'decal pipelines'],
  29: ['External_Emittance', 'done', 'XEMI'],
  30: ['Soft_Effect', 'done', 'effect.wgsl'],
  31: ['ZBuffer_Test', 'done', 'pipeline depth test'],
};

/** SLSF2 on BSEffectShaderProperty. */
const EFFECT_SLSF2: Record<number, Entry> = {
  0: ['ZBuffer_Write', 'done', 'pipeline depth write'],
  3: [
    'No_Fade',
    'n/a',
    "the effect's pass has no shader distance fade for it to spare (the lighting shader's has)",
  ],
  4: ['Double_Sided', 'done', 'cull mode'],
  5: ['Vertex_Colors', 'done', 'effect.wgsl'],
  17: ['Weapon_Blood', 'done', 'effect.wgsl'],
  30: ['Effect_Lighting', 'done', 'effect.wgsl'],
};

/** BSShaderTextureSet slots by shader type (nif.xml, the lighting shader's samplers). */
const SLOT_NAMES = [
  'diffuse',
  'normal',
  'glow / skin / rim-soft',
  'height / detail',
  'environment',
  'environment mask',
  'inner layer / tint',
  'specular / back light',
  'unused 8',
];

/** BSEffectShaderProperty textures. */
const EFFECT_TEXTURES: Record<string, Entry> = {
  source: ['source texture', 'done', 'effect.wgsl'],
  greyscale: ['greyscale palette', 'done', 'effect.wgsl'],
};

/** Block types that draw or animate what is drawn, by name. Unlisted used types are open. */
const BLOCKS: Record<string, readonly [Status, string]> = {
  // Shapes and shaders.
  BSTriShape: ['done', 'build-model'],
  BSSubIndexTriShape: ['done', 'build-model'],
  BSDynamicTriShape: ['done', 'face-morphs'],
  BSMeshLODTriShape: ['done', 'build-model'],
  BSLODTriShape: ['done', 'build-model'],
  NiTriShape: ['done', 'build-model'],
  NiTriShapeData: ['done', 'build-model'],
  BSLightingShaderProperty: ['done', 'lighting.wgsl'],
  BSEffectShaderProperty: ['done', 'effect.wgsl (environment map open)'],
  BSSkyShaderProperty: ['done', 'sky.ts'],
  BSWaterShaderProperty: ['done', 'water.wgsl'],
  BSShaderTextureSet: ['done', ''],
  NiAlphaProperty: ['done', 'blend and test pipelines'],
  NiSkinInstance: ['done', 'skinning.ts'],
  BSDismemberSkinInstance: ['done', 'skinning.ts'],
  NiSkinData: ['done', ''],
  NiSkinPartition: ['done', ''],
  // Particles.
  NiParticleSystem: ['done', 'particle-sim.ts'],
  BSStripParticleSystem: ['done', 'particle-sim.ts strips'],
  NiPSysData: ['done', ''],
  BSStripPSysData: ['done', ''],
  NiPSysAgeDeathModifier: ['done', ''],
  NiPSysBoxEmitter: ['done', ''],
  NiPSysCylinderEmitter: ['done', ''],
  NiPSysSphereEmitter: ['done', ''],
  NiPSysMeshEmitter: ['done', ''],
  NiPSysGravityModifier: ['done', ''],
  NiPSysDragModifier: ['done', ''],
  NiPSysBombModifier: ['done', ''],
  NiPSysRotationModifier: ['done', ''],
  NiPSysColliderManager: ['done', ''],
  NiPSysPlanarCollider: ['done', ''],
  NiPSysSphericalCollider: ['done', ''],
  NiPSysSpawnModifier: ['done', ''],
  NiPSysPositionModifier: ['done', 'implicit: particles move by velocity'],
  NiPSysBoundUpdateModifier: ['done', 'implicit: bounds per frame'],
  BSPSysSimpleColorModifier: ['done', ''],
  BSPSysScaleModifier: ['done', ''],
  BSPSysSubTexModifier: ['done', ''],
  BSPSysRecycleBoundModifier: ['done', ''],
  BSPSysInheritVelocityModifier: ['done', ''],
  BSWindModifier: ['done', ''],
  BSPSysLODModifier: ['done', ''],
  BSPSysStripUpdateModifier: ['done', ''],
  NiPSysEmitterCtlr: ['done', ''],
  BSPSysMultiTargetEmitterCtlr: ['done', ''],
  NiPSysModifierActiveCtlr: ['done', ''],
  NiPSysUpdateCtlr: ['done', 'implicit: systems update each frame'],
  // Controllers and interpolators.
  NiControllerManager: ['done', 'animation.ts'],
  NiControllerSequence: ['done', 'animation.ts'],
  NiMultiTargetTransformController: ['done', 'animation.ts'],
  NiTransformController: ['done', 'animation.ts'],
  NiTransformInterpolator: ['done', ''],
  NiTransformData: ['done', ''],
  NiFloatInterpolator: ['done', ''],
  NiFloatData: ['done', ''],
  NiBlendTransformInterpolator: ['done', ''],
  NiBlendFloatInterpolator: ['done', ''],
  NiBlendPoint3Interpolator: ['done', ''],
  NiBlendBoolInterpolator: ['done', ''],
  NiPoint3Interpolator: ['done', ''],
  NiPosData: ['done', ''],
  NiBoolInterpolator: ['done', ''],
  NiBoolData: ['done', ''],
  NiDefaultAVObjectPalette: ['done', ''],
  NiTextKeyExtraData: ['done', ''],
  NiVisController: ['done', 'animation.ts'],
  NiAlphaController: ['done', 'animation.ts'],
  BSLightingShaderPropertyFloatController: ['done', 'animation.ts shader variables'],
  BSLightingShaderPropertyColorController: ['done', 'animation.ts shader variables'],
  BSEffectShaderPropertyFloatController: ['done', 'animation.ts shader variables'],
  BSEffectShaderPropertyColorController: ['done', 'animation.ts shader variables'],
  BSProceduralLightningController: ['done', 'lightning.ts'],
  // Nodes.
  NiNode: ['done', ''],
  BSFadeNode: ['done', ''],
  BSLeafAnimNode: ['done', 'leaf flutter'],
  BSTreeNode: ['done', 'leaf flutter'],
  BSOrderedNode: ['done', 'draw order of its children'],
  BSMultiBoundNode: ['done', 'culling bounds'],
  NiBillboardNode: ['done', 'billboard.ts'],
  BSBlastNode: ['done', 'explosions'],
  BSDamageStage: ['done', 'destruction stages'],
  BSValueNode: ['done', ''],
  NiSwitchNode: ['done', ''],
  BSRangeNode: ['done', ''],
  BSDebrisNode: ['done', ''],
  BSMasterParticleSystem: ['done', ''],
  NiCamera: ['done', 'cinematic cameras'],
  NiPSysEmitterSpeedCtlr: ['done', 'particle-data.ts'],
  NiPSysGravityStrengthCtlr: ['done', 'particle-data.ts'],
  NiPSysEmitterInitialRadiusCtlr: ['done', 'particle-data.ts'],
  NiPSysEmitterLifeSpanCtlr: ['done', 'particle-data.ts'],
  NiPSysEmitterPlanarAngleCtlr: ['done', 'particle-data.ts'],
  NiPSysEmitterDeclinationCtlr: ['done', 'particle-data.ts'],
  NiPSysInitialRotSpeedCtlr: ['done', 'particle-data.ts'],
  NiBoolTimelineInterpolator: ['done', 'animation.ts (as a bool interpolator)'],
  BSNiAlphaPropertyTestRefController: ['done', 'animation.ts'],
  BSBehaviorGraphExtraData: ['done', 'behavior graphs on objects'],
  BSXFlags: ['done', 'model-data.ts'],
  NiStringExtraData: ['done', 'model-data.ts'],
  BSInvMarker: ['done', 'item-3d-view.ts'],
  BSBound: ['done', 'bounds'],
  BSMultiBound: ['done', 'culling by bounding spheres draws the same image'],
  BSMultiBoundOBB: ['done', 'culling by bounding spheres draws the same image'],
  BSMultiBoundAABB: ['done', 'culling by bounding spheres draws the same image'],
  // Data that draws nothing.
  BSFurnitureMarkerNode: ['n/a', 'furniture markers'],
  NiIntegerExtraData: ['n/a', 'gameplay data'],
  NiBooleanExtraData: ['n/a', 'gameplay data'],
  NiStringsExtraData: ['n/a', 'gameplay data'],
  NiBinaryExtraData: ['n/a', 'gameplay data'],
  NiTriStripsData: ['n/a', 'collision geometry only (bhkNiTriStripsShape)'],
  NiFloatExtraData: [
    'n/a',
    'names Havok float slots (hkVis: a controller per name, skeleton.ts showBySlots); the rest exporter data',
  ],
  NiFloatExtraDataController: [
    'n/a',
    'animates hkVis values; the original shows nodes by the Havok pose, not these',
  ],
  NiPathInterpolator: ['done', 'path-motion.ts (constant velocity, follow, flip)'],
  NiLookAtInterpolator: ['done', 'animation.ts look-at tracks'],
  BSFrustumFOVController: ['done', 'camera-model.ts (the kill cameras)'],
  BSLagBoneController: [
    'done',
    'lag-bone.ts: skeletons, worn models (wearOnRig), placed and held models trail',
  ],
  BSBoneLODExtraData: ['done', 'BehaviorRuntime.setBoneLod: far bones keep their pose'],
  NiBSBoneLODController: [
    'n/a',
    'old exports (centaur, wolf, werewolf); no BSBoneLOD#Bone# names give it levels',
  ],
  NiMeshParticleSystem: ['done', 'mesh parts per particle (meshParticle), particle-sim bodies'],
  NiMeshPSysData: ['done', 'its pool: one copy of the mesh per particle (model-data.ts)'],
  BSDecalPlacementVectorExtraData: [
    'n/a',
    'editor data (0-2 points each); the original loads it, nothing reads it',
  ],
};

// --- Sweep ----------------------------------------------------------------------------------

const vfs = await Vfs.mount(openGameFolder());
const count = <K>(map: Map<K, number>, key: K, by = 1): void => {
  map.set(key, (map.get(key) ?? 0) + by);
};

const blockShapes = new Map<string, number>();
const blockFiles = new Map<string, number>();
const shaderTypes = new Map<number, number>();
const lighting1 = new Map<number, number>();
const lighting2 = new Map<number, number>();
const effect1 = new Map<number, number>();
const effect2 = new Map<number, number>();
const slots = new Map<string, number>();
const effectTextures = new Map<string, number>();
const blendModes = new Map<string, number>();
const controllers = new Map<string, number>();
const skyTypes = new Map<number, number>();
const waterFlags = new Map<number, number>();
let lightingShapes = 0;
let effectShapes = 0;
let models = 0;
let unreadable = 0;

const bits = (map: Map<number, number>, value: number): void => {
  for (let bit = 0; bit < 32; bit++) if ((value >>> bit) & 1) count(map, bit);
};
const BLEND_NAMES = [
  'ONE',
  'ZERO',
  'SRC_COLOR',
  'INV_SRC_COLOR',
  'DEST_COLOR',
  'INV_DEST_COLOR',
  'SRC_ALPHA',
  'INV_SRC_ALPHA',
  'DEST_ALPHA',
  'INV_DEST_ALPHA',
  'SRC_ALPHA_SATURATE',
];
const TEST_NAMES = ['ALWAYS', 'LESS', 'EQUAL', 'LEQUAL', 'GREATER', 'NOTEQUAL', 'GEQUAL', 'NEVER'];

for (const path of vfs.list('meshes')) {
  if (!path.endsWith('.nif')) continue;
  let bytes: Uint8Array;
  try {
    bytes = await vfs.read(path);
    const header = parseNifHeader(bytes);
    const seen = new Set<string>();
    for (const index of header.blockTypeIndices) {
      const type = header.blockTypes[index] ?? '?';
      count(blockShapes, type);
      if (!seen.has(type)) count(blockFiles, type);
      seen.add(type);
    }
    const nif = parseNif(bytes);
    models++;
    for (const block of nif.blocks) {
      switch (block.kind) {
        case 'lighting-shader': {
          lightingShapes++;
          count(shaderTypes, block.shaderType);
          bits(lighting1, block.flags1);
          bits(lighting2, block.flags2);
          // A slot counts as sampled where the type and flags bind it (material-slots.ts).
          const set = nif.blocks[block.textureSet];
          const sampled = new Set(lightingSlots(block.shaderType, block.flags1, block.flags2));
          if (set?.kind === 'texture-set')
            set.textures.forEach((texture, slot) => {
              if (texture === '') return;
              const use = sampled.has(slot) ? 'sampled' : 'unsampled';
              count(slots, `${String(block.shaderType)}:${String(slot)}:${use}`);
            });
          break;
        }
        case 'effect-shader':
          effectShapes++;
          bits(effect1, block.flags1);
          bits(effect2, block.flags2);
          if (block.sourceTexture !== '') count(effectTextures, 'source');
          if (block.greyscaleTexture !== '') count(effectTextures, 'greyscale');
          break;
        case 'alpha': {
          const blend = (block.flags & 1) !== 0;
          const test = (block.flags & 0x200) !== 0;
          const src = BLEND_NAMES[(block.flags >> 1) & 15] ?? '?';
          const dst = BLEND_NAMES[(block.flags >> 5) & 15] ?? '?';
          const fn = TEST_NAMES[(block.flags >> 10) & 7] ?? '?';
          if (blend) count(blendModes, `blend ${src} / ${dst}`);
          if (test) count(blendModes, `test ${fn}`);
          break;
        }
        case 'controller':
          if (block.variable >= 0) count(controllers, `${block.type} ${String(block.variable)}`);
          break;
        case 'sky-shader':
          count(skyTypes, block.skyObjectType);
          break;
        case 'water-shader':
          bits(waterFlags, block.waterFlags);
          break;
        default:
          break;
      }
    }
  } catch {
    unreadable++;
  }
}

// --- Records ----------------------------------------------------------------------------------

/** The rendering records and the readers that parse them (subrecords found there are read). */
const RECORDS: Record<string, readonly string[]> = {
  IMGS: ['src/world/image-space.ts'],
  IMAD: ['src/world/image-space-modifier.ts'],
  WTHR: ['src/world/weather.ts'],
  CLMT: ['src/world/weather.ts'],
  LGTM: ['src/world/cell-records.ts'],
  VOLI: ['src/world/volumetric-lighting.ts'],
  LENS: ['src/world/lens-flare.ts'],
  WATR: ['src/world/water.ts'],
  LIGH: ['src/world/cell-records.ts'],
  EFSH: ['src/world/effect-shader-records.ts'],
  SPGD: ['src/world/precipitation.ts'],
  TXST: ['src/world/decal.ts', 'src/world/land.ts'],
};
/** Subrecords every record has that rendering does not read (editor id, object bounds). */
const RECORD_COMMON = new Set(['EDID', 'OBND']);

const db = await RecordDatabase.open(vfs);
const subrecords = new Map<string, number>();
const recordCounts = new Map<string, number>();
for (const type of Object.keys(RECORDS)) {
  for (const id of db.formIdsOfType(type)) {
    const record = await db.get(id);
    if (!record || record.deleted) continue;
    count(recordCounts, type);
    const seen = new Set<string>();
    for (const field of record.fields.list) {
      if (seen.has(field.type)) continue;
      seen.add(field.type);
      count(subrecords, `${type} ${field.type}`);
    }
  }
}
const sources = new Map<string, string>();
const source = (path: string): string => {
  let text = sources.get(path);
  if (text === undefined) {
    text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    sources.set(path, text);
  }
  return text;
};
/** Subrecords rated by hand: what draws nothing, and what xEdit leaves unknown. */
const SUBRECORD_NOTES: Record<string, readonly [Status, string]> = {
  'CLMT MODT': ['n/a', 'texture hashes'],
  'LIGH MODT': ['n/a', 'texture hashes'],
  'WTHR MODT': ['n/a', 'texture hashes'],
  'LIGH SNAM': ['n/a', 'its sound'],
  'LIGH VMAD': ['n/a', 'scripts'],
  'WATR FULL': ['n/a', 'name'],
  'WATR SNAM': ['n/a', 'its sound'],
  'WATR GNAM': ['n/a', 'empty in every vanilla water'],
  'WATR NAM5': [
    'open',
    "flow normals noise texture (RiverFlow.dds): sampled on the flow map's staggered grid by per-geometry constants that are unread",
  ],
  'WTHR LNAM': ['done', 'weather.ts: the cloud layer count (29, 4)'],
  'WTHR NAM2': ['done', 'weather.ts: moon glare colours (FX)'],
  'WTHR NAM3': ['done', 'weather.ts: sun glare colours (FX)'],
};

/** Whether a reader names the subrecord (IMAD's channel subrecords are built from an index). */
function subrecordRead(type: string, signature: string): boolean {
  if (type === 'IMAD' && signature.endsWith('IAD')) return true;
  // WTHR's cloud layer textures (weather.ts cloudTextureField), TXST's TX00..TX07 (decal.ts).
  if (type === 'WTHR' && signature.endsWith('0TX')) return true;
  if (type === 'TXST' && /^TX0[0-7]$/.test(signature)) return true;
  const files = RECORDS[type] ?? [];
  const escaped = JSON.stringify(signature).slice(1, -1);
  return files.some((path) => source(path).includes(`'${escaped}'`));
}

// Alternate textures (MODS; ARMO MO2S) of placeable base objects: whether the 3D index of each
// one is a shape of the base's world model (the swap goes into the shape at that index, as the
// original's; the name it carries is the Creation Kit's and may be stale).
const swapsFound = new Map<string, number>();
const swapsMissing: string[] = [];
const PLACEABLE = ['STAT', 'MSTT', 'FURN', 'ACTI', 'CONT', 'DOOR', 'FLOR', 'MISC', 'WEAP', 'ARMO'];
for (const type of [...PLACEABLE, 'BOOK', 'ALCH', 'INGR', 'TREE', 'LIGH', 'KEYM', 'AMMO', 'SLGM']) {
  for (const id of db.formIdsOfType(type)) {
    const record = await db.get(id);
    if (!record || record.deleted) continue;
    const swaps = alternateTextures(record, record.fields.first(type === 'ARMO' ? 'MO2S' : 'MODS'));
    const model = baseModelPath(record);
    if (swaps.length === 0 || !model || !vfs.has(model)) continue;
    let names: Map<number, string>;
    try {
      const nif = parseNif(await vfs.read(model));
      names = new Map(
        [...geometryOrder(nif)].map(([ref, index]) => {
          const block = nif.blocks[ref];
          return [index, block && 'name' in block ? block.name.toLowerCase() : ''];
        }),
      );
    } catch {
      continue;
    }
    for (const swap of swaps) {
      const name = names.get(swap.index);
      const kind =
        name === undefined
          ? 'no shape at the index'
          : name === swap.shape.toLowerCase()
            ? 'shape at the index'
            : 'shape at the index (other name)';
      count(swapsFound, `${type} ${kind}`);
      if (name === undefined && swapsMissing.length < 10)
        swapsMissing.push(`${record.editorId ?? ''} ${swap.shape} at ${String(swap.index)}`);
    }
  }
}

// --- Report ---------------------------------------------------------------------------------

interface Row {
  readonly section: string;
  readonly name: string;
  readonly uses: number;
  readonly status: Status;
  readonly note: string;
}
const rows: Row[] = [];
const add = (section: string, name: string, uses: number, entry?: readonly [Status, string]) =>
  rows.push({ section, name, uses, status: entry?.[0] ?? 'open', note: entry?.[1] ?? 'unrated' });

for (const [type, n] of [...shaderTypes].sort((a, b) => a[0] - b[0])) {
  const entry = SHADER_TYPES[type];
  add(
    'Lighting shader types',
    `${String(type)} ${entry?.[0] ?? '?'}`,
    n,
    entry && [entry[1], entry[2]],
  );
}
const flagRows = (
  section: string,
  map: Map<number, number>,
  table: Record<number, Entry>,
  prefix: string,
): void => {
  for (const [bit, n] of [...map].sort((a, b) => a[0] - b[0])) {
    const entry = table[bit];
    const fallback = prefix === 'SLSF1' ? LIGHTING_SLSF1[bit] : LIGHTING_SLSF2[bit];
    const name = entry?.[0] ?? fallback?.[0] ?? '?';
    const hex = `0x${((1 << bit) >>> 0).toString(16)}`;
    add(section, `${prefix} ${name} (${hex})`, n, entry && [entry[1], entry[2]]);
  }
};
flagRows('Lighting shader flags', lighting1, LIGHTING_SLSF1, 'SLSF1');
flagRows('Lighting shader flags', lighting2, LIGHTING_SLSF2, 'SLSF2');
flagRows('Effect shader flags', effect1, EFFECT_SLSF1, 'SLSF1');
flagRows('Effect shader flags', effect2, EFFECT_SLSF2, 'SLSF2');
for (const [key, n] of [...slots].sort()) {
  const [type, slot, use] = key.split(':') as [string, string, string];
  const name = `type ${type} slot ${slot} ${SLOT_NAMES[Number(slot)] ?? ''} (${use})`;
  add(
    'Texture slots',
    name,
    n,
    use === 'sampled'
      ? ['done', 'material-slots.ts, lighting.wgsl']
      : ['n/a', 'its type and flags sample no such slot'],
  );
}
for (const [key, n] of effectTextures) {
  const entry = EFFECT_TEXTURES[key];
  add('Effect shader textures', entry?.[0] ?? key, n, entry && [entry[1], entry[2]]);
}
for (const [key, n] of [...blendModes].sort((a, b) => b[1] - a[1]))
  add('Alpha modes', key, n, ['done', 'NiAlphaProperty pipelines']);
for (const [key, n] of [...controllers].sort())
  add('Shader controller variables', key, n, ['done', 'animation.ts']);
for (const [key, n] of skyTypes)
  add('Sky shader objects', `type ${String(key)}`, n, ['done', 'sky.ts']);
for (const [key, n] of waterFlags)
  add('Water shader flags', `bit ${String(key)}`, n, ['done', 'water.wgsl']);
const RENDER_BLOCK = /^(Ni|BS)(?!.*(Havok|bhk|hk))/;
for (const [type, n] of [...blockShapes].sort((a, b) => b[1] - a[1])) {
  if (type.startsWith('bhk') || type.startsWith('hk') || !RENDER_BLOCK.test(type)) continue;
  add('Block types', `${type} (${String(blockFiles.get(type) ?? 0)} files)`, n, BLOCKS[type]);
}
for (const [key, n] of [...subrecords].sort()) {
  const [type, signature] = key.split(' ') as [string, string];
  if (RECORD_COMMON.has(signature)) continue;
  const note = SUBRECORD_NOTES[`${type} ${signature}`];
  const read = subrecordRead(type, signature);
  add(
    `Records: ${type} (${String(recordCounts.get(type) ?? 0)})`,
    // IMAD's channel subrecords start with a control byte: shown as \xNN.
    signature.replace(/[^ -~]/g, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`),
    n,
    note ?? (read ? ['done', 'read'] : ['open', 'not read']),
  );
}

for (const [key, n] of [...swapsFound].sort())
  add(
    'Alternate textures (MODS)',
    key,
    n,
    key.endsWith('no shape at the index')
      ? ['done', 'swaps nothing, as the original']
      : ['done', 'swapTextures by 3D index'],
  );

const used = rows.filter((row) => row.status !== 'n/a');
const done = used.filter((row) => row.status === 'done').length;
console.log(
  `${String(models)} models (${String(unreadable)} unreadable), ${String(lightingShapes)} lighting` +
    ` and ${String(effectShapes)} effect shaders; ${String(used.length)} items used,` +
    ` ${String(done)} done, ${String(used.length - done)} open`,
);
if (swapsMissing.length > 0)
  console.log(`alternate textures at no shape: ${swapsMissing.join('; ')}`);
let section = '';
for (const row of rows) {
  if (values.open && row.status !== 'open') continue;
  if (row.section !== section) {
    section = row.section;
    console.log(
      values.markdown
        ? `\n### ${section}\n\n| Item | Uses | Status | Where / why |\n| --- | --- | --- | --- |`
        : `\n${section}`,
    );
  }
  console.log(
    values.markdown
      ? `| ${row.name} | ${String(row.uses)} | ${row.status} | ${row.note} |`
      : `  ${row.status.padEnd(5)} ${String(row.uses).padStart(7)}  ${row.name}  ${row.note}`,
  );
}
