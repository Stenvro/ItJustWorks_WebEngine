// BSEffectShaderProperty: unlit effects (glows, magic, fire cards, decals) and, through
// effectShade, particles. Follows the engine's effect pixel shader: base texture times base
// colour and vertex (or particle) colour, falloff, soft depth fade, material alpha, then the
// greyscale palette (U: the texture, V: the colour's red or the alpha so far), lighting
// influence, alpha test and fog. Draw uniforms: emissive = base colour, params.w = base colour
// scale, specular.x = lighting influence, specular.y = soft falloff depth.
// TODO(M9): environment maps on effects (only magic and UI meshes use them).

const SLSF1_VERTEX_ALPHA = 0x8u;
const SLSF1_GREYSCALE_TO_PALETTE_COLOR = 0x10u;
const SLSF1_GREYSCALE_TO_PALETTE_ALPHA = 0x20u;
const SLSF1_USE_FALLOFF = 0x40u;
const SLSF1_SOFT_EFFECT = 0x40000000u;
const SLSF2_VERTEX_COLORS = 0x20u;
const SLSF2_EFFECT_LIGHTING = 0x40000000u;
// NiAlphaProperty: blending on; blend factor ONE (additive when it is the destination factor).
const ALPHA_BLEND = 0x1u;
const BLEND_ONE = 0u;
// Draw flag beside the alpha flags: a sky object (aurora, distant clouds), not fogged.
const DRAW_SKY = 0x10000u;
// ...the second pass of a multi-pass directional material (scene-renderer.ts).
const DRAW_MULTI_PASS = 0x80000u;

// Light reaching an effect: ambient from its side, the sun (half of it even when facing away:
// smoke and mist scatter it) and point lights by distance. With external emittance the
// reference's XEMI colour (draw.effect.rgb, w = 1) stands for the ambient and the sun.
fn effectLight(n: vec3f, worldPos: vec3f) -> vec3f {
  let sun = 0.5 + 0.5 * max(dot(n, frame.sunDir.xyz), 0.0);
  var light = directionalAmbient(n) + frame.sunColor.rgb * sun * sunShadow(worldPos, n);
  if (draw.effect.w > 0.5) {
    light = draw.effect.rgb;
  }
  for (var i = 0u; i < frame.counts.x; i++) {
    let point = pointLights[i];
    let offset = point.position - worldPos;
    let distanceSquared = dot(offset, offset);
    let radiusSquared = point.radius * point.radius;
    if (distanceSquared < radiusSquared) {
      light += point.color * (1.0 - distanceSquared / radiusSquared);
    }
  }
  return light;
}

// Shades an effect fragment from its sampled source texture. `tint` is the vertex or
// particle colour; `n` the surface normal (towards the camera for particles).
fn effectShade(
  source: vec4f,
  tint: vec4f,
  n: vec3f,
  worldPos: vec3f,
  fragCoord: vec4f,
) -> vec4f {
  let flags1 = draw.flags.x;
  let flags2 = draw.flags.y;
  let alphaFlags = draw.flags.z;
  let paletteColor = (flags1 & SLSF1_GREYSCALE_TO_PALETTE_COLOR) != 0u;
  let paletteAlpha = (flags1 & SLSF1_GREYSCALE_TO_PALETTE_ALPHA) != 0u;
  let toCamera = normalize(frame.cameraPos.xyz - worldPos);

  let colorMul = draw.emissive * tint;
  var color = source.rgb * colorMul.rgb;
  var alpha = select(source.a, 1.0, paletteAlpha) * colorMul.a;
  if ((flags1 & SLSF1_USE_FALLOFF) != 0u) {
    // Falloff angles are stored as cosines; opacity fades between them.
    let facing = abs(dot(n, toCamera));
    let range = draw.extra.x - draw.extra.y;
    let t = select(0.0, clamp((draw.extra.x - facing) / range, 0.0, 1.0), abs(range) > 1e-5);
    alpha *= mix(draw.extra.z, draw.extra.w, t);
  }
  let blended = (alphaFlags & ALPHA_BLEND) != 0u;
  if (blended && (flags1 & SLSF1_SOFT_EFFECT) != 0u && draw.specular.y > 0.0) {
    // Soft effect: fade out where the opaque scene is close behind.
    alpha *= clamp(depthToScene(fragCoord) / draw.specular.y, 0.0, 1.0);
  }
  alpha *= draw.params.y;

  // The palette: clamped (its rows must not wrap), sampled in uniform control flow.
  let paletteA = textureSample(glowMap, screenSampler, vec2f(source.a, alpha)).a;
  let paletteRgb = textureSample(glowMap, screenSampler, vec2f(source.g, colorMul.r)).rgb;
  if (paletteAlpha) {
    alpha = paletteA;
  }
  if (paletteColor) {
    color = paletteRgb;
  }
  color *= draw.params.w;

  if ((flags2 & SLSF2_EFFECT_LIGHTING) != 0u) {
    color = mix(color, color * effectLight(n, worldPos), draw.specular.x);
  }
  if (!alphaTestPasses(alpha) || (blended && alpha < 0.003)) {
    discard;
  }

  var fog = fogAt(worldPos);
  if ((alphaFlags & DRAW_SKY) != 0u) {
    fog = vec4f(0.0);
  }
  if (blended && ((alphaFlags >> 5u) & 15u) == BLEND_ONE) {
    // Additive: fog takes the light away.
    color *= 1.0 - fog.a;
  } else {
    color = mix(color, fog.rgb, fog.a);
  }
  return vec4f(color, alpha);
}

@fragment
fn fs_main(in: VertexOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  // A multi-pass directional material with an effect shader (the engine's PROJECTED_UV with
  // normals): texture coordinates from the projection, shown where the surface faces the
  // material by more than 0.4 to 0.6 (noise), on the triangles within the max angle.
  let multiPass = (draw.flags.z & DRAW_MULTI_PASS) != 0u;
  let projectedUv = projectedCoordinates(in.worldPos) * draw.projectedColor.y;
  let uv = select(in.uv, projectedUv, multiPass);
  let source = textureSample(diffuseMap, linearSampler, uv);
  let noise = textureSample(projectedNoise, linearSampler, 0.0033333334 * projectedUv).r * 0.2 + 0.4;
  let faceNormalRaw = cross(dpdx(in.worldPos), dpdy(in.worldPos));
  let flags1 = draw.flags.x;
  let flags2 = draw.flags.y;
  if (multiPass) {
    let up = safeNormalize(draw.projectedDirection.xyz);
    var faceNormal = safeNormalize(faceNormalRaw);
    faceNormal = select(faceNormal, -faceNormal, dot(faceNormal, frame.cameraPos.xyz - in.worldPos) < 0.0);
    if (dot(safeNormalize(in.normal), up) - noise < 0.0 || dot(faceNormal, up) < draw.projectedDirection.w) {
      discard;
    }
  }
  var tint = vec4f(1.0);
  if ((flags2 & SLSF2_VERTEX_COLORS) != 0u && !multiPass) {
    tint = in.color;
  } else if ((flags1 & SLSF1_VERTEX_ALPHA) != 0u) {
    tint.a = in.color.a;
  }
  var n = in.normal;
  if (!frontFacing) {
    n = -n;
  }
  return effectShade(source, tint, n, in.worldPos, in.position);
}
