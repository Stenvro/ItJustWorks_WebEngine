// BSLightingShaderProperty: Skyrim's main object shader (diffuse, normal map, specular,
// glow, environment map, vertex colours). Lighting is a single sun plus ambient for now.
// TODO(M4): cell and weather lighting, point lights, shadows, rim/back/soft lighting,
// parallax and multi-layer parallax, snow and LOD variants.

const SLSF1_SPECULAR = 0x1u;
const SLSF1_RECEIVE_SHADOWS = 0x100u;
const SLSF1_VERTEX_ALPHA = 0x8u;
const SLSF1_ENVIRONMENT_MAPPING = 0x80u;
const SLSF1_MODEL_SPACE_NORMALS = 0x1000u;
const SLSF1_OWN_EMIT = 0x400000u;
const SLSF2_VERTEX_COLORS = 0x20u;
const SLSF2_GLOW_MAP = 0x40u;
const SHADER_ENVIRONMENT_MAP = 1u;
const SHADER_GLOW = 2u;
const SHADER_SKIN_TINT = 5u;
const SHADER_HAIR_TINT = 6u;
const SHADER_EYE_ENVIRONMENT_MAP = 16u;

@fragment
fn fs_main(in: VertexOut, @builtin(front_facing) frontFacing: bool) -> @location(0) vec4f {
  // Sample everything up front: sampling must happen in uniform control flow.
  let diffuse = textureSample(diffuseMap, linearSampler, in.uv);
  let normalSample = textureSample(normalMap, linearSampler, in.uv);
  let glow = textureSample(glowMap, linearSampler, in.uv);
  let envMaskSample = textureSample(envMask, linearSampler, in.uv);

  let flags1 = draw.flags.x;
  let flags2 = draw.flags.y;
  let shaderType = draw.flags.w;
  // LOD landscape (9), LOD objects (13, 15) and noisy LOD landscape (18) give way to the
  // loaded cells.
  let lod = shaderType == 9u || shaderType == 13u || shaderType == 15u || shaderType == 18u;
  if (lod && lodHidden(in.worldPos)) {
    discard;
  }

  var base = diffuse.rgb;
  var alpha = diffuse.a * draw.params.y;
  if ((flags2 & SLSF2_VERTEX_COLORS) != 0u) {
    base *= in.color.rgb;
  }
  if ((flags1 & SLSF1_VERTEX_ALPHA) != 0u) {
    alpha *= in.color.a;
  }
  if (shaderType == SHADER_SKIN_TINT || shaderType == SHADER_HAIR_TINT) {
    base *= draw.extra.rgb;
  }
  if (!alphaTestPasses(alpha)) {
    discard;
  }

  // Normal: tangent space by default, model space for MSN materials.
  let mapped = normalSample.rgb * 2.0 - 1.0;
  var n: vec3f;
  if ((flags1 & SLSF1_MODEL_SPACE_NORMALS) != 0u) {
    n = safeNormalize(worldRotation() * mapped);
  } else {
    n = safeNormalize(
      mapped.x * safeNormalize(in.tangent) +
        mapped.y * safeNormalize(in.bitangent) +
        mapped.z * safeNormalize(in.normal),
    );
  }
  if (!frontFacing) {
    n = -n;
  }

  let toCamera = safeNormalize(frame.cameraPos.xyz - in.worldPos);
  let hasSpecular = (flags1 & SLSF1_SPECULAR) != 0u;
  let glossiness = max(draw.params.x, 1.0);
  // Specular mask lives in the normal map's alpha (none for MSN).
  let specularMask =
    select(normalSample.a, 1.0, (flags1 & SLSF1_MODEL_SPACE_NORMALS) != 0u) * draw.specular.a;

  // Receive_Shadows: the sun's cascaded shadow maps darken the surface.
  let receivesShadows = (flags1 & SLSF1_RECEIVE_SHADOWS) != 0u;
  let shadow = select(1.0, sunShadow(in.worldPos, safeNormalize(in.normal)), receivesShadows);
  let light = lightAt(n, in.worldPos, toCamera, glossiness, hasSpecular, shadow);
  let diffuseLight = light.diffuse;
  let specularLight = light.specular;

  var color = base * diffuseLight + draw.specular.rgb * specularLight * specularMask;

  if (shaderType == SHADER_GLOW && (flags2 & SLSF2_GLOW_MAP) != 0u) {
    color += glow.rgb * draw.emissive.rgb;
  } else if ((flags1 & SLSF1_OWN_EMIT) != 0u) {
    color += draw.emissive.rgb * base;
  }

  if ((flags1 & SLSF1_ENVIRONMENT_MAPPING) != 0u &&
      (shaderType == SHADER_ENVIRONMENT_MAP || shaderType == SHADER_EYE_ENVIRONMENT_MAP)) {
    let r = reflect(-toCamera, n);
    // Skyrim is Z-up; cubemaps use Y-up face orientation.
    let env = textureSampleLevel(envMap, linearSampler, vec3f(r.x, r.z, r.y), 0.0).rgb;
    color += env * envMaskSample.r * draw.params.w;
  }

  switch (frame.counts.z) {
    case 1u: {
      return vec4f(base, alpha);
    }
    case 2u: {
      return vec4f(n * 0.5 + 0.5, alpha);
    }
    case 3u: {
      return vec4f(diffuseLight, alpha);
    }
    case 4u: {
      return vec4f(in.color.rgb, alpha);
    }
    case 5u: {
      return vec4f(safeNormalize(in.normal) * 0.5 + 0.5, alpha);
    }
    default: {
      // Sky objects (weather sky statics) are not fogged.
      let fogged = select(applyFog(color, in.worldPos), color, (draw.flags.z & 0x10000u) != 0u);
      return vec4f(fogged, alpha);
    }
  }
}
