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
3. **Copies of the opaque scene:** when water, blended parts or particles are in view, the
   resolved colour is copied and the multisampled depth resolved (sample 0) into an
   `r32float` texture. Both are bound in the frame group (`sceneColor`, `sceneDepth`).
4. **Water and blended pass:** water surfaces, then blended parts and particle systems of all
   scenes back to front (by bounding sphere centre).
5. **Post-processing** (`post.ts`): the imagespace's eye adaptation, bloom, tone curve and
   grading into the canvas (see [formats/esm.md](formats/esm.md#imagespaces)).

**Frame uniforms** (`shaders/frame.wgsl`, group 0 of every world shader): camera, sun
direction and colour (times the imagespace's sunlight scale), directional ambient, fog,
point lights (storage buffer), time, the LOD mask of loaded cells (7×7 bits, see
[formats/lod.md](formats/lod.md)), the shadow cascades, the screen size and near plane, the
camera's right and up axes, the shadow map and its comparison sampler, the scene copies and a
clamping sampler. The terrain shader samples 17 textures (8 diffuse, 8 normal maps, the shadow
map), more than WebGPU's default of 16, so the device asks for the adapter's limit (up to 32).

## Effects and particles

BSEffectShaderProperty (`shaders/effect.wgsl`, also used for particles by
`shaders/particle.wgsl`) follows the engine's effect pixel shader (as documented by the
Community Shaders sources):

1. Colour = source texture × base colour × vertex colour (particles: the particle colour);
   alpha = texture alpha (1 with greyscale-to-palette alpha) × base and vertex alpha.
2. Falloff (SLSF1 `0x40`): opacity from start to stop opacity between the falloff angles
   (cosines) by how directly the surface faces the camera.
3. Soft effect (SLSF1 `0x40000000`, blended only): alpha fades over the soft falloff depth in
   front of the opaque scene (from `sceneDepth`), so smoke and glows do not cut into walls.
4. Material alpha (and its animated "alpha transparency").
5. Greyscale palette (SLSF1 `0x20` alpha, `0x10` colour): alpha = palette alpha at (texture
   alpha, alpha so far); colour = palette at (texture green, base × vertex red). Fire uses
   both: the particle colour fading from grey to black walks down the flame palette (white
   hot → orange → transparent red) while the alpha fade shrinks the flame. Palettes are
   sampled clamped (their rows must not wrap).
6. Colour × base colour scale; Effect_Lighting (SLSF2 `0x40000000`): blended towards colour
   × scene light (directional ambient, the sun at half strength even from behind — smoke
   scatters it — and point lights) by the lighting influence.
7. Alpha test, then fog: additive effects (destination factor ONE) fade out, others blend to
   the fog colour.

Draw uniforms of effects: base colour (emissive slot), base colour scale (params.w), lighting
influence and soft depth (specular slot). Texture clamp mode picks the sampler (bit 0 wraps U,
bit 1 wraps V).

**Particles** (`scene-renderer.ts`, `particle-sim.ts`): every placed particle system has its
own simulation; each frame the systems near the camera or in view update, and their particles
go into one instance buffer (16 floats each: position, half size, colour, atlas frame,
velocity or strip segment, rotation). One draw per system: six vertices per instance build a
quad facing the camera (the frame's camera axes, turned by the particle's rotation) or turned
along the velocity (aspect flag `0x1`, height scaled by the aspect ratio), or a ribbon segment
facing the camera for strip particles. Blended particles test but never write depth (their
quads overlap unsorted within a system).
