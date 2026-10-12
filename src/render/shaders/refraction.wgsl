// BSLightingShaderProperty with SLSF1 Refraction (heat haze over fires and torches, magic
// barriers, Nocturnal's mist). The engine draws such shapes only into the refraction buffer:
// the normal map's xy (0..1, 0.5 flat), the refraction strength and the mask (diffuse alpha
// times the material's alpha, times vertex alpha with Vertex_Alpha or Vertex_Colors). The
// image-space pass then shifts the scene by it (refraction-composite.wgsl).
// Draw uniforms: emissive.a = refraction strength.

const REFRACTION_SLSF1_VERTEX_ALPHA = 0x8u;
const REFRACTION_SLSF2_VERTEX_COLORS = 0x20u;

@fragment
fn fs_refraction(in: VertexOut) -> @location(0) vec4f {
  let normalSample = textureSample(normalMap, linearSampler, in.uv);
  let diffuse = textureSample(diffuseMap, linearSampler, in.uv);
  var mask = diffuse.a * draw.params.y;
  if ((draw.flags.x & REFRACTION_SLSF1_VERTEX_ALPHA) != 0u ||
      (draw.flags.y & REFRACTION_SLSF2_VERTEX_COLORS) != 0u) {
    mask *= in.color.a;
  }
  // Where the mask is zero the shape leaves what other refraction shapes wrote.
  if (!alphaTestPasses(mask) || mask <= 0.0) {
    discard;
  }
  return vec4f(normalSample.xy, draw.emissive.a, clamp(mask, 0.0, 1.0));
}
