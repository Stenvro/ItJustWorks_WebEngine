// The opaque pass's second colour target: what screen-space passes need besides colour and
// depth. rg: the surface's world-space normal (octahedral encoding), b: the snow mask (the
// engine's SnowParameters.y), a: 1 where an opaque object or the landscape wrote it, 0 for the
// sky and everything that leaves it (cleared to 0). Multisampled like the colour target and
// resolved for ambient occlusion (SAO) and the snow's subsurface scattering.

export const GBUFFER_FORMAT: GPUTextureFormat = 'rgba16float';

/** The target state of the G-buffer for a pipeline of the opaque pass. */
export function gbufferTarget(written: boolean): GPUColorTargetState {
  return { format: GBUFFER_FORMAT, writeMask: written ? GPUColorWrite.ALL : 0 };
}
