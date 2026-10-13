// Adapted from Community Shaders (GPL-3.0); see THIRD_PARTY_NOTICES.md.
// Landscape: up to 8 textures blended by per-vertex weights (the base texture and the
// layers painted over it), with their normal maps, times the vertex colour, lit like
// objects, as the engine's landscape shader does it (Community Shaders' replica of the vanilla
// Lighting.hlsl, LANDSCAPE): specular from the normal maps' alpha with the land textures'
// exponents (LTEX SNAM); snow (LTEX flagged as snow) with a second, 4 times larger normal map
// sample and the improved-snow rim and sparkles; and near the edge of the loaded cells a blend
// towards the LOD terrain's texture (LOD_LAND_BLEND) so the seam with the distant land
// disappears. The vanilla landscape shader has no parallax. Prepended with frame.wgsl and
// snow.wgsl. ASCII only.

// Landscape textures repeat 6 times per cell (fLandTextureTilingMult 3 per quadrant).
const TILE_SIZE = 4096.0 / 6.0;
// Snow textures add their normal map at 1 / iLandscapeMultiNormalTilingFactor (4) the tiling.
const SNOW_NORMAL_TILING = 0.25;
// LOD blend: from this distance to the loaded grid's centre the land turns into its LOD
// texture, fully at the second (vertex shader constants of the vanilla landscape shader).
const LOD_BLEND_SCALE = 0.000375600968;
const LOD_BLEND_END = 9625.59961;

struct TerrainMaterial {
  // Specular exponent (LTEX SNAM) per texture slot.
  specularPower: array<vec4f, 2>,
  // 1 where the slot's land texture is snow (LTEX INAM 0x1).
  snow: array<vec4f, 2>,
  // The level-4 LOD terrain block the cell lies in: south-west corner (world xy), size,
  // and w = 1 if its texture exists.
  lodBlock: vec4f,
  // x: 1 if a texture of the quadrant is snow (the engine's snow technique).
  flags: vec4f,
};

@group(1) @binding(0) var terrainSampler: sampler;
@group(1) @binding(1) var diffuse0: texture_2d<f32>;
@group(1) @binding(2) var diffuse1: texture_2d<f32>;
@group(1) @binding(3) var diffuse2: texture_2d<f32>;
@group(1) @binding(4) var diffuse3: texture_2d<f32>;
@group(1) @binding(5) var diffuse4: texture_2d<f32>;
@group(1) @binding(6) var diffuse5: texture_2d<f32>;
@group(1) @binding(7) var diffuse6: texture_2d<f32>;
@group(1) @binding(8) var diffuse7: texture_2d<f32>;
@group(1) @binding(9) var normal0: texture_2d<f32>;
@group(1) @binding(10) var normal1: texture_2d<f32>;
@group(1) @binding(11) var normal2: texture_2d<f32>;
@group(1) @binding(12) var normal3: texture_2d<f32>;
@group(1) @binding(13) var normal4: texture_2d<f32>;
@group(1) @binding(14) var normal5: texture_2d<f32>;
@group(1) @binding(15) var normal6: texture_2d<f32>;
@group(1) @binding(16) var normal7: texture_2d<f32>;
@group(1) @binding(17) var<uniform> material: TerrainMaterial;
// The LOD terrain block's texture and the terrain noise (LOD blend).
@group(1) @binding(18) var lodDiffuse: texture_2d<f32>;
@group(1) @binding(19) var terrainNoise: texture_2d<f32>;

struct TerrainIn {
  @location(0) position: vec3f,
  @location(1) normal: vec4f,
  @location(2) color: vec4f,
  @location(3) weights0: vec4f,
  @location(4) weights1: vec4f,
};

struct TerrainOut {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) normal: vec3f,
  @location(2) color: vec3f,
  @location(3) weights0: vec4f,
  @location(4) weights1: vec4f,
};

// The colour and the G-buffer (normal and snow mask, see gbuffer.ts).
struct TerrainPixel {
  @location(0) color: vec4f,
  @location(1) gbuffer: vec4f,
};

@vertex
fn vs_main(in: TerrainIn) -> TerrainOut {
  var out: TerrainOut;
  out.position = frame.viewProj * vec4f(in.position, 1.0);
  out.worldPos = in.position;
  out.normal = safeNormalize(in.normal.xyz);
  out.color = in.color.rgb;
  out.weights0 = in.weights0;
  out.weights1 = in.weights1;
  return out;
}

// A layer's tangent-space normal; on snow quadrants combined with a 4 times larger sample of
// the same map wherever the layer's diffuse alpha (the snow mask) is above zero.
fn landNormal(sample: vec4f, large: vec4f, snowMask: f32) -> vec3f {
  var n = sample.rgb * 2.0 - 1.0;
  if (material.flags.x > 0.5 && snowMask > 1e-5) {
    let detail = vec3f(-1.0, -1.0, 1.0) * (large.rgb * 2.0 - 1.0);
    n.z += 1.0;
    let projection = dot(n, detail);
    n = safeNormalize(n * projection - detail * n.z);
  }
  return n;
}

fn slotValue(values: array<vec4f, 2>, w0: vec4f, w1: vec4f) -> f32 {
  return dot(values[0], w0) + dot(values[1], w1);
}

// How much the LOD terrain colour takes over (smoothstep of its brightness, 0.8 at most).
fn lodLandBlendParameter(color: vec3f) -> f32 {
  let t = clamp(1.6666666 * (dot(color, vec3f(0.55)) - 0.4), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t) * 0.8;
}

@fragment
fn fs_main(in: TerrainOut) -> TerrainPixel {
  // Image up (-v) is north (+Y), image right is east (+X).
  let uv = vec2f(in.worldPos.x, -in.worldPos.y) / TILE_SIZE;
  let largeUv = uv * SNOW_NORMAL_TILING;
  let w0 = in.weights0;
  let w1 = in.weights1;
  let d0 = textureSample(diffuse0, terrainSampler, uv);
  let d1 = textureSample(diffuse1, terrainSampler, uv);
  let d2 = textureSample(diffuse2, terrainSampler, uv);
  let d3 = textureSample(diffuse3, terrainSampler, uv);
  let d4 = textureSample(diffuse4, terrainSampler, uv);
  let d5 = textureSample(diffuse5, terrainSampler, uv);
  let d6 = textureSample(diffuse6, terrainSampler, uv);
  let d7 = textureSample(diffuse7, terrainSampler, uv);
  let n0 = textureSample(normal0, terrainSampler, uv);
  let n1 = textureSample(normal1, terrainSampler, uv);
  let n2 = textureSample(normal2, terrainSampler, uv);
  let n3 = textureSample(normal3, terrainSampler, uv);
  let n4 = textureSample(normal4, terrainSampler, uv);
  let n5 = textureSample(normal5, terrainSampler, uv);
  let n6 = textureSample(normal6, terrainSampler, uv);
  let n7 = textureSample(normal7, terrainSampler, uv);
  // The large normal samples only matter on snow quadrants (a uniform branch).
  var l0 = vec4f(0.5, 0.5, 1.0, 0.0);
  var l1 = l0;
  var l2 = l0;
  var l3 = l0;
  var l4 = l0;
  var l5 = l0;
  var l6 = l0;
  var l7 = l0;
  if (material.flags.x > 0.5) {
    l0 = textureSample(normal0, terrainSampler, largeUv);
    l1 = textureSample(normal1, terrainSampler, largeUv);
    l2 = textureSample(normal2, terrainSampler, largeUv);
    l3 = textureSample(normal3, terrainSampler, largeUv);
    l4 = textureSample(normal4, terrainSampler, largeUv);
    l5 = textureSample(normal5, terrainSampler, largeUv);
    l6 = textureSample(normal6, terrainSampler, largeUv);
    l7 = textureSample(normal7, terrainSampler, largeUv);
  }
  // LOD blend near the edge of the loaded cells (the grid is centred on the camera's cell).
  let lodBlock = material.lodBlock;
  let lodUv = vec2f(
    (in.worldPos.x - lodBlock.x) / max(lodBlock.z, 1.0),
    1.0 - (in.worldPos.y - lodBlock.y) / max(lodBlock.z, 1.0),
  );
  let lodColor = textureSample(lodDiffuse, terrainSampler, lodUv);
  let lodNoise = textureSample(terrainNoise, terrainSampler, lodUv * 3.0).x;

  var base =
    d0.rgb * w0.x + d1.rgb * w0.y + d2.rgb * w0.z + d3.rgb * w0.w +
    d4.rgb * w1.x + d5.rgb * w1.y + d6.rgb * w1.z + d7.rgb * w1.w;
  var mapped =
    landNormal(n0, l0, d0.a) * w0.x + landNormal(n1, l1, d1.a) * w0.y +
    landNormal(n2, l2, d2.a) * w0.z + landNormal(n3, l3, d3.a) * w0.w +
    landNormal(n4, l4, d4.a) * w1.x + landNormal(n5, l5, d5.a) * w1.y +
    landNormal(n6, l6, d6.a) * w1.z + landNormal(n7, l7, d7.a) * w1.w;
  var glossiness =
    n0.a * w0.x + n1.a * w0.y + n2.a * w0.z + n3.a * w0.w +
    n4.a * w1.x + n5.a * w1.y + n6.a * w1.z + n7.a * w1.w;
  let shininess = slotValue(material.specularPower, w0, w1);
  // Snow mask: the snow textures' diffuse alpha (bEnableSnowMask).
  let snowMask =
    material.snow[0].x * w0.x * d0.a + material.snow[0].y * w0.y * d1.a +
    material.snow[0].z * w0.z * d2.a + material.snow[0].w * w0.w * d3.a +
    material.snow[1].x * w1.x * d4.a + material.snow[1].y * w1.y * d5.a +
    material.snow[1].z * w1.z * d6.a + material.snow[1].w * w1.w * d7.a;

  if (lodBlock.w > 0.5) {
    let gridCenter = (vec2f(frame.lodMask.xy) + 3.5) * 4096.0;
    let blend = 1.0 - clamp(LOD_BLEND_SCALE * (LOD_BLEND_END - length(gridCenter - in.worldPos.xy)), 0.0, 1.0);
    let parameter = lodLandBlendParameter(lodColor.rgb);
    let fade = 0.8333333 * (parameter * (0.37 - lodNoise) + lodNoise) + 0.37;
    base = mix(base, lodColor.rgb * fade, blend);
    mapped = mix(mapped, vec3f(0.0, 0.0, 1.0), blend);
    glossiness = mix(glossiness, 0.0, blend);
  }

  let geometric = safeNormalize(in.normal);
  let tangent = safeNormalize(vec3f(1.0, 0.0, 0.0) - geometric * geometric.x);
  let bitangent = cross(geometric, tangent);
  let n = safeNormalize(mapped.x * tangent + mapped.y * bitangent + mapped.z * geometric);

  let albedo = base * in.color;
  let toCamera = safeNormalize(frame.cameraPos.xyz - in.worldPos);
  let shadow = sunShadow(in.worldPos, in.normal);
  let light = lightAt(n, in.worldPos, toCamera, max(shininess, 1.0), true, shadow);
  var color = albedo * light.diffuse;
  // Snow has the rim highlight instead of its specular.
  if (snowMask > 0.0) {
    color += vec3f(snowRimSpecular(geometric, n, toCamera) * snowMask);
  } else {
    color += light.specular * glossiness;
  }
  var out: TerrainPixel;
  out.gbuffer = gbufferValue(n, snowMask);
  switch (frame.counts.z) {
    case 1u: {
      out.color = vec4f(albedo, 1.0);
    }
    case 2u: {
      out.color = vec4f(n * 0.5 + 0.5, 1.0);
    }
    case 3u: {
      out.color = vec4f(light.diffuse, 1.0);
    }
    case 4u: {
      out.color = vec4f(in.color, 1.0);
    }
    case 5u: {
      out.color = vec4f(geometric * 0.5 + 0.5, 1.0);
    }
    default: {
      out.color = vec4f(
        applyFog(color, in.worldPos) + snowSparkles(in.worldPos, shadow) * snowMask,
        1.0,
      );
    }
  }
  return out;
}
