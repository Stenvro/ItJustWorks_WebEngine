// Which textures a material's draw binds: the lighting shader's eight texture bindings filled
// from the texture set's slots by the shader type and flags (the engine's lighting techniques
// sample a slot only where their type and flags call for it), and the effect shader's source
// and palette. Platform-independent (tools/render-inventory.ts counts the slots by it).

import type { PartMaterial } from './model-data.ts';

const SHADER_GLOW = 2;
const SHADER_PARALLAX = 3;
const SHADER_FACEGEN = 4;
const SHADER_PARALLAX_OCCLUSION = 7;
const SHADER_MULTI_LAYER_PARALLAX = 11;
const SHADER_EYE_ENVIRONMENT_MAP = 16;
const SHADER_LOD_LANDSCAPE_NOISE = 18;
const SLSF1_SPECULAR = 0x1;
const SLSF1_ENVIRONMENT_MAPPING = 0x80;
const SLSF1_MODEL_SPACE_NORMALS = 0x1000;
const SLSF1_EYE_ENVIRONMENT_MAPPING = 0x20000;
const SLSF2_GLOW_MAP = 0x40;
const SLSF2_SOFT_LIGHTING = 0x2000000;
const SLSF2_RIM_LIGHTING = 0x4000000;
const SLSF2_BACK_LIGHTING = 0x8000000;

/** The terrain noise LOD landscape noise (type 18) samples in binding 6. */
export const LOD_LANDSCAPE_NOISE = 'textures\\terrain\\noise.dds';

/**
 * The texture-set slot each lighting binding samples (−1: none): diffuse, normal map, slot 2
 * (glow map, or the rim / soft light map), environment map and mask (with Environment_Mapping,
 * eyes with Eye_Environment_Mapping, multi-layer parallax), slot 7 (back light map, or the
 * specular map of model-space normals), binding 6 (the multi-layer inner layer or the FaceGen
 * tint, slot 6; parallax: the height map, slot 3) and binding 7 (the FaceGen detail map, slot 3).
 */
export function lightingSlots(shaderType: number, flags1: number, flags2: number): number[] {
  const multiLayer = shaderType === SHADER_MULTI_LAYER_PARALLAX;
  const eye =
    shaderType === SHADER_EYE_ENVIRONMENT_MAP && (flags1 & SLSF1_EYE_ENVIRONMENT_MAPPING) !== 0;
  const environment = (flags1 & SLSF1_ENVIRONMENT_MAPPING) !== 0 || multiLayer || eye;
  const glow = shaderType === SHADER_GLOW && (flags2 & SLSF2_GLOW_MAP) !== 0;
  const rimSoft = (flags2 & (SLSF2_SOFT_LIGHTING | SLSF2_RIM_LIGHTING)) !== 0;
  const backLight = (flags2 & SLSF2_BACK_LIGHTING) !== 0;
  const facegen = shaderType === SHADER_FACEGEN;
  const specularMap = (flags1 & SLSF1_MODEL_SPACE_NORMALS) !== 0 && (flags1 & SLSF1_SPECULAR) !== 0;
  return [
    0,
    1,
    glow || rimSoft ? 2 : -1,
    environment ? 4 : -1,
    environment ? 5 : -1,
    backLight || specularMap ? 7 : -1,
    multiLayer || facegen ? 6 : shaderType === SHADER_PARALLAX ? 3 : -1,
    facegen ? 3 : -1,
  ];
}

/** The textures a material binds, in the shader's binding order; '' where none. */
export function materialTextures(
  material: PartMaterial | undefined,
): [string, string, string, string, string, string, string, string] {
  if (material?.kind === 'effect') {
    return [material.sourceTexture, '', material.greyscaleTexture, '', '', '', '', ''];
  }
  if (material?.kind !== 'lighting') return ['', '', '', '', '', '', '', ''];
  const slots = lightingSlots(material.shaderType, material.flags1, material.flags2);
  const texture = (binding: number): string => {
    const slot = slots[binding] ?? -1;
    return slot < 0 ? '' : (material.textures[slot] ?? '');
  };
  return [
    texture(0),
    texture(1),
    texture(2),
    texture(3),
    texture(4),
    texture(5),
    material.shaderType === SHADER_LOD_LANDSCAPE_NOISE ? LOD_LANDSCAPE_NOISE : texture(6),
    texture(7),
  ];
}

/**
 * The engine's built-in textures a lighting material takes for a texture it lacks (observed in
 * the original): `normal` its default normal map (128, 128, 255, 255: flat, full specular; also
 * what a missing diffuse map shows, the familiar lavender), `white`, `black` (also its default
 * height map), `grey` (128), `detail` (its FaceGen detail default, 64 in every channel) and
 * `cube` (its default cube map, black). `none`: the slot is left empty (it reads 0).
 */
export type MissingTexture = 'normal' | 'white' | 'black' | 'grey' | 'detail' | 'cube' | 'none';

/**
 * Which built-in texture each of a lighting material's bindings (materialTextures order) takes
 * when its texture is missing. Every material: diffuse and normal map the default normal map;
 * rim or soft lighting's map and the back light map too; a model-space normals material's
 * specular map black. Glow maps take white, the parallax height maps black, the FaceGen tint
 * grey, its detail map the detail default and its skin map black; the environment cube map the
 * default cube; an environment-mapped material's mask stays empty, an eye's and a multi-layer
 * parallax material's mask and the multi-layer inner layer take the default normal map.
 */
export function missingTextures(
  shaderType: number,
  flags1: number,
  flags2: number,
): MissingTexture[] {
  const multiLayer = shaderType === SHADER_MULTI_LAYER_PARALLAX;
  const eye = shaderType === SHADER_EYE_ENVIRONMENT_MAP;
  const facegen = shaderType === SHADER_FACEGEN;
  const rimSoft = (flags2 & (SLSF2_SOFT_LIGHTING | SLSF2_RIM_LIGHTING)) !== 0;
  const backLight = (flags2 & SLSF2_BACK_LIGHTING) !== 0;
  const specularMap = (flags1 & SLSF1_MODEL_SPACE_NORMALS) !== 0 && (flags1 & SLSF1_SPECULAR) !== 0;
  const glow = shaderType === SHADER_GLOW && (flags2 & SLSF2_GLOW_MAP) !== 0;
  const slot2: MissingTexture = glow ? 'white' : facegen ? 'black' : rimSoft ? 'normal' : 'none';
  const slot7: MissingTexture = backLight ? 'normal' : specularMap ? 'black' : 'none';
  const binding6: MissingTexture = facegen
    ? 'grey'
    : multiLayer
      ? 'normal'
      : shaderType === SHADER_PARALLAX || shaderType === SHADER_PARALLAX_OCCLUSION
        ? 'black'
        : 'none';
  return [
    'normal',
    'normal',
    slot2,
    'cube',
    eye || multiLayer ? 'normal' : 'none',
    slot7,
    binding6,
    facegen ? 'detail' : 'none',
  ];
}
