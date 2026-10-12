// BSEffectShaderProperty: unlit effects (glows, magic, fire cards, decals).
// TODO(M4): soft particles (depth fade), refraction, lighting influence, env maps.

const SLSF1_VERTEX_ALPHA = 0x8u;
const SLSF1_GREYSCALE_TO_PALETTE_COLOR = 0x10u;
const SLSF1_GREYSCALE_TO_PALETTE_ALPHA = 0x20u;
const SLSF1_USE_FALLOFF = 0x40u;
const SLSF2_VERTEX_COLORS = 0x20u;

@fragment
fn fs_main(in: VertexOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  let source = textureSample(diffuseMap, linearSampler, in.uv);
  let flags1 = draw.flags.x;
  let flags2 = draw.flags.y;

  // Greyscale textures look up their colour and/or alpha in a palette by brightness.
  let palette = textureSample(glowMap, linearSampler, vec2f(source.g, 0.5));
  var color = source.rgb;
  var alpha = source.a;
  if ((flags1 & SLSF1_GREYSCALE_TO_PALETTE_COLOR) != 0u) {
    color = palette.rgb;
  }
  if ((flags1 & SLSF1_GREYSCALE_TO_PALETTE_ALPHA) != 0u) {
    alpha = palette.a;
  }

  color *= draw.emissive.rgb;
  alpha *= draw.emissive.a * draw.params.y;
  if ((flags2 & SLSF2_VERTEX_COLORS) != 0u) {
    color *= in.color.rgb;
  }
  if ((flags1 & SLSF1_VERTEX_ALPHA) != 0u) {
    alpha *= in.color.a;
  }

  if ((flags1 & SLSF1_USE_FALLOFF) != 0u) {
    // Falloff angles are stored as cosines; opacity fades between them.
    var n = in.normal;
    if (!frontFacing) {
      n = -n;
    }
    let facing = abs(dot(n, normalize(frame.cameraPos.xyz - in.worldPos)));
    let range = draw.extra.x - draw.extra.y;
    let t = select(0.0, clamp((draw.extra.x - facing) / range, 0.0, 1.0), abs(range) > 1e-5);
    alpha *= mix(draw.extra.z, draw.extra.w, t);
  }

  if (!alphaTestPasses(alpha)) {
    discard;
  }
  return vec4f(color, alpha);
}
