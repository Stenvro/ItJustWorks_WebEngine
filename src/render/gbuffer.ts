// The opaque pass's second colour target: what screen-space passes need besides colour and
// depth. rg: the surface's world-space normal (octahedral encoding), b: the snow mask (the
// engine's SnowParameters.y), a: 1 + the snow's specular (SnowParameters.x) where the composite
// finishes the surface (composite.wgsl: snow specular, AO, fog, sparkles), 0 for the sky and
// for surfaces their own shader finished (cleared to 0). Every opaque pipeline writes it, so a
// pixel holds what its front surface wrote (the engine's depth pre-pass gives the same: grass
// in front of snowy land is no snow). Multisampled like the colour target: the composite reads
// it per sample; resolved for ambient occlusion (SAO) and the snow's subsurface scattering.

export const GBUFFER_FORMAT: GPUTextureFormat = 'rgba16float';

/** The target state of the G-buffer for a pipeline of the opaque pass. */
export function gbufferTarget(written: boolean): GPUColorTargetState {
  return { format: GBUFFER_FORMAT, writeMask: written ? GPUColorWrite.ALL : 0 };
}
