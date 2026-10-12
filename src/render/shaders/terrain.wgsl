// Landscape: up to 8 textures blended by per-vertex weights (the base texture and the
// layers painted over it), with their normal maps, times the vertex colour, lit like
// objects. Prepended with frame.wgsl. ASCII only.
// TODO(M4): parallax, specular from the LTEX, snow, LOD blending.

// Landscape textures repeat 6 times per cell (fLandTextureTilingMult 3 per quadrant).
const TILE_SIZE = 4096.0 / 6.0;

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

@fragment
fn fs_main(in: TerrainOut) -> @location(0) vec4f {
  // Image up (-v) is north (+Y), image right is east (+X).
  let uv = vec2f(in.worldPos.x, -in.worldPos.y) / TILE_SIZE;
  let w0 = in.weights0;
  let w1 = in.weights1;
  let base =
    textureSample(diffuse0, terrainSampler, uv).rgb * w0.x +
    textureSample(diffuse1, terrainSampler, uv).rgb * w0.y +
    textureSample(diffuse2, terrainSampler, uv).rgb * w0.z +
    textureSample(diffuse3, terrainSampler, uv).rgb * w0.w +
    textureSample(diffuse4, terrainSampler, uv).rgb * w1.x +
    textureSample(diffuse5, terrainSampler, uv).rgb * w1.y +
    textureSample(diffuse6, terrainSampler, uv).rgb * w1.z +
    textureSample(diffuse7, terrainSampler, uv).rgb * w1.w;
  let mapped =
    (textureSample(normal0, terrainSampler, uv).rgb * w0.x +
     textureSample(normal1, terrainSampler, uv).rgb * w0.y +
     textureSample(normal2, terrainSampler, uv).rgb * w0.z +
     textureSample(normal3, terrainSampler, uv).rgb * w0.w +
     textureSample(normal4, terrainSampler, uv).rgb * w1.x +
     textureSample(normal5, terrainSampler, uv).rgb * w1.y +
     textureSample(normal6, terrainSampler, uv).rgb * w1.z +
     textureSample(normal7, terrainSampler, uv).rgb * w1.w) * 2.0 - 1.0;

  let geometric = safeNormalize(in.normal);
  let tangent = safeNormalize(vec3f(1.0, 0.0, 0.0) - geometric * geometric.x);
  let bitangent = cross(geometric, tangent);
  let n = safeNormalize(mapped.x * tangent + mapped.y * bitangent + mapped.z * geometric);

  let albedo = base * in.color;
  let toCamera = safeNormalize(frame.cameraPos.xyz - in.worldPos);
  let light = lightAt(n, in.worldPos, toCamera, 1.0, false);
  switch (frame.counts.z) {
    case 1u: {
      return vec4f(albedo, 1.0);
    }
    case 2u: {
      return vec4f(n * 0.5 + 0.5, 1.0);
    }
    case 3u: {
      return vec4f(light.diffuse, 1.0);
    }
    case 4u: {
      return vec4f(in.color, 1.0);
    }
    case 5u: {
      return vec4f(geometric * 0.5 + 0.5, 1.0);
    }
    default: {
      return vec4f(applyFog(albedo * light.diffuse, in.worldPos), 1.0);
    }
  }
}
