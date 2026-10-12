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
   grading into the canvas (see [formats/esm.md](formats/esm.md#imagespaces)), then its depth
   of field (below).

**Frame uniforms** (`shaders/frame.wgsl`, group 0 of every world shader): camera, sun
direction and colour (times the imagespace's sunlight scale), directional ambient, fog,
point lights (storage buffer), time, the LOD mask of loaded cells (7×7 bits, see
[formats/lod.md](formats/lod.md)), the shadow cascades, the screen size and near plane, the
camera's right and up axes, the shadow map and its comparison sampler, the scene copies and a
clamping sampler. The terrain shader samples 21 textures (8 diffuse, 8 normal maps, the LOD
block texture and noise, the shadow map and the scene copies), more than WebGPU's default of
16, so the device asks for the adapter's limit (up to 32).

## Landscape

`shaders/terrain.wgsl`, as the vanilla landscape shader (Community Shaders' Lighting.hlsl,
LANDSCAPE and LOD_LAND_BLEND) does it:

1. Up to 8 textures blended by the vertex weights, × the vertex colour; their normal maps
   blended the same way. Gloss: the normal maps' alpha (mean 0.12 over the vanilla landscape
   maps), exponent: the blend of the land textures' SNAM.
2. Snow: a quadrant with a snow texture (LTEX INAM `0x1`) adds to every layer whose diffuse
   alpha is above zero its normal map sampled 4 times larger (1 / iLandscapeMultiNormalTilingFactor),
   combined by reoriented normal mapping. Snow mask = Σ snow flag × weight × diffuse alpha
   (bEnableSnowMask). Where the mask is above zero the specular gives way to the snow rim
   light and sparkles (below).
3. LOD blend: `1 − saturate(0.000375601 × (9625.6 − distance))` from the centre of the camera's
   cell (no blend within 6963 units, full at 9626: the outer ring of the 5 × 5 loaded cells)
   turns the land into the level-4 LOD terrain block's texture (`textures\terrain\<world>\
<world>.4.x.y.dds`, mapped by world position) × `0.8333 (p (0.37 − noise) + noise) + 0.37`
   (`textures\terrain\noise.dds` at 3 × the block UV, p from the LOD colour's brightness),
   flattens the normal and drops the gloss, so the loaded land meets the distant LOD without a
   seam. (The engine's UV factor 1/96 for the blend texture is applied to land UVs whose range
   is not documented; the level-4 block by world position is used here.)
4. The vanilla landscape shader has no parallax.

## Snow

The engine's "improved snow" (bEnableImprovedSnow, `shaders/snow.wgsl`): snow surfaces write
a rim highlight and a mask into a snow buffer that its ambient-occlusion composite adds. Here
each shader adds them directly, with the game's default settings:

- Rim: `0.3 · (1 − saturate(geometry normal · v))³ · (1 − saturate(n · v))²`
  (fSnowRimLightIntensity, fSnowGeometrySpecPower, fSnowNormalSpecPower) × the mask, added to
  the lit colour before fog.
- Sparkles: fixed bright points in world space, `step(0.85, noise²)` of 3D simplex noise at
  `0.07 × 6 × position` (fSparklesDensity, fSparklesSize, fSparklesSpecularPower 2), × lerp(sun
  shadow, 1, 0.25) (fShadowSparkleIntensity), fading out over 1000 units (fSparklesMaxDistance),
  × the mask, added after fog.
- TODO(M4): the subsurface scattering pass (ISSnowSSS: a depth-aware blur of the snow tinted
  by fSnowSSSColor, fSnowSSSStrength 50, fSnowSSSDepthDiff 0.5) needs the snow mask in a
  render target.

## Depth of field

The imagespace's depth of field (IMGS DNAM), as the engine's ISDepthOfField shader does it for
weathers ("distant" blur, `shaders/dof.wgsl`), on the graded image: a copy at half the size is
blurred (Gaussian, 1 + blur radius pixels; TODO(M13): the engine's taps per radius), then each
pixel turns into it by `saturate((distance − focus distance) / range) × strength`, the
distance from the opaque scene's depth. Where the sky is not blurred ("no sky"), a sky pixel
is blurred only beside geometry: by the average depth 3 pixels around it and at half strength
for the share of sky there, so mountain silhouettes soften. The engine's dynamic depth of
field (bDynamicDOF: focus on what the camera looks at) is TODO(M4).

## Lighting shader

BSLightingShaderProperty (`shaders/lighting.wgsl`) follows the engine's lighting pixel shader
as Community Shaders' near-vanilla Lighting.hlsl (v0.7.4) reproduces it, with the material
constants of Nukem9's decompiled `BSLightingShader`:

1. Normal: tangent space, or model space stored **x, z, y** (MSN materials and LOD land).
   Specular mask: the normal map's alpha, or with model-space normals the specular map (texture
   set slot 7).
2. Lights (sun with its shadow, point lights fading as 1 − (d/r)²): diffuse `saturate(n·l)`;
   specular `pow(saturate(h·n), glossiness)` without an n·l test. Anisotropic (hair):
   `h·n` becomes 1 − |a·l − a·h| with a = normalize(0.5 n + vertex normal), times 0.7 l.z.
   With the unshadowed light colour: soft lighting (`SLSF2 0x2000000`, smoothstep of
   (rolloff + n·l) / (1 + rolloff) minus that of n·l; for point lights the engine passes the
   unnormalized light vector), rim lighting (`0x4000000`, (1 − n·v)^power · saturate(v·−l)),
   both times the rim / soft map (slot 2), and back lighting (`0x8000000`, saturate(−n·l)
   times the back light map, slot 7). Missing maps are black (the engine binds no texture).
3. Colour: (directional ambient + emit + lights) × diffuse, then × vertex colours (hair: the
   tint by the vertex green, `(g · (tint − 1) + 1)`; skin tint: the facegen RGB tint formula).
   Emit is the emissive colour with Own_Emit, or the emissive colour × the glow map (type 2
   with SLSF2 Glow_Map): so glow is coloured by the diffuse texture.
4. Multi-layer parallax (type 11): the inner layer (slot 6) seen through the surface, offset by
   (thickness × layer alpha / 1024) along the view reflected about the scaled normal map, blended
   by saturate(n·v) × (1 − diffuse alpha); it has the environment map too.
5. Environment map: the cube map in the reflection, times the environment mask (else the
   specular mask) × the scale, **times the diffuse light** (dark where the surface is dark).
6. Specular: lights × specular mask × specular colour × strength.
7. Directional materials (snow, ash, ice on statics and object LOD) and their multi-index snow
   pass: see [formats/esm.md](formats/esm.md#directional-materials). Objects counted as snow
   (STAT flag or SLSF2 `0x10000000`) get the improved snow of `shaders/snow.wgsl` instead of
   their specular: the rim light before fog and the sparkles after it, times the snow mask
   (the engine's SnowParameters.y): the projected material's blend weight, 1 in the
   multi-index snow pass, else the diffuse alpha. TODO(M4): the snow subsurface scattering
   (ISSnowSSS), which needs the mask as a screen buffer.
8. LOD landscape noise (type 18): diffuse × 0.8333 (p (0.37 − noise) + noise) + 0.37 with
   `textures\terrain\noise.dds` at 3 × UV and p from the colour's brightness.
9. Leaf flutter (SLSF2 Tree_Anim, `leafShift` in common.wgsl, the engine's
   GetTreeShiftVector): a vertex moves along its normal by
   `(e(0.1 t) + 0.1 e(0.25 t)) · amplitude · vertex alpha`, e = a smoothed triangle wave of
   `t · frequency · wind` plus the sum of the vertex's coordinates, t = 6 × seconds. Leaf
   amplitude and frequency come from the TREE record (1 and 1 without one; without a leaf
   animation root the timer stands still); the amplitude fades out between 3600 and 4600 units
   from the camera (fLeafAnimDampenDistStart / End); wind = the weather's wind speed (0..1).
   The vertex alpha is the leaf weight, not transparency.

Parallax (type 3, 11 vanilla shapes in Markarth): the height map (slot 3) shifts the texture
coordinates by (height × 0.08 − 0.04) along the x and y of the **model-space** view direction,
as the vanilla pixel shader does (aers' Skyrim-SE-Shader-Tools decompile; a correct version
would use the tangent-space direction; the bug is kept). Community Shaders 0.7.4 leaves this
out (it replaces parallax with its own), so that source is not used here.

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

**Refraction** (SLSF1 `0x8000` on the lighting shader: heat haze over fires and torches,
magic barriers, mist; about 360 vanilla shapes, strength 0.05–1): the engine draws these shapes only
into a refraction buffer (normal map direction, strength, alpha as mask) and an image-space pass
shifts the scene by normal.xy × 0.05 × strength (x mirrored), blended by the mask
(`ISRefraction` in the Community Shaders sources). Here the shapes draw that shifted copy of
the opaque scene directly (`shaders/refraction.wgsl`), blended by their mask in the blended
pass; their UV controllers scroll the noise. Fire_Refraction (`0x10000`) without Refraction (about
50 shapes) is drawn as a regular surface: what it changes in the engine is not documented
(TODO(M13)).

## Decals

Placed decals (`decals.ts`, `shaders/decal.wgsl`; records in
[formats/esm.md](formats/esm.md#decals)) are drawn first in the blended pass as screen-space
projections: the back faces of each decal's box (unit cube times its placement: X width, Y
projection, Z height) cover its area even with the camera inside; for every pixel the opaque
surface behind it comes from the scene depth copy (`inverseViewProj` of the frame), and where
that point lies inside the box the decal's texture is drawn on it, lit like the surface: its
normal from the depth's screen derivatives, turned by the decal's normal map in the decal's
frame, with ambient, sun, shadows and point lights, then fog. Surfaces running along the
projection fade out (no smearing down walls). Alpha testing discards below 0.5; blending uses
the texture's alpha. One instanced draw per texture set; decals out of view are skipped.

## Precipitation

Rain and snow (`precipitation.ts`, `shaders/precipitation.wgsl`), as the engine's particle
shader does it: a box of the SPGD's size around the camera holds density × 1024 particles
(at most 65536). Each particle has a fixed place in an endless lattice that falls with the
gravity velocity and drifts with the weather's wind (rain 15%, snow 50% of it); the copy
inside the box around the camera is drawn, fading near the box's faces where particles wrap.
Rain is a streak along the fall (as long as its size plus a frame's fall at 30 fps), snow a
camera-facing quad that turns and circles its fall line (centre offset min..max). Each
particle shows one random frame of the texture's atlas, lit by the ambient light from above
and half the sunlight, faded where it nears the opaque scene, fogged.

**Occlusion** (no rain under roofs): the scene's shadow casters and the terrain rendered from
straight above around the camera (orthographic, ±8192 units in height) into layer 4 of the
shadow map — redrawn when the camera moves a quarter of the map or every 120 frames. A
particle below anything in that map is hidden. Snow quads reach the SPGD size in world units
from their centre (the engine offsets the corners in clip space by size × the projection
scale, CS Particle.hlsl ENVCUBE); rain drops are scaled × 50 to match the texture's thin line:
TODO(M13) calibrate rain against the original.

## Memory

The session keeps the models and textures it loads (`game-session.ts`, `texture-cache.ts`)
and counts their GPU bytes (vertex and index buffers; all mips of every texture); the status
bar shows the total against the budget (`MEMORY_BUDGET`, 2 GiB). Scenes and grass fields hold
the models they draw, models hold the textures they bind. While cells stream in and out the
world viewer trims the session four times a second: over budget, the least recently used
models that nothing draws are freed (they let go of their textures), then the textures no
model holds, down to 85% of the budget. Anything used in the last 10 seconds stays (a cell
may be about to place it), as do models attached to others as add-ons and textures never
held by a model (terrain, sky, water, decals, precipitation: few and shared). Freed models and
textures load again when a cell needs them.
