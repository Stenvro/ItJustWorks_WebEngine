// BSLightingShaderProperty with SLSF1 Refraction (heat haze over fires and torches, magic
// barriers, Nocturnal's mist). The engine draws such shapes only into a refraction buffer
// (normal map direction, refraction strength, alpha as mask) and then shifts the scene in an
// image-space pass: offset = normal.xy * 0.05 * strength with x mirrored, blended by the mask.
// Here each shape draws that shifted copy of the opaque scene directly, blended by its mask.
// Draw uniforms: emissive.a = refraction strength.

const REFRACTION_SLSF1_VERTEX_ALPHA = 0x8u;
const REFRACTION_SLSF2_VERTEX_COLORS = 0x20u;
// Screen-space shift per unit of normal and strength (the image-space pass's 0.05).
const REFRACTION_SCALE = 0.05;

@fragment
fn fs_refraction(in: VertexOut) -> @location(0) vec4f {
  let normalSample = textureSample(normalMap, linearSampler, in.uv);
  let diffuse = textureSample(diffuseMap, linearSampler, in.uv);
  var mask = diffuse.a * draw.params.y;
  if ((draw.flags.x & REFRACTION_SLSF1_VERTEX_ALPHA) != 0u ||
      (draw.flags.y & REFRACTION_SLSF2_VERTEX_COLORS) != 0u) {
    mask *= in.color.a;
  }
  if (!alphaTestPasses(mask)) {
    discard;
  }
  let n = normalSample.xy * 2.0 - 1.0;
  let screenUv = in.position.xy * frame.screen.xy;
  let uv = clamp(
    screenUv + n * REFRACTION_SCALE * draw.emissive.a * vec2f(-1.0, 1.0),
    vec2f(0.0),
    vec2f(1.0),
  );
  let refracted = textureSampleLevel(sceneColor, screenSampler, uv, 0.0).rgb;
  return vec4f(refracted, clamp(mask, 0.0, 1.0));
}
