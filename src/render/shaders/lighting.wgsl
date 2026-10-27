// Adapted from Community Shaders' shaders (MIT, Copyright (c) 2022 Ilya Perapechka); see
// THIRD_PARTY_NOTICES.md.
// BSLightingShaderProperty: Skyrim's object shader, following the engine's lighting pixel
// shader as Community Shaders' near-vanilla Lighting.hlsl (v0.7.4) reproduces it: diffuse,
// normal map (tangent or model space), specular (anisotropic for hair), glow, own emit,
// environment map, soft / rim / back lighting, skin and hair tint, multi-layer parallax, LOD
// landscape and its noise, directional materials (snow, ash, moss and ice laid over a
// static) and the multi-index snow pass of multi-pass materials. Sun, directional ambient,
// point lights, shadows and fog come from frame.wgsl; the snow rim light and sparkles from
// snow.wgsl (opaque parts leave the rim, fog and sparkles to the composite, see DEFERRED).
// Prepended with frame.wgsl, snow.wgsl and common.wgsl. ASCII only.
// Notes: docs/rendering.md ("Lighting shader").
//
// Parallax (type 3), as the vanilla pixel shader (aers' Skyrim SE shader decompile): the height
// map shifts the texture coordinates by (height * 0.08 - 0.04) along the model-space view
// direction's x and y (not the tangent-space one: a bug of the original, kept).

const SLSF1_SPECULAR = 0x1u;
const SLSF1_VERTEX_ALPHA = 0x8u;
const SLSF1_ENVIRONMENT_MAPPING = 0x80u;
const SLSF1_RECEIVE_SHADOWS = 0x100u;
const SLSF1_MODEL_SPACE_NORMALS = 0x1000u;
const SLSF1_OWN_EMIT = 0x400000u;
const SLSF1_EXTERNAL_EMITTANCE = 0x20000000u;
const SLSF2_VERTEX_COLORS = 0x20u;
const SLSF2_GLOW_MAP = 0x40u;
const SLSF2_ANISOTROPIC_LIGHTING = 0x200000u;
const SLSF2_SOFT_LIGHTING = 0x2000000u;
const SLSF2_RIM_LIGHTING = 0x4000000u;
const SLSF2_BACK_LIGHTING = 0x8000000u;
const SLSF2_SNOW = 0x10000000u;
const SHADER_ENVIRONMENT_MAP = 1u;
const SHADER_GLOW = 2u;
const SHADER_PARALLAX = 3u;
const SHADER_FACEGEN = 4u;
const SHADER_SKIN_TINT = 5u;
const SHADER_HAIR_TINT = 6u;
const SHADER_LOD_LANDSCAPE = 9u;
const SHADER_MULTI_LAYER_PARALLAX = 11u;
const SHADER_LOD_OBJECTS = 13u;
const SHADER_LOD_OBJECTS_HD = 15u;
const SHADER_EYE_ENVIRONMENT_MAP = 16u;
const SHADER_LOD_LANDSCAPE_NOISE = 18u;
// Draw flags above the NiAlphaProperty bits (scene-renderer.ts).
const DRAW_SKY = 0x10000u;
const DRAW_PROJECTED = 0x20000u;
const DRAW_PROJECTED_TEXTURED = 0x40000u;
const DRAW_MULTI_PASS = 0x80000u;
const DRAW_SNOW = 0x100000u;
const DRAW_LOD_HD = 0x200000u;
// fProjectedUVDiffuseNormalTilingScale (the launcher's presets): projected texture repeats
// per noise repeat.
const PROJECTED_TILING = 0.2;
// Set for the opaque pass's pipelines: the colour leaves the snow specular, fog and sparkles
// to the composite (composite.wgsl), which runs after the snow's scattering, as the engine's
// lighting shader leaves them to ISSAOComposite. Blended parts finish their colour here.
override DEFERRED: bool = false;

// Texture coordinate gradients for samples taken outside uniform control flow.
struct Gradients {
  dx: vec2f,
  dy: vec2f,
};

fn sampleGrad(t: texture_2d<f32>, uv: vec2f, g: Gradients, scale: f32) -> vec4f {
  return textureSampleGrad(t, linearSampler, uv, g.dx * scale, g.dy * scale);
}

// Soft lighting: light that wraps around the terminator (subsurface rolloff in effect.x).
fn softLight(angle: f32) -> f32 {
  let rolloff = draw.effect.x;
  let soft = saturate((rolloff + angle) / (1.0 + rolloff));
  let clamped = saturate(angle);
  return saturate(soft * soft * (3.0 - 2.0 * soft) - clamped * clamped * (3.0 - 2.0 * clamped));
}

// Rim lighting: light behind the surface seen at grazing angles (rim power in effect.y).
fn rimLight(toLight: vec3f, toCamera: vec3f, n: vec3f) -> f32 {
  let nDotV = saturate(dot(n, toCamera));
  return pow(max(1.0 - nDotV, 1e-6), draw.effect.y) * saturate(dot(toCamera, -toLight));
}

// What the specular term of one light needs besides the light itself.
struct SpecularInputs {
  n: vec3f,
  vertexNormal: vec3f,
  toCamera: vec3f,
  shininess: f32,
  specular: bool,
  anisotropic: bool,
  // Multi-index snow: the sparkle noise (0 without sparkles).
  sparkle: f32,
};

fn lightSpecular(toLight: vec3f, color: vec3f, s: SpecularInputs) -> vec3f {
  let halfway = safeNormalize(s.toCamera + toLight);
  var hDotN: f32;
  if (s.anisotropic) {
    let an = safeNormalize(s.n * 0.5 + s.vertexNormal);
    hDotN = 1.0 - min(1.0, abs(dot(an, toLight) - dot(an, halfway)));
  } else {
    hDotN = saturate(dot(halfway, s.n));
  }
  var multiplier = select(0.0, pow(max(hDotN, 1e-6), s.shininess), s.specular);
  if (s.anisotropic) {
    multiplier *= 0.7 * max(0.0, toLight.z);
  }
  if (s.sparkle > 0.0) {
    // Sparkles glint where the reflected view meets the light.
    let reflected = s.toCamera - 2.0 * s.n * dot(s.toCamera, s.n);
    let glint = pow(max(saturate(dot(reflected, -toLight)), 1e-6), draw.sparkle.w) *
      (draw.sparkle.z * s.sparkle);
    multiplier += select(0.0, 1.0, glint >= 0.5) * hDotN;
  }
  return color * multiplier;
}

struct ObjectLighting {
  diffuse: vec3f,
  specular: vec3f,
};

// The sun and point lights on a surface, with the material's soft, rim and back lighting
// (those use the unshadowed light colour, as the engine does).
fn objectLighting(
  n: vec3f,
  worldPos: vec3f,
  shadow: f32,
  rimSoft: vec3f,
  backLight: vec3f,
  s: SpecularInputs,
  wantSpecular: bool,
  // The geometry's normal (the shadow lookups' offset) and whether it receives shadows.
  shadowNormal: vec3f,
  receivesShadows: bool,
) -> ObjectLighting {
  let flags2 = draw.flags.y;
  let soft = (flags2 & SLSF2_SOFT_LIGHTING) != 0u;
  let rim = (flags2 & SLSF2_RIM_LIGHTING) != 0u;
  let back = (flags2 & SLSF2_BACK_LIGHTING) != 0u;
  var result: ObjectLighting;
  let toSun = frame.sunDir.xyz;
  let sunColor = frame.sunColor.rgb;
  let sunAngle = dot(n, toSun);
  result.diffuse = sunColor * shadow * saturate(sunAngle);
  result.specular = vec3f(0.0);
  if (soft) {
    result.diffuse += sunColor * softLight(sunAngle) * rimSoft;
  }
  if (rim) {
    result.diffuse += sunColor * rimLight(toSun, s.toCamera, n) * rimSoft;
  }
  if (back) {
    result.diffuse += sunColor * saturate(-sunAngle) * backLight;
  }
  if (wantSpecular) {
    result.specular += lightSpecular(toSun, sunColor * shadow, s);
  }
  let room = draw.flags.z >> 24u;
  for (var i = 0u; i < frame.counts.x; i++) {
    let light = pointLights[i];
    if (lightOtherRoom(light, room)) {
      continue;
    }
    let offset = light.position - worldPos;
    let distance = length(offset);
    let falloff = saturate(distance / light.radius);
    if (falloff >= 1.0) {
      continue;
    }
    let color = light.color * (1.0 - falloff * falloff) * lightCone(light, offset);
    let toLight = offset / max(distance, 1e-4);
    let angle = dot(n, toLight);
    // The light's shadow darkens its direct light (as the sun's: not the soft, rim and back
    // light).
    let shadowed = color * select(1.0, pointShadow(light, worldPos, shadowNormal), receivesShadows);
    result.diffuse += shadowed * saturate(angle);
    if (soft) {
      // The engine passes the unnormalized light vector here.
      result.diffuse += color * softLight(dot(n, offset)) * rimSoft;
    }
    if (rim) {
      result.diffuse += color * rimLight(toLight, s.toCamera, n) * rimSoft;
    }
    if (back) {
      result.diffuse += color * saturate(-angle) * backLight;
    }
    if (wantSpecular) {
      result.specular += lightSpecular(toLight, shadowed, s);
    }
  }
  return result;
}

// LOD landscape noise: breaks up distant terrain colour (GetLodLandBlendParameter /
// GetLodLandBlendMultiplier).
fn lodLandNoise(color: vec3f, noise: f32) -> f32 {
  var p = saturate(1.6666666 * (dot(color, vec3f(0.55)) - 0.4));
  p = p * p * (3.0 - 2.0 * p) * 0.8;
  return 0.8333333 * (p * (0.37 - noise) + noise) + 0.37;
}

// The lit colour and the G-buffer (written by opaque parts; blended parts' pipelines have no
// second target).
struct LightingOut {
  @location(0) color: vec4f,
  @location(1) gbuffer: vec4f,
};

@fragment
fn fs_main(in: VertexOut, @builtin(front_facing) frontFacing: bool) -> LightingOut {
  let flags1 = draw.flags.x;
  let flags2 = draw.flags.y;
  let drawFlags = draw.flags.z;
  let shaderType = draw.flags.w;
  let multiPass = (drawFlags & DRAW_MULTI_PASS) != 0u;
  let projected = (drawFlags & DRAW_PROJECTED) != 0u;
  let lodLand = shaderType == SHADER_LOD_LANDSCAPE || shaderType == SHADER_LOD_LANDSCAPE_NOISE;
  // LOD landscape (9, 18) and LOD objects (13, 15) give way to the loaded cells; object LOD
  // blocks (type 0 with LOD flags) are left out by cell instead (scene-renderer.ts).
  let lod = lodLand || shaderType == SHADER_LOD_OBJECTS || shaderType == SHADER_LOD_OBJECTS_HD;

  // Directional materials are laid on along the world: TexCoord0.zw of the engine, a plane
  // across the direction surfaces face to get them (single pass: up, giving world y, -x).
  let up = safeNormalize(draw.projectedDirection.xyz);
  let projectedUv = projectedCoordinates(in.worldPos);
  let noiseUv = projectedUv * draw.projected.z;
  let toCamera = safeNormalize(frame.cameraPos.xyz - in.worldPos);

  // Gradients and samples in uniform control flow; the rest samples with these gradients.
  let uvGradients = Gradients(dpdx(in.uv), dpdy(in.uv));
  let noiseGradients = Gradients(dpdx(noiseUv), dpdy(noiseUv));
  let faceNormalRaw = cross(dpdx(in.worldPos), dpdy(in.worldPos));
  // Parallax: the height map (slot 3, bound in the layer map's place) shifts the texture.
  // FaceGen heads keep their tint in the same slot (6).
  let layerSample = textureSample(layerMap, linearSampler, in.uv);
  let height = layerSample.r;
  let detailSample = textureSample(detailMap, linearSampler, in.uv);
  let modelView = safeNormalize(transpose(worldRotation()) * toCamera);
  let surfaceUv = select(
    in.uv,
    in.uv + modelView.xy * (height * 0.08 - 0.04),
    shaderType == SHADER_PARALLAX,
  );
  // Multi-pass materials put their own diffuse texture on by the projection.
  let diffuseUv = select(surfaceUv, projectedUv * draw.projectedColor.y, multiPass);
  let diffuse = textureSample(diffuseMap, linearSampler, diffuseUv);
  let normalSample = textureSample(normalMap, linearSampler, surfaceUv);
  // Glow map, or the rim / soft light map.
  let slot2 = textureSample(glowMap, linearSampler, surfaceUv);
  let envMaskSample = textureSample(envMask, linearSampler, surfaceUv);
  // Back light map, or the specular map of model-space normal materials.
  let slot7 = textureSample(backLightMap, linearSampler, surfaceUv);

  if (lod && lodHidden(in.worldPos)) {
    discard;
  }

  var base = diffuse.rgb;
  var alpha = diffuse.a * draw.params.y;
  // Tree_Anim shapes keep their leaf weights in the vertex alpha.
  if ((flags1 & SLSF1_VERTEX_ALPHA) != 0u && (drawFlags & DRAW_TREE_ANIM) == 0u) {
    alpha *= in.color.a;
  }
  if (!alphaTestPasses(alpha)) {
    discard;
  }

  // Normal: tangent space, or model space (stored x, z, y) for MSN materials and LOD land.
  let modelSpace = (flags1 & SLSF1_MODEL_SPACE_NORMALS) != 0u || lodLand;
  let tangent = safeNormalize(in.tangent);
  let bitangent = safeNormalize(in.bitangent);
  let vertexNormal = safeNormalize(in.normal);
  var mapped: vec3f;
  var n: vec3f;
  if (modelSpace) {
    mapped = normalSample.xzy * 2.0 - 1.0;
    if ((drawFlags & DRAW_SKINNED) != 0u) {
      // Skinned: the vertex frame carries the bones' turn (skinning.wgsl).
      n = safeNormalize(mapped.x * tangent + mapped.y * bitangent + mapped.z * vertexNormal);
    } else {
      n = safeNormalize(worldRotation() * mapped);
    }
  } else {
    mapped = normalSample.rgb * 2.0 - 1.0;
    n = safeNormalize(mapped.x * tangent + mapped.y * bitangent + mapped.z * vertexNormal);
  }
  if (!frontFacing) {
    n = -n;
  }

  // Specular mask: the normal map's alpha, or the specular map with model-space normals.
  var glossiness = select(normalSample.a, slot7.r, modelSpace);
  if (lodLand) {
    glossiness = 0.0;
    if (shaderType == SHADER_LOD_LANDSCAPE_NOISE) {
      base *= lodLandNoise(base, sampleGrad(layerMap, in.uv * 3.0, uvGradients, 3.0).r);
    }
  }
  if (shaderType == SHADER_FACEGEN) {
    // The actor's face tint (slot 6) over the head, times the detail map (slot 3).
    let detail = 3.984375 * (vec3f(0.00392156886, 0.0, 0.00392156886) + detailSample.rgb);
    let tint = layerSample.rgb * base * 2.0;
    base = (base * base + tint - tint * base) * detail;
  }
  if (shaderType == SHADER_SKIN_TINT) {
    let tint = draw.extra.rgb * base * 2.0;
    base = vec3f(1.01171875, 0.99609375, 1.01171875) * (base * base + tint - tint * base);
  }

  // Directional material: how far this pixel faces the material's direction, broken up by
  // the noise texture (ProjectedUVParams: x noise falloff, z noise scale, w threshold).
  let lodHd = (drawFlags & DRAW_LOD_HD) != 0u;
  let hasVertexColors = (flags2 & SLSF2_VERTEX_COLORS) != 0u;
  let treeAnim = (drawFlags & DRAW_TREE_ANIM) != 0u;
  let vertexAlpha = select(select(1.0, in.color.a, hasVertexColors), 1.0, lodHd || treeAnim);
  var projectedWeight = 0.0;
  if (projected || multiPass) {
    let noise = sampleGrad(projectedNoise, noiseUv, noiseGradients, 1.0).r;
    projectedWeight = -draw.projected.x * noise + (dot(n, up) * vertexAlpha - draw.projected.w);
    if (lodHd) {
      projectedWeight += (in.color.a - 0.5) * 2.5;
    }
  }
  var shadingNormal = n;
  var sparkle = 0.0;
  // The snow shader's mask (the engine's SnowParameters.y): how much of the pixel is snow.
  var projectedMask = 0.0;
  if (multiPass) {
    // The second pass covers the triangles facing the material (the engine's alternate
    // index list) and of those the parts the noise lets through.
    var faceNormal = safeNormalize(faceNormalRaw);
    faceNormal = select(faceNormal, -faceNormal, dot(faceNormal, toCamera) < 0.0);
    if (projectedWeight < 0.0 || dot(faceNormal, up) < draw.projectedDirection.w) {
      discard;
    }
    // The material's normal map, flattened by the normal dampener.
    let dampened = vec3f(draw.projectedColor.x * mapped.xy, mapped.z);
    shadingNormal = safeNormalize(
      dampened.x * tangent + dampened.y * bitangent + dampened.z * vertexNormal,
    );
    if (!frontFacing) {
      shadingNormal = -shadingNormal;
    }
    // Sparkle noise at three scales of the engine's projected normal map.
    let scales = pow(vec3f(abs(draw.sparkle.x)), vec3f(1.3, 1.6, 1.9));
    let s1 = sampleGrad(projectedNormal, in.uv * scales.x, uvGradients, scales.x).z;
    let s2 = sampleGrad(projectedNormal, in.uv * scales.y, uvGradients, scales.y).z;
    let s3 = sampleGrad(projectedNormal, in.uv * scales.z, uvGradients, scales.z).z;
    let glints = pow(max(min(vec3f(1.0), abs(vec3f(s1, s2, s3))), vec3f(1e-6)), vec3f(draw.sparkle.y));
    sparkle = glints.x + glints.y + glints.z;
    projectedMask = 1.0;
  } else if (projected) {
    if ((drawFlags & DRAW_PROJECTED_TEXTURED) != 0u) {
      let w = saturate(5.0 * (0.1 + projectedWeight));
      let blend = w * w * (3.0 - 2.0 * w);
      let projectedColor =
        sampleGrad(projectedDiffuse, noiseUv * PROJECTED_TILING, noiseGradients, PROJECTED_TILING).rgb;
      base = mix(base, projectedColor * draw.projectedColor.rgb, blend);
      projectedMask = blend;
    } else if (projectedWeight > 0.0) {
      base = draw.projectedColor.rgb;
      projectedMask = projectedWeight;
    }
  }

  // Snow (a static counted as snow, or a snow shader) leaves its highlights to the snow
  // shader's rim light.
  let snow = (drawFlags & DRAW_SNOW) != 0u || (flags2 & SLSF2_SNOW) != 0u;
  // Snow mask: the projected material's weight, else the diffuse alpha (snow textures keep
  // the mask there, bEnableSnowMask).
  let snowMask = select(0.0, select(diffuse.a, projectedMask, projected || multiPass), snow);
  let hasSpecular = (flags1 & SLSF1_SPECULAR) != 0u && !lodLand;
  let anisotropic = (flags2 & SLSF2_ANISOTROPIC_LIGHTING) != 0u;
  // Sparkles light up only without the snow shader.
  let sparkles = select(0.0, sparkle, multiPass && !snow);
  let inputs = SpecularInputs(
    shadingNormal,
    vertexNormal,
    toCamera,
    max(draw.params.x, 1.0),
    hasSpecular,
    anisotropic,
    sparkles,
  );

  // Receive_Shadows: the sun's cascaded shadow maps darken the surface.
  let receivesShadows = (flags1 & SLSF1_RECEIVE_SHADOWS) != 0u;
  let shadow = select(1.0, sunShadow(in.worldPos, vertexNormal), receivesShadows);
  let lights = objectLighting(
    shadingNormal,
    in.worldPos,
    shadow,
    slot2.rgb,
    slot7.rgb,
    inputs,
    (hasSpecular || multiPass) && !snow,
    vertexNormal,
    receivesShadows,
  );
  let ambient = directionalAmbient(shadingNormal);

  // Emit: own emit, or the glow map times the emissive colour; lit like the rest, so the
  // diffuse texture colours it.
  var emit = vec3f(0.0);
  if (shaderType == SHADER_GLOW && (flags2 & SLSF2_GLOW_MAP) != 0u) {
    emit = draw.emissive.rgb * slot2.rgb;
  } else if ((flags1 & (SLSF1_OWN_EMIT | SLSF1_EXTERNAL_EMITTANCE)) != 0u) {
    // External emittance: the reference's XEMI colour (written into emissive) or, without
    // one, the shape's own emissive colour.
    emit = draw.emissive.rgb;
  }
  let diffuseLight = ambient + emit + lights.diffuse;
  var color = diffuseLight * base;
  var vertexColor = vec3f(1.0);
  if (hasVertexColors) {
    vertexColor = in.color.rgb;
  }
  if (shaderType == SHADER_HAIR_TINT) {
    // Hair: the tint follows the vertex colours' green channel.
    color *= in.color.g * (draw.extra.rgb - 1.0) + 1.0;
  } else {
    color *= vertexColor;
  }

  if (shaderType == SHADER_MULTI_LAYER_PARALLAX) {
    // The inner layer seen through the surface, shifted by the view and the normal map.
    let layerValue = draw.layer.x * textureSampleGrad(layerMap, linearSampler, in.uv, uvGradients.dx, uvGradients.dy).a;
    let tangentView = vec3f(dot(toCamera, tangent), dot(toCamera, bitangent), dot(toCamera, vertexNormal));
    let layerNormal = draw.layer.y * (normalSample.xyz * 2.0 + vec3f(-1.0, -1.0, -2.0)) + vec3f(0.0, 0.0, 1.0);
    let layerViewAngle = dot(-tangentView, layerNormal) * 2.0;
    let layerProjection = -layerNormal * layerViewAngle - tangentView;
    let layerUv = in.uv * draw.layer.zw +
      (0.0009765625 * (layerValue / max(abs(layerProjection.z), 1e-4))) * layerProjection.xy;
    let layerColor = sampleGrad(layerMap, layerUv, uvGradients, 1.0).rgb;
    let layerBlend = saturate(dot(n, toCamera)) * (1.0 - diffuse.a);
    color = mix(color, (ambient + lights.diffuse) * (vertexColor * layerColor), layerBlend);
  }

  // Environment map, lit like the surface; masked by the environment mask (else by the
  // specular mask).
  let environment =
    ((flags1 & SLSF1_ENVIRONMENT_MAPPING) != 0u &&
      (shaderType == SHADER_ENVIRONMENT_MAP || shaderType == SHADER_EYE_ENVIRONMENT_MAP)) ||
    shaderType == SHADER_MULTI_LAYER_PARALLAX;
  if (environment) {
    let mask = select(glossiness, envMaskSample.r, draw.effect.z > 0.5) * draw.params.w;
    let r = reflect(-toCamera, n);
    // Skyrim is Z-up; cubemaps use Y-up face orientation.
    let env = textureSampleLevel(envMap, linearSampler, vec3f(r.x, r.z, r.y), 0.0).rgb;
    color += env * mask * diffuseLight;
  }

  // Specular: times the specular mask and colour (multi-index snow: the mask only).
  var specular = vec3f(0.0);
  if (hasSpecular) {
    specular = lights.specular * glossiness * draw.specular.rgb * draw.specular.a;
  } else if (multiPass) {
    specular = lights.specular * glossiness;
  }
  color += specular;
  // Snow: the rim light in place of the specular (the engine's SnowParameters.x).
  let snowSpecular = select(0.0, snowRimSpecular(vertexNormal, shadingNormal, toCamera), snowMask > 0.0);
  // Sky objects (weather sky statics) are not fogged: finished here, also when opaque.
  let sky = (drawFlags & DRAW_SKY) != 0u;
  let deferred = DEFERRED && !sky;

  let gbuffer = select(
    gbufferFinished(shadingNormal),
    gbufferValue(shadingNormal, snowMask, snowSpecular),
    deferred,
  );
  switch (frame.counts.z) {
    case 1u: {
      return LightingOut(vec4f(base, alpha), gbuffer);
    }
    case 2u: {
      return LightingOut(vec4f(shadingNormal * 0.5 + 0.5, alpha), gbuffer);
    }
    case 3u: {
      return LightingOut(vec4f(diffuseLight, alpha), gbuffer);
    }
    case 4u: {
      return LightingOut(vec4f(in.color.rgb, alpha), gbuffer);
    }
    case 5u: {
      return LightingOut(vec4f(vertexNormal * 0.5 + 0.5, alpha), gbuffer);
    }
    default: {
      // Opaque parts: the snow's scattering and then the composite (snow specular, AO, fog,
      // sparkles) finish the colour, as in the engine.
      if (deferred) {
        return LightingOut(vec4f(color, alpha), gbuffer);
      }
      // Blended parts (and sky objects) are finished here.
      color += vec3f(snowSpecular * snowMask);
      var fogged = select(applyFog(color, in.worldPos), color, sky);
      // Snow sparkles come after the fog, as in the engine's composite pass.
      if (snowMask > 0.0) {
        fogged += snowSparkles(in.worldPos, shadow) * snowMask;
      }
      return LightingOut(vec4f(fogged, alpha), gbuffer);
    }
  }
}
