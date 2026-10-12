# Rendering

How a frame is put together (`src/render/renderer.ts`). Everything is drawn in HDR
(`rgba16float`) with 4× MSAA and reversed-Z depth (near = 1, far = 0, infinite far plane).

1. **Sun shadow map** (exteriors): 4 cascades, 2048² each (`shadow-cascades.ts`). The view
   up to 8000 units (fShadowDistance, Ultra) is cut at 700/1800/4000/8000; each slice gets an
   orthographic view from the sun around its bounding sphere, snapped to whole texels (no
   shimmer), reaching 20000 units towards the sun for casters. Cascades 1–2 update every
   frame, 3 every second and 4 every fourth frame; the shader samples each with the matrix it
   was rendered with. Casters: terrain and parts with `Cast_Shadows` (SLSF1 `0x200`), alpha
   tested where their NiAlphaProperty tests; not LOD; objects smaller than 3 texels of a
   cascade are left out. Receivers (`Receive_Shadows`, SLSF1 `0x100`, and terrain) take 3×3
   PCF with a normal offset of 1.5 texels; the last cascade fades out over its last tenth.
2. **Opaque pass:** the shell backdrop or the sky, terrain, tree LOD billboards and the opaque
   parts of all scenes (LOD and cells). Parts and terrain quadrants outside the view frustum
   are skipped (bounding spheres).
3. **Copies for water:** if any water is in view, the resolved colour is copied and the
   multisampled depth resolved (sample 0) into an `r32float` texture.
4. **Water and blended pass:** water surfaces (they read the copies), then blended parts of
   all scenes back to front.
5. **Post-processing** (`post.ts`): the imagespace's eye adaptation, bloom, tone curve and
   grading into the canvas (see [formats/esm.md](formats/esm.md#imagespaces)).

**Frame uniforms** (`shaders/frame.wgsl`, group 0 of every world shader): camera, sun
direction and colour (times the imagespace's sunlight scale), directional ambient, fog,
point lights (storage buffer), time, the LOD mask of loaded cells (7×7 bits, see
[formats/lod.md](formats/lod.md)), the shadow cascades, the shadow map and its comparison
sampler. The terrain shader samples 17 textures (8 diffuse, 8 normal maps, the shadow map),
more than WebGPU's default of 16, so the device asks for the adapter's limit (up to 32).
