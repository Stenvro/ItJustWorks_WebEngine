// Distant trees: one billboard per tree from the worldspace's tree LOD atlas, turned towards
// the camera around the vertical axis, alpha-tested, lit by the sun and ambient light.
// Prepended with frame.wgsl. ASCII only.

struct TreeType {
  // Width, height (game units), unused.
  size: vec4f,
  // Atlas rectangle: u0, v0 (top left), u1, v1 (bottom right).
  uv: vec4f,
};

@group(1) @binding(0) var<storage, read> treeTypes: array<TreeType>;
@group(1) @binding(1) var treeSampler: sampler;
@group(1) @binding(2) var treeAtlas: texture_2d<f32>;

struct TreeIn {
  // Position (base of the tree) and scale.
  @location(0) placement: vec4f,
  // Type index.
  @location(1) treeType: u32,
};

struct TreeOut {
  @builtin(position) position: vec4f,
  @location(0) worldPos: vec3f,
  @location(1) uv: vec2f,
  @location(2) normal: vec3f,
};

@vertex
fn vs_tree(input: TreeIn, @builtin(vertex_index) index: u32) -> TreeOut {
  var corners = array<vec2f, 6>(
    vec2f(-0.5, 0.0), vec2f(0.5, 0.0), vec2f(0.5, 1.0),
    vec2f(-0.5, 0.0), vec2f(0.5, 1.0), vec2f(-0.5, 1.0),
  );
  let corner = corners[index];
  let tree = treeTypes[input.treeType];
  let base = input.placement.xyz;
  let scale = input.placement.w;
  let toCamera = frame.cameraPos.xy - base.xy;
  let facing = safeNormalize(vec3f(toCamera, 0.0));
  let right = vec3f(-facing.y, facing.x, 0.0);
  let world = base + right * corner.x * tree.size.x * scale + vec3f(0.0, 0.0, corner.y * tree.size.y * scale);
  var out: TreeOut;
  out.position = frame.viewProj * vec4f(world, 1.0);
  out.worldPos = world;
  out.uv = vec2f(mix(tree.uv.x, tree.uv.z, corner.x + 0.5), mix(tree.uv.w, tree.uv.y, corner.y));
  // Lit like a crown seen from the camera's side, leaning up.
  out.normal = safeNormalize(facing + vec3f(0.0, 0.0, 0.6));
  return out;
}

@fragment
fn fs_tree(input: TreeOut) -> @location(0) vec4f {
  let texel = textureSample(treeAtlas, treeSampler, input.uv);
  if (texel.a < 0.5 || lodHidden(input.worldPos)) {
    discard;
  }
  let toCamera = safeNormalize(frame.cameraPos.xyz - input.worldPos);
  let light = lightAt(input.normal, input.worldPos, toCamera, 1.0, false);
  return vec4f(applyFog(texel.rgb * light.diffuse, input.worldPos), 1.0);
}
