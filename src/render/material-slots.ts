// Which textures a material's draw binds: the lighting shader's eight texture bindings filled
// from the texture set's slots by the shader type and flags (the engine's lighting techniques
// sample a slot only where their type and flags call for it), and the effect shader's source
// and palette. Platform-independent (tools/render-inventory.ts counts the slots by it).

import type { PartMaterial } from './model-data.ts';

const SHADER_GLOW = 2;
const SHADER_PARALLAX = 3;
const SHADER_FACEGEN = 4;
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
