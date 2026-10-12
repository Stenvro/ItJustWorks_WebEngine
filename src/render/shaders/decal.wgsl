// Placed decals (TXST references): the back faces of each decal's projection box find the
// opaque surface behind every pixel in the scene depth copy, and where that point lies inside
// the box the decal texture is drawn on it, lit like the surface (reconstructed normal,
// turned by the decal's normal map). Appended to frame.wgsl. ASCII only.

const DECAL_ALPHA_BLENDING = 0x2u;
const DECAL_ALPHA_TESTING = 0x4u;

@group(1) @binding(0) var decalSampler: sampler;
@group(1) @binding(1) var decalDiffuse: texture_2d<f32>;
@group(1) @binding(2) var decalNormal: texture_2d<f32>;

struct DecalIn {
  @location(0) corner: vec3f,
  // The box: unit cube to world (columns).
  @location(1) box0: vec4f,
  @location(2) box1: vec4f,
  @location(3) box2: vec4f,
  @location(4) box3: vec4f,
  // World to the unit cube (rows of the inverse).
  @location(5) inverse0: vec4f,
  @location(6) inverse1: vec4f,
  @location(7) inverse2: vec4f,
  // Atlas variant: u, v, width, height.
  @location(8) rect: vec4f,
  // Colour (rgb) and shininess (a).
  @location(9) color: vec4f,
  // DecalFlag bits, specular (0/1), unused, unused.
  @location(10) params: vec4f,
};

struct DecalOut {
  @builtin(position) position: vec4f,
  @location(0) @interpolate(flat) inverse0: vec4f,
  @location(1) @interpolate(flat) inverse1: vec4f,
  @location(2) @interpolate(flat) inverse2: vec4f,
  @location(3) @interpolate(flat) rect: vec4f,
  @location(4) @interpolate(flat) color: vec4f,
  @location(5) @interpolate(flat) params: vec4f,
};

@vertex
fn vs_decal(in: DecalIn) -> DecalOut {
  let box = mat4x4f(in.box0, in.box1, in.box2, in.box3);
  var out: DecalOut;
  out.position = frame.viewProj * (box * vec4f(in.corner, 1.0));
  out.inverse0 = in.inverse0;
  out.inverse1 = in.inverse1;
  out.inverse2 = in.inverse2;
  out.rect = in.rect;
  out.color = in.color;
  out.params = in.params;
  return out;
}

@fragment
fn fs_decal(in: DecalOut) -> @location(0) vec4f {
  // The opaque surface behind this pixel.
  let size = vec2i(textureDimensions(sceneDepth));
  let pixel = clamp(vec2i(in.position.xy), vec2i(0), size - 1);
  let depth = textureLoad(sceneDepth, pixel, 0).r;
  let ndc = vec2f(in.position.x * frame.screen.x * 2.0 - 1.0, 1.0 - in.position.y * frame.screen.y * 2.0);
  let clip = frame.inverseViewProj * vec4f(ndc, depth, 1.0);
  let world = clip.xyz / clip.w;
  let local = vec3f(
    dot(in.inverse0, vec4f(world, 1.0)),
    dot(in.inverse1, vec4f(world, 1.0)),
    dot(in.inverse2, vec4f(world, 1.0)),
  );
  // Derivatives and samples in uniform control flow, before any discard.
  let surfaceNormal = cross(dpdy(world), dpdx(world));
  let uv = in.rect.xy + vec2f(local.x + 0.5, 0.5 - local.z) * in.rect.zw;
  let diffuse = textureSample(decalDiffuse, decalSampler, uv);
  let mapped = textureSample(decalNormal, decalSampler, uv);
  if (depth <= 0.0 || any(abs(local) > vec3f(0.5))) {
    discard;
  }

  let toCamera = normalize(frame.cameraPos.xyz - world);
  var n = safeNormalize(surfaceNormal);
  if (dot(n, toCamera) < 0.0) {
    n = -n;
  }
  // Surfaces running along the projection get none of the decal (no smearing on walls).
  let axis = safeNormalize(in.inverse1.xyz);
  let facing = abs(dot(n, axis));
  var alpha = diffuse.a * smoothstep(0.15, 0.35, facing);
  let flags = u32(in.params.x);
  if ((flags & DECAL_ALPHA_TESTING) != 0u) {
    if (diffuse.a < 0.5) {
      discard;
    }
    if ((flags & DECAL_ALPHA_BLENDING) == 0u) {
      alpha = smoothstep(0.15, 0.35, facing);
    }
  }
  if (alpha <= 0.003) {
    discard;
  }

  // The normal map in the decal's frame: X across, down the texture, out of the surface.
  let tangent = safeNormalize(in.inverse0.xyz - n * dot(in.inverse0.xyz, n));
  let bitangent = safeNormalize(cross(n, tangent));
  let m = mapped.xyz * 2.0 - 1.0;
  let bumped = safeNormalize(tangent * m.x - bitangent * m.y + n * m.z);
  let specular = in.params.y > 0.5 && in.color.a > 0.0;
  let light = lightAt(bumped, world, toCamera, max(in.color.a, 1.0), specular, sunShadow(world, n));
  let albedo = diffuse.rgb * in.color.rgb;
  let color = albedo * light.diffuse + light.specular * select(0.0, mapped.a, specular);
  return vec4f(applyFog(color, world), alpha);
}
