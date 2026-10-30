// BSLightingShaderProperty with SLSF1 Refraction (heat haze over fires and torches, magic
// barriers, Nocturnal's mist). The engine draws such shapes only into the refraction buffer:
// the shift (0..1, 0.5 none), the refraction strength and the mask (diffuse alpha times the
// material's alpha, times vertex alpha with Vertex_Alpha or Vertex_Colors). The image-space
// pass then shifts the scene by it (refraction-composite.wgsl).
// Draw uniforms: emissive.a = refraction strength.
//
// The shift, as the original's refraction normal pass writes it (observed in its shader cache):
// the normal map's xy about 0.5 times 1.8, plus the geometry normal's view-space xy, divided
// by max(depth × 0.001333 + 0.8, 1) (the view depth: the shift shrinks beyond 150 units), then
// halved about 0.5. Fire_Refraction picks the pass's falloff variant: the strength times the
// geometry normal · the direction to the eye.

const REFRACTION_SLSF1_VERTEX_ALPHA = 0x8u;
const REFRACTION_SLSF1_FIRE_REFRACTION = 0x10000u;
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
  // Refraction fades out with distance unless No_Fade (shader-fades.ts).
  if ((draw.flags.y & SLSF2_NO_FADE) == 0u) {
    mask *= lodFeatureFade(lodFadeValue(), frame.decalFades.z, frame.decalFades.w);
  }
  // Where the mask is zero the shape leaves what other refraction shapes wrote.
  if (!alphaTestPasses(mask) || mask <= 0.0) {
    discard;
  }
  let clip = frame.viewProj * vec4f(in.worldPos, 1.0);
  let normal = safeNormalize(in.normal);
  let viewNormal = vec2f(dot(normal, frame.cameraRight.xyz), dot(normal, frame.cameraUp.xyz));
  let divisor = max(clip.w * 0.001333 + 0.8, 1.0);
  let shift = ((normalSample.xy - 0.5) * 1.8 + viewNormal) / divisor * 0.5 + 0.5;
  var strength = draw.emissive.a;
  if ((draw.flags.x & REFRACTION_SLSF1_FIRE_REFRACTION) != 0u) {
    // TODO(M13): the original's refraction target format is unread; a negative strength (the
    // normal facing away from the eye) is stored as 0 here, as a unorm target would.
    strength *= max(dot(normal, safeNormalize(frame.cameraPos.xyz - in.worldPos)), 0.0);
  }
  return vec4f(shift, strength, clamp(mask, 0.0, 1.0));
}
