# Rendering completeness

"100" for rendering: everything the original draws is drawn as the original draws it, for every
case in the data (Skyrim.esm, Update, the three DLCs and the Creation Club files of the install).
This checklist has two parts:

1. **Systems** (below, kept by hand): the passes and features a sweep of the files cannot see.
2. **The data sweep** (generated, after it): every shader type, shader flag, sampled texture slot,
   alpha mode, shader controller variable, NIF block type and rendering-record subrecord the load
   order uses, with how many shapes or records use it. Regenerate it with
   `node tools/render-inventory.ts --markdown` (`--open` lists only what is used and not done);
   the statuses are kept in that tool's tables against `src/render/shaders` and the record
   readers in `src/world`.

An item is **done** only when every use in the data is drawn as the original draws it; **open**
items say why; **n/a** items draw nothing (data for other systems, slots the type and flags do
not sample, flags xEdit and nif.xml call unused).

## Count (2026-10-30, round 11)

| Part       | Items | Done | Open | n/a |
| ---------- | ----- | ---- | ---- | --- |
| Systems    | 79    | 74   | 5    | 0   |
| Data sweep | 465   | 426  | 1    | 38  |
| **Total**  | 544   | 500  | 6    | 38  |

Done in round 11, observed in the original: the image-based lens flare of bright lights
(bIBLFEnable, #33) as the engine's passes and its shader cache's shaders draw it: no list of
lights, the HDR scene's pixels with a channel above fIBLFLightsRangeDownshift; temporal
downsamples keeping the brightest tap to a quarter, 16 × 4 and 32 × 4; the lights filter;
near and far anamorphic streaks blurred three times by Gaussians of σ = r / 2 (a box at 8);
the bloom; the sum added to the scene as the composite shaders do. The lens count, dispersal,
burn, channel distortions and halo settings and Ramps.dds / Masks.dds are read and loaded but
drawn by nothing. Read but still open: the character light's slot 11 (#62) is filled by no
target: only projected-UV draws bind a texture there (ProjectedNoise.dds) and the state reset
empties it; which water gets which reflection (#77): outdoors one reflection of the world's
water height (sky, LOD, flagged references) and one of the sky alone for all other heights,
indoors one per plane of the flagged references (fExteriorWaterReflectionThreshold unused).

Done in round 10, all observed in the original: the water material's setup, which WATR value
the engine hands each of the water shader's constants (docs/rendering.md, "The material
setup"): the Reflectivity Amount is what mixes the reflected scene over the reflection colour
and the Reflection Magnitude what flattens the normal the cube is looked up about (ours had
them the other way round), the fog's exponent is max(4 × Fog Amount, 1), its far distance at
least 1 with the record's own range, the noise falloff clamped to 1..8191; the detail's floor
is a frame constant that is 0 in every pass drawing the world, and only the flow-map techniques
fade the normal to the first layer's with distance. Water reflects a cube map file in place of
a rendered cube where its world or interior cell names one that exists (CELL and WRLD XWEM,
bUseCubeMapReflections: 78 of the 81 interiors naming one, and the Forebears' Holdout, the
Ancestors' Glade and Apocrypha); interior water without one gets no cube. Read but still open:
the rivers' flow normals (NAM5) by the flow-map techniques' terms (the cell water's texture
coordinates and the composite flow map's placement unread); slot 11 of the lighting shader is
the renderer's shared texture for the character-light techniques (which target fills it
unread).

Done in round 9, all observed in the original's shader cache (its image-space shaders carry no
technique ids; they were matched by their resources and terms, the volumetric ones by the
engine's setup of their constants): the volumetric lighting's generate pass (the froxel read at
its index over the size, jittered a thousandth towards the frame's cube corner; the cascade by
view depth, one lookup, the first biased; the noise at 0.0125 / the density size, thinned to a
quarter over the 150 units above the camera; lit × phase × density in one value), the raymarch
as a plain sum of the slices, the composite (the sum × the intensity over the slice count, a
dither of a 2D simplex noise, then the temporal accumulation in screen space by the last
frame's composite where the pixel was, held back by the depth's change × 100), the blur across
the screen (five taps at 0, ±6, ±12 pixels, held at depth edges) and the apply; the noise
volume's simplex function (80 cells across, 21 × the sum + 0.5); the weather's VOLI intensity
replacing fVolumetricLightingIntensity (bVolumetricLightingUpdateWeather). The world map's
relief overlay as the LOD land shaders built for the map do it: the triplanar weights
max(((|n| − 0.2) × 7)³, 0.01), the snow share by the LOD land blend parameter, the overlay in
the surface's tangent frame mixed in fully on slopes and halfway on flat ground, the strengths
unread by the shader, and the map's colour pull towards the snow's floors. Read but still open:
the character light's luminance is one sample of the lighting shader's slot 11 at (1, 1) (#62:
which texture is bound there is unread).

Done in round 8, part B (scene graph, physics-driven, LOD), all observed in the original:
alternate textures (MODS, ARMO and ARMA's, DMDS) go into a model's shapes by their 3D index, not
by the name they carry: the model's geometry counted depth first from its root (every shape and
particle system, through every node's children in order), entries without an index skipped and
a later entry for an index winning; a shape with a lighting shader takes the texture set whole
(its empty slots become the slot's default), the engine's NullTextureSet (form 0x28) hides the
shape. A sweep of every record's swaps (ARMA's included) finds the index naming the shape of the
entry's name for 3,475 of 3,551; the rest carry stale names. Mesh particles' rigid bodies are the physics world's: a copy of the
particle node's body per particle, started at the particle's velocity and its rotation axis times
its speed, collide with the world's shapes and each other by their layers and leave the world with
their particle. LOD is in no cell's portal graph, so rooms and portals never cull it (as ours).
A ridden dragon's target lock: Jump locks the nearest of the actors within fTargetLockXYRange
(bTargetLockIsToggle: a press locks, the next lets go), Hotkey1 and Hotkey2 step back and on
through the list gathered at the lock, a target that no longer does gives way to the next one on.
Bone LOD's level per update: the camera's distance across the ground over the skeleton's scale
(times fBoneLODDistanceScale), never below the bones a paralyzed, dead, knocked down,
unconscious or seated actor needs (a hovering flier has no floor) (a far dragon measured in space with every bone after its toe frozen stalled the opening's
tower climb).

Done in round 7, part B (scene graph, physics-driven, LOD): the Havok float slots. Behavior
graphs now blend their clips' float tracks (a slot's value from the clips that have a track
for it, by their weights), and a model's NiFloatExtraData named `hkVis:<node>` makes a
visibility controller that hides that node and all below it while the slot is exactly 0 (the
held weapon, shield and hands' casting art of humans and falmer, the puzzle pieces and trap
parts of 30 animated objects); a draugr's skeleton has an hkVis:Weapon slot its model has no
controller for. No Havok skeleton has an hkPhoneme slot, so its controllers find none. Bone
LOD (BSBoneLODExtraData): beyond each level's distance from the camera its bone and those after
it in the skeleton no longer animate. Mesh particles (the dragon crash's rocks): one copy of
the mesh per particle, moved as a rigid body (gravity, damping, bouncing and sliding on the
ground under the effect by its body's restitution and friction); the physics world's shapes
are a new open row. Lag bones on models worn on a skeleton (the Daedric armour's and the
spriggans' trailing effects). NiBSBoneLODController is an old export's: n/a.

Done in round 8, part A, all observed in the original: the built-in texture each slot of each
lighting material takes when its texture is missing (a missing diffuse map shows the default
normal map's lavender; glow maps white, FaceGen tint grey, ...); Screendoor_Alpha_Fade's shapes
blend while they fade, without the shadow mask; the refraction normal pass's terms and
Fire_Refraction's falloff variant (read from the shader cache's utility techniques, which carry
their technique ids in the cache's entry headers); WTHR LNAM (the cloud layer count) and NAM3 /
NAM2 (the sun and moon glare colours of the old FX weathers), with NAM0's missing colours filled
as the original does. The water reflection's cost against the original's cube (512² half-float
faces, two redrawn a frame): ours redraws one 256² face a frame and a new plane's faces two a
frame (never all five at once), culls the tree LOD blocks per face and lists each scene's
reflected and water draws once, with per-face counts in `Renderer.reflectionStats`.

Done in round 7, part A (lights, shader terms, flags), all observed in the original: a
geometry's light list names lights in the order they joined the scene (never by strength), shadow
lights apart; particle systems keep their own lists; an effect's pass names at most four lights
and never a shadow light; lights whose reference does not light landscape (REFR `0x20000`) leave
land unlit. Eyes reflect and take their ambient about the direction from their reflection centre
(the vertex's eye data picks the left or right centre). Sparkle snow (type 14) draws with the
sparkle technique, whose noise is the projected normal detail map; every vanilla use carries Snow,
whose variant has no sparkles. Fire_Refraction and Screendoor_Alpha_Fade are now read (their
rules below, both still open); the effect shader's Own_Emit and No_Fade are read by nothing.

Round 6, part A: the water's reflection pass. The original's shader cache
(shadersfx\shaders011.fxp, DirectX 11 bytecode) turned out readable: every one of its 400 water
pixel shaders looks its reflection up in a cube by the reflected view direction (with the
screen-space reflection over it) and none samples a planar texture, so the pass is a cube rendered
from the camera mirrored under the nearest water's plane: the sky, the land and its LOD, tree and
object LOD and the 17 references flagged Reflected By Auto Water (`node tools/water-info.ts
--reflected`; no XPWR entry names a reflecting water). The water shader now has the cache's
terms (fog, body colour, depth properties by the fog's far distance, the normal's layering,
refraction by the shifted surface point, the reflection mix, Schlick's fresnel, the sun's
specular along the reflected view, the sparkle from a fixed slant). The world map's relief
overlay is compiled into LOD land's pipelines only (an override constant), so no other pipeline
carries its six samples.

Done in round 6 (scene graph, controllers, camera, LOD): the dragon-riding camera
(DragonCameraState: the dragon's shoulder offsets, the view turning with the dragon, the ease to
and from a locked target over fDragonCameraDollyTime, bDragonCameraTargetPlayer); first person's
near plane (fNear1stPersonDistance, 5) and depth band (f1stPersonFarDepthRange, 0.01), its
particle systems drawn in that band; full LOD references fading as the sky cell's type
(fSkyCellRefFadeDistance by fLODFadeOutMultSkyCell); motion along paths (NiPathInterpolator: the
critters' flights, the kill cameras' base paths); look-ats; the kill cameras' camera models
(their root's keyed place and the NiCamera's animated field of view). NiFloatExtraData turned
out to name the Havok float slots the engine's visibility and phoneme controllers read from the
Havok pose (TwistOverride, Pauldron Override and Orientation are named nowhere in the
executable): n/a, with the float slots themselves a new open system row.

Round 5: skinned decals on actors (the hit shape's triangles in the decal's box
copied into a decal shape skinned to the same bones, under the original's limits: 100 living,
25 made a frame, 25 per actor, none beyond 800 units of the camera); lag bones on placed and
held models (effects, spells, torches: a lag state per instance, the parts and particle emitters
under a lag node trailing that instance's motion; BSLagBoneController stays open for armour hung
on a skeleton); the volumetric volume's cost (GPU timestamps per pass, bind groups kept between
frames, the blur in one pass through workgroup memory, the composite's one trilinear sample).

Round 4: volumetric lighting as the original's froxel volume (its size by quality,
the slices spread over clip depth by the range factor, the noise drifting with the wind and
falling, the first two cascades' shadows, the jitter, the temporal blend of 0.75, gathered slice
by slice, blurred and composited by each pixel's depth) in place of the screen-space god rays;
the world map's relief overlay on its LOD land. BSDecalPlacementVectorExtraData turned out to be
editor data (0-2 points per file, on bodies, armour, furniture and walls) the original loads and
never reads: n/a. Round 3 did the lighting shader's own distance fades, the fades over time by
the original's thresholds, LOD switching and lag bones on skeletons.

## Next biggest open items

1. **Bone LOD for actors the camera does not see** and the kill cameras' own turns and the bone a shot's
   location is measured from (camera and animation rules still inferred).
2. **WATR NAM5** (the flow-map techniques' terms are read; the cell water's texture coordinates
   and the composite flow map's placement unread); the sky-only second reflection and the
   interior planes' reflections of their flagged references; land's lists of seven per quad;
   focus maps of their actor alone; the character light's slot 11 by the draw order; the
   underwater colour.
3. Geometry decals on rigid worn shapes (ours project).

## Systems

| #   | Item                                                               | Status | Where / why                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Per-object light lists (7 point lights, 4 shadow lights)           | done   | light-lists.ts                                                                                                                                                                                                                                                                                                                                 |
| 2   | The order of a geometry's own light list                           | done   | light-lists.ts: the order lights joined the scene (PointLight.order), shadow lights first                                                                                                                                                                                                                                                      |
| 3   | Land's own light lists (lights flagged to light land)              | open   | the flag is read (frame.wgsl landLightAt); land keeps no lists of seven per quad yet                                                                                                                                                                                                                                                           |
| 4   | Particle systems' own light lists                                  | done   | scene-renderer #chooseSlotLights by the particles' bound (an effect's list)                                                                                                                                                                                                                                                                    |
| 5   | Effect shaders' light list (shadow lights left out)                | done   | light-lists.ts 'effect': four lights at most, never a shadow light                                                                                                                                                                                                                                                                             |
| 6   | Spot lights' cones (LIGH FOV, XLIG offsets)                        | done   | cell-loader lightCone                                                                                                                                                                                                                                                                                                                          |
| 7   | Light flicker and pulse                                            | done   | light-flicker.ts                                                                                                                                                                                                                                                                                                                               |
| 8   | Sun shadow cascades                                                | done   | shadow-cascades.ts                                                                                                                                                                                                                                                                                                                             |
| 9   | Focus shadows                                                      | done   | focus-shadows.ts                                                                                                                                                                                                                                                                                                                               |
| 10  | Whether focus maps draw only their actor                           | open   | ours draw every caster in their column                                                                                                                                                                                                                                                                                                         |
| 11  | Shadow lights: omnidirectional, spot, hemisphere                   | done   | light-shadows.ts                                                                                                                                                                                                                                                                                                                               |
| 12  | Fog: weather, XCLL and LGTM (near, far, power, max)                | done   | frame.wgsl                                                                                                                                                                                                                                                                                                                                     |
| 13  | Underwater fog                                                     | done   | underwater.ts                                                                                                                                                                                                                                                                                                                                  |
| 14  | Underwater imagespace (WATR INAM)                                  | done   | underwater.ts, world-sky.ts                                                                                                                                                                                                                                                                                                                    |
| 15  | Underwater colour (how the water's colours are lit, the tint)      | open   | the water's imagespace is the one path; how the fog colours are lit is inferred; the engine has an underwater mask image-space shader (ISUnderwaterMask) whose use is unread                                                                                                                                                                   |
| 16  | Terrain LOD                                                        | done   | terrain.ts                                                                                                                                                                                                                                                                                                                                     |
| 17  | Object LOD (.bto, HD LOD)                                          | done   | scene-renderer LOD materials                                                                                                                                                                                                                                                                                                                   |
| 18  | Tree LOD billboards                                                | done   | tree-lod.ts                                                                                                                                                                                                                                                                                                                                    |
| 19  | LOD fade between levels                                            | done   | levels switch without a fade once the replacing blocks are loaded, as the original (trees inferred)                                                                                                                                                                                                                                            |
| 20  | fLODFadeOutMultSkyCell                                             | done   | object-fade.ts: full LOD references take the sky cell's type (fSkyCellRefFadeDistance)                                                                                                                                                                                                                                                         |
| 21  | LOD culled by rooms and portals                                    | done   | as the original: a cell's portal graph culls only its own objects (those in no room always drawn); LOD land, objects and trees are in no cell's graph                                                                                                                                                                                          |
| 22  | Object distance fade                                               | done   | object-fade.ts: the original's thresholds and fade times; shader-fades.ts                                                                                                                                                                                                                                                                      |
| 23  | Rooms and portals culling                                          | done   | room-culler.ts                                                                                                                                                                                                                                                                                                                                 |
| 24  | Rooms' lighting templates and imagespaces                          | done   | model-viewer lightingInRoom                                                                                                                                                                                                                                                                                                                    |
| 25  | Occlusion planes and boxes                                         | done   | cell-rooms.ts                                                                                                                                                                                                                                                                                                                                  |
| 26  | Eye adaptation                                                     | done   | post.ts                                                                                                                                                                                                                                                                                                                                        |
| 27  | Bloom                                                              | done   | post.ts                                                                                                                                                                                                                                                                                                                                        |
| 28  | Tone curve and cinematic grading (saturation, contrast, tint)      | done   | post.wgsl                                                                                                                                                                                                                                                                                                                                      |
| 29  | Depth of field (IMGS and IMAD)                                     | done   | dof.wgsl                                                                                                                                                                                                                                                                                                                                       |
| 30  | IMAD screen effects: blur, double vision, radial and motion blur   | done   | screen-effects.wgsl                                                                                                                                                                                                                                                                                                                            |
| 31  | IMAD fade and tint, HDR and cinematic channels                     | done   | image-space-modifier.ts                                                                                                                                                                                                                                                                                                                        |
| 32  | Sun lens flare (LENS)                                              | done   | lens-flare.ts                                                                                                                                                                                                                                                                                                                                  |
| 33  | Image-based lens flare of bright lights (bIBLFEnable)              | done   | image-lens-flare.ts, image-lens-flare-data.ts, shaders/image-lens-flare.wgsl: the original's passes and shaders (bright pixels of the HDR scene, temporal downsamples, lights filter, near and far streaks, bloom, composite); its ghost and halo settings and textures are drawn by nothing in the original (target sizes' rounding inferred) |
| 34  | Temporal anti-aliasing                                             | done   | taa.ts                                                                                                                                                                                                                                                                                                                                         |
| 35  | Ambient occlusion                                                  | done   | sao.ts                                                                                                                                                                                                                                                                                                                                         |
| 36  | Refraction (heat haze, barriers)                                   | done   | refraction.ts                                                                                                                                                                                                                                                                                                                                  |
| 37  | God rays (the VOLI phase function)                                 | done   | volumetric-volume.ts (the froxel volume in place of screen-space rays)                                                                                                                                                                                                                                                                         |
| 38  | Volumetric lighting as a froxel volume (density noise, shadows)    | done   | volumetric-volume.ts, volumetric-data.ts, shaders/volumetric.wgsl                                                                                                                                                                                                                                                                              |
| 39  | Clouds (layers, speeds, colours, alphas)                           | done   | sky.ts                                                                                                                                                                                                                                                                                                                                         |
| 40  | Sun, sun glare, sun damage                                         | done   | sky.ts, sun-effects.ts                                                                                                                                                                                                                                                                                                                         |
| 41  | Moons and their phases, stars                                      | done   | sky.ts                                                                                                                                                                                                                                                                                                                                         |
| 42  | Aurora                                                             | done   | sky.ts                                                                                                                                                                                                                                                                                                                                         |
| 43  | Lightning: procedural bolts and the flash                          | done   | lightning.ts                                                                                                                                                                                                                                                                                                                                   |
| 44  | Precipitation (SPGD rain and snow)                                 | done   | precipitation.ts                                                                                                                                                                                                                                                                                                                               |
| 45  | Weather transitions                                                | done   | sky-state.ts                                                                                                                                                                                                                                                                                                                                   |
| 46  | Water: the reflection pass (exteriors)                             | done   | water-reflection.ts: the cube the original's water shaders sample; a face a frame, a new plane's faces two a frame                                                                                                                                                                                                                             |
| 47  | Water: displacement (wading, splashes, projectiles, rain)          | done   | water-displacement.ts                                                                                                                                                                                                                                                                                                                          |
| 48  | Water: colours and depth properties                                | done   | water.wgsl                                                                                                                                                                                                                                                                                                                                     |
| 49  | Water: river flow maps                                             | done   | flow-map.ts                                                                                                                                                                                                                                                                                                                                    |
| 50  | Water: the original shader's exact terms                           | done   | water.wgsl, water-color.ts: the shader cache's terms with the WATR values the engine's water material hands each constant (Reflectivity Amount mixes the reflection, Reflection Magnitude flattens its normal, the fog's exponent max(4 × amount, 1), the noise falloff 1..8191); the detail floor is 0 in every world pass                    |
| 51  | Static decals (TXST placed in cells)                               | done   | decals.ts                                                                                                                                                                                                                                                                                                                                      |
| 52  | Impact decals (IPCT)                                               | done   | decal-projection.ts                                                                                                                                                                                                                                                                                                                            |
| 53  | Skinned decals on actors                                           | done   | skinned-decal.ts, combat-impacts.ts (the original's limits per actor, frame and in all)                                                                                                                                                                                                                                                        |
| 54  | Screen blood                                                       | done   | screen-blood.ts                                                                                                                                                                                                                                                                                                                                |
| 55  | Weapon blood                                                       | done   | effect.wgsl                                                                                                                                                                                                                                                                                                                                    |
| 56  | Motion vectors of moving instances and animated parts              | done   | velocity.wgsl                                                                                                                                                                                                                                                                                                                                  |
| 57  | Motion vectors of skinned limbs                                    | done   | velocity.wgsl: the last frame's bone palettes                                                                                                                                                                                                                                                                                                  |
| 58  | First person: its own view and depth band                          | done   | first-person-view.ts                                                                                                                                                                                                                                                                                                                           |
| 59  | First person: the engine's near plane                              | done   | first-person-view.ts: fNear1stPersonDistance, the f1stPersonFarDepthRange band                                                                                                                                                                                                                                                                 |
| 60  | First person: particles                                            | done   | particle.wgsl: the first-person instance's systems in its view and band                                                                                                                                                                                                                                                                        |
| 61  | Eye reflection centres                                             | done   | common.wgsl eyeNormal: the centre by the vertex's eye data; reflection and ambient about it                                                                                                                                                                                                                                                    |
| 62  | Character light: its luminance source                              | open   | one sample of slot 11 at (1, 1); no target fills it: only projected-UV draws bind a texture there (ProjectedNoise.dds) and the state reset empties it, so it reads 0 or that noise by the draw order (unread); ours: the directional ambient's luminance                                                                                       |
| 63  | Default texture per slot for a missing file                        | done   | material-slots.ts missingTextures: the built-in texture each slot of each material takes (diffuse, normal, rim / soft, back light: the default normal map; glows white; the tint grey)                                                                                                                                                         |
| 64  | Grass                                                              | done   | grass.ts                                                                                                                                                                                                                                                                                                                                       |
| 65  | Terrain texture blending                                           | done   | terrain.wgsl                                                                                                                                                                                                                                                                                                                                   |
| 66  | Directional materials (snow, moss, ice on statics)                 | done   | material-object.ts                                                                                                                                                                                                                                                                                                                             |
| 67  | Snow subsurface scattering                                         | done   | snow-sss.ts                                                                                                                                                                                                                                                                                                                                    |
| 68  | Alternate textures on placed objects (MODS)                        | done   | cell-loader objectModelKey, GameSession.model                                                                                                                                                                                                                                                                                                  |
| 69  | The map's world view                                               | done   | world-map-view.ts                                                                                                                                                                                                                                                                                                                              |
| 70  | The race menu's 3D (lights, camera)                                | done   | race-menu.ts                                                                                                                                                                                                                                                                                                                                   |
| 71  | Inventory 3D: placement, lights, turning, zoom                     | done   | item-3d.ts                                                                                                                                                                                                                                                                                                                                     |
| 72  | Inventory 3D: the item's own orientation (BSInvMarker)             | done   | item-3d-view.ts (the marker's rotation and zoom)                                                                                                                                                                                                                                                                                               |
| 73  | The dragon-riding camera                                           | done   | camera-states.ts DragonCamera (target lock list order and buttons TODO(M13))                                                                                                                                                                                                                                                                   |
| 74  | Enchantment glow and effect shaders on references                  | done   | actor-effects.ts                                                                                                                                                                                                                                                                                                                               |
| 75  | The map's relief overlay on its LOD land                           | done   | lighting.wgsl worldMapRelief, world-map-view.ts                                                                                                                                                                                                                                                                                                |
| 76  | Shader terms only the shader cache holds (volumetric, map overlay) | done   | volumetric.wgsl, volumetric-data.ts, lighting.wgsl worldMapRelief / worldMapColor: the cache's image-space volumetric shaders (generate, sum, composite with its screen-space temporal blend and dither, blur, apply) and the world map's LOD land shaders                                                                                     |
| 77  | Water: the reflection in interiors and of several planes           | open   | cube maps in place of the reflection are done; the rules are read (outdoors the world's water height with sky, LOD and flagged references, every other height one shared sky-only reflection; indoors one per plane of the flagged references): ours still mirrors the nearest plane and binds black indoors without a map                     |
| 78  | Havok float slots: hkVis visibility, hkPhoneme                     | done   | behavior-runtime.ts float slot blocks, skeleton.ts showBySlots; hkPhoneme: no skeleton has the slots                                                                                                                                                                                                                                           |
| 79  | Mesh particles' Havok bodies against the world's shapes            | done   | particle-bodies.ts: per particle a copy of the node's body in the physics world, started at its velocity and spin, its mesh following it                                                                                                                                                                                                       |

## Data sweep

Generated by `node tools/render-inventory.ts --markdown` (a lighting shader's slot counts as
sampled where its type and flags bind it, `src/render/material-slots.ts`). Alternate textures
go by their 3D index, as the original's (a stale name such as RockShelf01:8 against a model whose
shapes are RockShelf01:0, :9 and :3 still swaps the shape at its index); an index beyond the
model's shapes swaps nothing.

### Lighting shader types

| Item                   | Uses  | Status | Where / why                                                                             |
| ---------------------- | ----- | ------ | --------------------------------------------------------------------------------------- |
| 0 Default              | 46180 | done   | lighting.wgsl                                                                           |
| 1 Environment Map      | 7227  | done   | lighting.wgsl: cube map × mask × scale × diffuse light                                  |
| 2 Glow Shader          | 1414  | done   | lighting.wgsl: emit × glow map (SLSF2 Glow_Map)                                         |
| 3 Parallax             | 11    | done   | lighting.wgsl: height map offset (the vanilla model-space bug kept)                     |
| 4 Face Tint            | 3239  | done   | lighting.wgsl: FaceGen detail and tint maps, character light                            |
| 5 Skin Tint            | 1684  | done   | lighting.wgsl: skin tint colour (FaceGen RGB tint)                                      |
| 6 Hair Tint            | 11070 | done   | lighting.wgsl: tint by vertex green, anisotropic                                        |
| 11 MultiLayer Parallax | 662   | done   | lighting.wgsl: inner layer, slot 6                                                      |
| 14 Sparkle Snow        | 19    | done   | lighting.wgsl sparkle technique (every use carries Snow, whose variant has no sparkles) |
| 16 Eye Envmap          | 3339  | done   | lighting.wgsl, common.wgsl eyeNormal: the reflection centres                            |

### Lighting shader flags

| Item                                          | Uses  | Status | Where / why                                                                           |
| --------------------------------------------- | ----- | ------ | ------------------------------------------------------------------------------------- |
| SLSF1 Specular (0x1)                          | 65953 | done   | lighting.wgsl                                                                         |
| SLSF1 Skinned (0x2)                           | 27529 | done   | skinning.ts (the skin instance decides)                                               |
| SLSF1 Vertex_Alpha (0x8)                      | 10783 | done   | lighting.wgsl                                                                         |
| SLSF1 Environment_Mapping (0x80)              | 7243  | done   | lighting.wgsl                                                                         |
| SLSF1 Receive_Shadows (0x100)                 | 74457 | done   | lighting.wgsl                                                                         |
| SLSF1 Cast_Shadows (0x200)                    | 73235 | done   | scene-renderer shadow casters                                                         |
| SLSF1 Facegen_Detail_Map (0x400)              | 3239  | done   | lighting.wgsl FaceGen detail map                                                      |
| SLSF1 Parallax (0x800)                        | 11    | done   | with shader type 3                                                                    |
| SLSF1 Model_Space_Normals (0x1000)            | 4188  | done   | lighting.wgsl                                                                         |
| SLSF1 Refraction (0x8000)                     | 362   | done   | refraction.ts                                                                         |
| SLSF1 Fire_Refraction (0x10000)               | 252   | done   | refraction.wgsl: its falloff variant, the strength × normal · direction to the viewer |
| SLSF1 Eye_Environment_Mapping (0x20000)       | 3320  | done   | lighting.wgsl                                                                         |
| SLSF1 Hair_Soft_Lighting (0x40000)            | 11070 | done   | lighting.wgsl: picks the hair technique (the hair tint)                               |
| SLSF1 Screendoor_Alpha_Fade (0x80000)         | 10    | done   | lighting.wgsl blendedFade: blended while fading, no shadow mask                       |
| SLSF1 FaceGen_RGB_Tint (0x200000)             | 1684  | done   | lighting.wgsl skin tint                                                               |
| SLSF1 Own_Emit (0x400000)                     | 74833 | done   | lighting.wgsl                                                                         |
| SLSF1 Remappable_Textures (0x2000000)         | 73726 | n/a    | the lighting technique never reads it                                                 |
| SLSF1 Decal (0x4000000)                       | 11394 | done   | depth bias, decal pipelines                                                           |
| SLSF1 Dynamic_Decal (0x8000000)               | 11315 | done   | weapon blood, decal pipelines                                                         |
| SLSF1 External_Emittance (0x20000000)         | 412   | done   | XEMI on references                                                                    |
| SLSF1 ZBuffer_Test (0x80000000)               | 74845 | done   | pipeline depth test                                                                   |
| SLSF2 ZBuffer_Write (0x1)                     | 66564 | done   | pipeline depth write                                                                  |
| SLSF2 No_Fade (0x8)                           | 1242  | done   | lighting.wgsl, refraction.wgsl: no decal or refraction distance fade                  |
| SLSF2 Double_Sided (0x10)                     | 2345  | done   | cull mode                                                                             |
| SLSF2 Vertex_Colors (0x20)                    | 58096 | done   | lighting.wgsl                                                                         |
| SLSF2 Glow_Map (0x40)                         | 1414  | done   | lighting.wgsl                                                                         |
| SLSF2 Assume_Shadowmask (0x80)                | 12352 | done   | lighting.wgsl: shadows on blended shapes                                              |
| SLSF2 EnvMap_Light_Fade (0x8000)              | 72788 | n/a    | the lighting technique never reads it                                                 |
| SLSF2 Anisotropic_Lighting (0x200000)         | 5729  | done   | lighting.wgsl                                                                         |
| SLSF2 Multi_Layer_Parallax (0x1000000)        | 662   | done   | with shader type 11                                                                   |
| SLSF2 Soft_Lighting (0x2000000)               | 8264  | done   | lighting.wgsl                                                                         |
| SLSF2 Rim_Lighting (0x4000000)                | 264   | done   | lighting.wgsl                                                                         |
| SLSF2 Back_Lighting (0x8000000)               | 2184  | done   | lighting.wgsl                                                                         |
| SLSF2 Snow (Unused02 in nif.xml) (0x10000000) | 30    | done   | snow.wgsl                                                                             |
| SLSF2 Tree_Anim (0x20000000)                  | 461   | done   | common.wgsl leafShift                                                                 |

### Effect shader flags

| Item                                   | Uses | Status | Where / why                                                                               |
| -------------------------------------- | ---- | ------ | ----------------------------------------------------------------------------------------- |
| SLSF1 Skinned (0x2)                    | 242  | done   | skinning.ts                                                                               |
| SLSF1 Vertex_Alpha (0x8)               | 4168 | done   | effect.wgsl                                                                               |
| SLSF1 Greyscale_To_PaletteColor (0x10) | 3097 | done   | effect.wgsl                                                                               |
| SLSF1 Greyscale_To_PaletteAlpha (0x20) | 2626 | done   | effect.wgsl                                                                               |
| SLSF1 Use_Falloff (0x40)               | 2797 | done   | effect.wgsl                                                                               |
| SLSF1 Own_Emit (0x400000)              | 69   | n/a    | neither the effect's technique nor its pass reads it                                      |
| SLSF1 Decal (0x4000000)                | 719  | done   | decal pipelines                                                                           |
| SLSF1 Dynamic_Decal (0x8000000)        | 719  | done   | decal pipelines                                                                           |
| SLSF1 External_Emittance (0x20000000)  | 1750 | done   | XEMI                                                                                      |
| SLSF1 Soft_Effect (0x40000000)         | 3796 | done   | effect.wgsl                                                                               |
| SLSF1 ZBuffer_Test (0x80000000)        | 8349 | done   | pipeline depth test                                                                       |
| SLSF2 ZBuffer_Write (0x1)              | 1621 | done   | pipeline depth write                                                                      |
| SLSF2 No_Fade (0x8)                    | 181  | n/a    | the effect's pass has no shader distance fade for it to spare (the lighting shader's has) |
| SLSF2 Double_Sided (0x10)              | 2950 | done   | cull mode                                                                                 |
| SLSF2 Vertex_Colors (0x20)             | 7374 | done   | effect.wgsl                                                                               |
| SLSF2 Weapon_Blood (0x20000)           | 310  | done   | effect.wgsl                                                                               |
| SLSF2 Effect_Lighting (0x40000000)     | 1748 | done   | effect.wgsl                                                                               |

### Texture slots

| Item                                              | Uses  | Status | Where / why                            |
| ------------------------------------------------- | ----- | ------ | -------------------------------------- |
| type 0 slot 0 diffuse (sampled)                   | 46180 | done   | material-slots.ts, lighting.wgsl       |
| type 0 slot 1 normal (sampled)                    | 46180 | done   | material-slots.ts, lighting.wgsl       |
| type 0 slot 2 glow / skin / rim-soft (sampled)    | 769   | done   | material-slots.ts, lighting.wgsl       |
| type 0 slot 2 glow / skin / rim-soft (unsampled)  | 1166  | n/a    | its type and flags sample no such slot |
| type 0 slot 4 environment (unsampled)             | 14    | n/a    | its type and flags sample no such slot |
| type 0 slot 5 environment mask (unsampled)        | 424   | n/a    | its type and flags sample no such slot |
| type 0 slot 6 inner layer / tint (unsampled)      | 1     | n/a    | its type and flags sample no such slot |
| type 0 slot 7 specular / back light (sampled)     | 1374  | done   | material-slots.ts, lighting.wgsl       |
| type 0 slot 7 specular / back light (unsampled)   | 65    | n/a    | its type and flags sample no such slot |
| type 11 slot 0 diffuse (sampled)                  | 662   | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 1 normal (sampled)                   | 662   | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 2 glow / skin / rim-soft (sampled)   | 149   | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 2 glow / skin / rim-soft (unsampled) | 72    | n/a    | its type and flags sample no such slot |
| type 11 slot 3 height / detail (unsampled)        | 23    | n/a    | its type and flags sample no such slot |
| type 11 slot 4 environment (sampled)              | 655   | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 5 environment mask (sampled)         | 98    | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 6 inner layer / tint (sampled)       | 662   | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 7 specular / back light (sampled)    | 373   | done   | material-slots.ts, lighting.wgsl       |
| type 11 slot 7 specular / back light (unsampled)  | 7     | n/a    | its type and flags sample no such slot |
| type 14 slot 0 diffuse (sampled)                  | 19    | done   | material-slots.ts, lighting.wgsl       |
| type 14 slot 1 normal (sampled)                   | 19    | done   | material-slots.ts, lighting.wgsl       |
| type 14 slot 7 specular / back light (sampled)    | 17    | done   | material-slots.ts, lighting.wgsl       |
| type 16 slot 0 diffuse (sampled)                  | 3339  | done   | material-slots.ts, lighting.wgsl       |
| type 16 slot 1 normal (sampled)                   | 3339  | done   | material-slots.ts, lighting.wgsl       |
| type 16 slot 2 glow / skin / rim-soft (sampled)   | 3175  | done   | material-slots.ts, lighting.wgsl       |
| type 16 slot 2 glow / skin / rim-soft (unsampled) | 2     | n/a    | its type and flags sample no such slot |
| type 16 slot 4 environment (sampled)              | 3334  | done   | material-slots.ts, lighting.wgsl       |
| type 16 slot 5 environment mask (sampled)         | 3225  | done   | material-slots.ts, lighting.wgsl       |
| type 16 slot 7 specular / back light (sampled)    | 3     | done   | material-slots.ts, lighting.wgsl       |
| type 1 slot 0 diffuse (sampled)                   | 7227  | done   | material-slots.ts, lighting.wgsl       |
| type 1 slot 1 normal (sampled)                    | 7227  | done   | material-slots.ts, lighting.wgsl       |
| type 1 slot 2 glow / skin / rim-soft (sampled)    | 108   | done   | material-slots.ts, lighting.wgsl       |
| type 1 slot 2 glow / skin / rim-soft (unsampled)  | 143   | n/a    | its type and flags sample no such slot |
| type 1 slot 4 environment (sampled)               | 7226  | done   | material-slots.ts, lighting.wgsl       |
| type 1 slot 5 environment mask (sampled)          | 2997  | done   | material-slots.ts, lighting.wgsl       |
| type 1 slot 7 specular / back light (sampled)     | 238   | done   | material-slots.ts, lighting.wgsl       |
| type 2 slot 0 diffuse (sampled)                   | 1414  | done   | material-slots.ts, lighting.wgsl       |
| type 2 slot 1 normal (sampled)                    | 1414  | done   | material-slots.ts, lighting.wgsl       |
| type 2 slot 2 glow / skin / rim-soft (sampled)    | 1387  | done   | material-slots.ts, lighting.wgsl       |
| type 2 slot 4 environment (unsampled)             | 48    | n/a    | its type and flags sample no such slot |
| type 2 slot 5 environment mask (unsampled)        | 139   | n/a    | its type and flags sample no such slot |
| type 2 slot 7 specular / back light (sampled)     | 214   | done   | material-slots.ts, lighting.wgsl       |
| type 3 slot 0 diffuse (sampled)                   | 11    | done   | material-slots.ts, lighting.wgsl       |
| type 3 slot 1 normal (sampled)                    | 11    | done   | material-slots.ts, lighting.wgsl       |
| type 3 slot 3 height / detail (sampled)           | 11    | done   | material-slots.ts, lighting.wgsl       |
| type 4 slot 0 diffuse (sampled)                   | 3239  | done   | material-slots.ts, lighting.wgsl       |
| type 4 slot 1 normal (sampled)                    | 3239  | done   | material-slots.ts, lighting.wgsl       |
| type 4 slot 2 glow / skin / rim-soft (sampled)    | 3194  | done   | material-slots.ts, lighting.wgsl       |
| type 4 slot 2 glow / skin / rim-soft (unsampled)  | 45    | n/a    | its type and flags sample no such slot |
| type 4 slot 3 height / detail (sampled)           | 3225  | done   | material-slots.ts, lighting.wgsl       |
| type 4 slot 6 inner layer / tint (sampled)        | 3231  | done   | material-slots.ts, lighting.wgsl       |
| type 4 slot 7 specular / back light (sampled)     | 3193  | done   | material-slots.ts, lighting.wgsl       |
| type 5 slot 0 diffuse (sampled)                   | 1684  | done   | material-slots.ts, lighting.wgsl       |
| type 5 slot 1 normal (sampled)                    | 1684  | done   | material-slots.ts, lighting.wgsl       |
| type 5 slot 2 glow / skin / rim-soft (sampled)    | 953   | done   | material-slots.ts, lighting.wgsl       |
| type 5 slot 2 glow / skin / rim-soft (unsampled)  | 1     | n/a    | its type and flags sample no such slot |
| type 5 slot 7 specular / back light (sampled)     | 391   | done   | material-slots.ts, lighting.wgsl       |
| type 5 slot 7 specular / back light (unsampled)   | 21    | n/a    | its type and flags sample no such slot |
| type 6 slot 0 diffuse (sampled)                   | 11070 | done   | material-slots.ts, lighting.wgsl       |
| type 6 slot 1 normal (sampled)                    | 11070 | done   | material-slots.ts, lighting.wgsl       |
| type 6 slot 2 glow / skin / rim-soft (sampled)    | 16    | done   | material-slots.ts, lighting.wgsl       |

### Effect shader textures

| Item              | Uses | Status | Where / why |
| ----------------- | ---- | ------ | ----------- |
| source texture    | 6490 | done   | effect.wgsl |
| greyscale palette | 4405 | done   | effect.wgsl |

### Alpha modes

| Item                            | Uses  | Status | Where / why               |
| ------------------------------- | ----- | ------ | ------------------------- |
| test GREATER                    | 18160 | done   | NiAlphaProperty pipelines |
| blend SRC_ALPHA / INV_SRC_ALPHA | 15311 | done   | NiAlphaProperty pipelines |
| blend SRC_ALPHA / ONE           | 4495  | done   | NiAlphaProperty pipelines |
| blend ZERO / SRC_COLOR          | 435   | done   | NiAlphaProperty pipelines |

### Shader controller variables

| Item                                       | Uses | Status | Where / why  |
| ------------------------------------------ | ---- | ------ | ------------ |
| BSEffectShaderPropertyColorController 0    | 988  | done   | animation.ts |
| BSEffectShaderPropertyFloatController 0    | 900  | done   | animation.ts |
| BSEffectShaderPropertyFloatController 1    | 17   | done   | animation.ts |
| BSEffectShaderPropertyFloatController 2    | 163  | done   | animation.ts |
| BSEffectShaderPropertyFloatController 3    | 196  | done   | animation.ts |
| BSEffectShaderPropertyFloatController 4    | 2    | done   | animation.ts |
| BSEffectShaderPropertyFloatController 5    | 2497 | done   | animation.ts |
| BSEffectShaderPropertyFloatController 6    | 1802 | done   | animation.ts |
| BSEffectShaderPropertyFloatController 7    | 384  | done   | animation.ts |
| BSEffectShaderPropertyFloatController 8    | 2512 | done   | animation.ts |
| BSEffectShaderPropertyFloatController 9    | 314  | done   | animation.ts |
| BSLightingShaderPropertyColorController 0  | 26   | done   | animation.ts |
| BSLightingShaderPropertyColorController 1  | 265  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 0  | 225  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 10 | 19   | done   | animation.ts |
| BSLightingShaderPropertyFloatController 11 | 645  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 12 | 906  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 20 | 208  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 21 | 214  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 22 | 912  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 23 | 200  | done   | animation.ts |
| BSLightingShaderPropertyFloatController 8  | 13   | done   | animation.ts |
| BSLightingShaderPropertyFloatController 9  | 5    | done   | animation.ts |

### Sky shader objects

| Item   | Uses | Status | Where / why |
| ------ | ---- | ------ | ----------- |
| type 2 | 1    | done   | sky.ts      |
| type 3 | 29   | done   | sky.ts      |
| type 7 | 1    | done   | sky.ts      |
| type 5 | 4    | done   | sky.ts      |

### Water shader flags

| Item  | Uses | Status | Where / why |
| ----- | ---- | ------ | ----------- |
| bit 2 | 32   | done   | water.wgsl  |
| bit 6 | 30   | done   | water.wgsl  |
| bit 7 | 32   | done   | water.wgsl  |

### Block types

| Item                                                | Uses   | Status | Where / why                                                                                             |
| --------------------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------- |
| NiNode (10612 files)                                | 102385 | done   |                                                                                                         |
| BSLightingShaderProperty (20966 files)              | 74845  | done   | lighting.wgsl                                                                                           |
| BSShaderTextureSet (20966 files)                    | 64058  | done   |                                                                                                         |
| BSTriShape (18601 files)                            | 61597  | done   | build-model                                                                                             |
| NiFloatInterpolator (2192 files)                    | 38251  | done   |                                                                                                         |
| NiAlphaProperty (12313 files)                       | 36617  | done   | blend and test pipelines                                                                                |
| NiFloatData (2030 files)                            | 35333  | done   |                                                                                                         |
| NiSkinData (7207 files)                             | 27794  | done   |                                                                                                         |
| NiSkinPartition (7207 files)                        | 27794  | done   |                                                                                                         |
| BSDynamicTriShape (3727 files)                      | 21581  | done   | face-morphs                                                                                             |
| NiTransformInterpolator (1816 files)                | 20479  | done   |                                                                                                         |
| NiTransformData (1767 files)                        | 19163  | done   |                                                                                                         |
| BSFadeNode (18797 files)                            | 18797  | done   |                                                                                                         |
| BSDismemberSkinInstance (6548 files)                | 16200  | done   | skinning.ts                                                                                             |
| BSXFlags (13511 files)                              | 13511  | done   | model-data.ts                                                                                           |
| NiSkinInstance (3890 files)                         | 11621  | done   | skinning.ts                                                                                             |
| BSEffectShaderPropertyFloatController (1381 files)  | 8787   | done   | animation.ts shader variables                                                                           |
| NiBoolTimelineInterpolator (615 files)              | 8492   | done   | animation.ts (as a bool interpolator)                                                                   |
| BSEffectShaderProperty (3022 files)                 | 8362   | done   | effect.wgsl (environment map open)                                                                      |
| NiBlendFloatInterpolator (856 files)                | 8164   | done   |                                                                                                         |
| NiBoolInterpolator (1074 files)                     | 7885   | done   |                                                                                                         |
| NiTextKeyExtraData (1455 files)                     | 5095   | done   |                                                                                                         |
| NiControllerSequence (1313 files)                   | 4947   | done   | animation.ts                                                                                            |
| NiTransformController (943 files)                   | 4906   | done   | animation.ts                                                                                            |
| NiBoolData (927 files)                              | 4724   | done   |                                                                                                         |
| NiBlendBoolInterpolator (624 files)                 | 3795   | done   |                                                                                                         |
| BSLightingShaderPropertyFloatController (629 files) | 3347   | done   | animation.ts shader variables                                                                           |
| NiPosData (540 files)                               | 3160   | done   |                                                                                                         |
| NiPoint3Interpolator (516 files)                    | 3115   | done   |                                                                                                         |
| NiStringExtraData (990 files)                       | 2798   | done   | model-data.ts                                                                                           |
| NiPSysModifierActiveCtlr (606 files)                | 2793   | done   |                                                                                                         |
| BSInvMarker (2299 files)                            | 2299   | done   | item-3d-view.ts                                                                                         |
| NiPSysDragModifier (470 files)                      | 2293   | done   |                                                                                                         |
| NiBillboardNode (805 files)                         | 2067   | done   | billboard.ts                                                                                            |
| NiFloatExtraData (102 files)                        | 1786   | n/a    | names Havok float slots (hkVis: a controller per name, skeleton.ts showBySlots); the rest exporter data |
| NiPSysUpdateCtlr (912 files)                        | 1729   | done   | implicit: systems update each frame                                                                     |
| NiPSysAgeDeathModifier (912 files)                  | 1729   | done   |                                                                                                         |
| BSPSysLODModifier (912 files)                       | 1729   | done   |                                                                                                         |
| NiPSysSpawnModifier (912 files)                     | 1729   | done   |                                                                                                         |
| NiPSysPositionModifier (912 files)                  | 1726   | done   | implicit: particles move by velocity                                                                    |
| NiPSysBoundUpdateModifier (912 files)               | 1726   | done   | implicit: bounds per frame                                                                              |
| BSPSysSimpleColorModifier (903 files)               | 1691   | done   |                                                                                                         |
| NiPSysEmitterCtlr (819 files)                       | 1587   | done   |                                                                                                         |
| NiPSysData (802 files)                              | 1547   | done   |                                                                                                         |
| NiParticleSystem (802 files)                        | 1547   | done   | particle-sim.ts                                                                                         |
| BSPSysScaleModifier (847 files)                     | 1506   | done   |                                                                                                         |
| NiPSysGravityModifier (679 files)                   | 1379   | done   |                                                                                                         |
| NiControllerManager (1313 files)                    | 1313   | done   | animation.ts                                                                                            |
| NiMultiTargetTransformController (1313 files)       | 1313   | done   | animation.ts                                                                                            |
| NiDefaultAVObjectPalette (1313 files)               | 1313   | done   |                                                                                                         |
| BSBehaviorGraphExtraData (1251 files)               | 1251   | done   | behavior graphs on objects                                                                              |
| NiVisController (279 files)                         | 1054   | done   | animation.ts                                                                                            |
| BSEffectShaderPropertyColorController (421 files)   | 988    | done   | animation.ts shader variables                                                                           |
| NiPSysRotationModifier (573 files)                  | 905    | done   |                                                                                                         |
| BSValueNode (242 files)                             | 814    | done   |                                                                                                         |
| NiBlendPoint3Interpolator (296 files)               | 799    | done   |                                                                                                         |
| BSNiAlphaPropertyTestRefController (227 files)      | 767    | done   | animation.ts                                                                                            |
| NiPSysMeshEmitter (350 files)                       | 644    | done   |                                                                                                         |
| BSPSysSubTexModifier (338 files)                    | 574    | done   |                                                                                                         |
| NiBooleanExtraData (203 files)                      | 567    | n/a    | gameplay data                                                                                           |
| NiPSysBoxEmitter (330 files)                        | 564    | done   |                                                                                                         |
| NiPSysBombModifier (235 files)                      | 500    | done   |                                                                                                         |
| NiPSysCylinderEmitter (258 files)                   | 373    | done   |                                                                                                         |
| NiStringsExtraData (182 files)                      | 337    | n/a    | gameplay data                                                                                           |
| NiBinaryExtraData (30 files)                        | 321    | n/a    | gameplay data                                                                                           |
| BSLightingShaderPropertyColorController (123 files) | 291    | done   | animation.ts shader variables                                                                           |
| NiTriShapeData (158 files)                          | 289    | done   | build-model                                                                                             |
| BSLeafAnimNode (286 files)                          | 286    | done   | leaf flutter                                                                                            |
| BSOrderedNode (247 files)                           | 256    | done   | draw order of its children                                                                              |
| NiTriShape (134 files)                              | 246    | done   | build-model                                                                                             |
| BSMultiBoundNode (246 files)                        | 246    | done   | culling bounds                                                                                          |
| BSMultiBound (246 files)                            | 246    | done   | culling by bounding spheres draws the same image                                                        |
| BSFurnitureMarkerNode (243 files)                   | 243    | n/a    | furniture markers                                                                                       |
| BSMultiBoundOBB (240 files)                         | 240    | done   | culling by bounding spheres draws the same image                                                        |
| NiPSysEmitterSpeedCtlr (133 files)                  | 234    | done   | particle-data.ts                                                                                        |
| NiPSysGravityStrengthCtlr (125 files)               | 230    | done   | particle-data.ts                                                                                        |
| BSLagBoneController (108 files)                     | 221    | done   | lag-bone.ts: skeletons, worn models (wearOnRig), placed and held models trail                           |
| NiFloatExtraDataController (71 files)               | 188    | n/a    | animates hkVis values; the original shows nodes by the Havok pose, not these                            |
| BSPSysInheritVelocityModifier (104 files)           | 188    | done   |                                                                                                         |
| BSStripPSysData (151 files)                         | 179    | done   |                                                                                                         |
| BSStripParticleSystem (151 files)                   | 179    | done   | particle-sim.ts strips                                                                                  |
| BSPSysStripUpdateModifier (151 files)               | 179    | done   |                                                                                                         |
| NiSwitchNode (165 files)                            | 172    | done   |                                                                                                         |
| NiIntegerExtraData (143 files)                      | 169    | n/a    | gameplay data                                                                                           |
| NiPSysSphereEmitter (101 files)                     | 148    | done   |                                                                                                         |
| BSPSysMultiTargetEmitterCtlr (93 files)             | 142    | done   |                                                                                                         |
| NiCamera (129 files)                                | 138    | done   | cinematic cameras                                                                                       |
| NiPSysEmitterInitialRadiusCtlr (80 files)           | 113    | done   | particle-data.ts                                                                                        |
| NiPSysPlanarCollider (42 files)                     | 96     | done   |                                                                                                         |
| BSMasterParticleSystem (93 files)                   | 93     | done   |                                                                                                         |
| NiPSysColliderManager (51 files)                    | 77     | done   |                                                                                                         |
| NiPSysEmitterLifeSpanCtlr (60 files)                | 76     | done   | particle-data.ts                                                                                        |
| NiPathInterpolator (25 files)                       | 73     | done   | path-motion.ts (constant velocity, follow, flip)                                                        |
| BSTreeNode (71 files)                               | 71     | done   | leaf flutter                                                                                            |
| BSDecalPlacementVectorExtraData (61 files)          | 61     | n/a    | editor data (0-2 points each); the original loads it, nothing reads it                                  |
| BSBound (57 files)                                  | 57     | done   | bounds                                                                                                  |
| BSFrustumFOVController (54 files)                   | 54     | done   | camera-model.ts (the kill cameras)                                                                      |
| BSBoneLODExtraData (52 files)                       | 52     | done   | BehaviorRuntime.setBoneLod: far bones keep their pose                                                   |
| BSPSysRecycleBoundModifier (36 files)               | 45     | done   |                                                                                                         |
| BSLODTriShape (34 files)                            | 43     | done   | build-model                                                                                             |
| BSProceduralLightningController (13 files)          | 37     | done   | lightning.ts                                                                                            |
| BSSkyShaderProperty (4 files)                       | 35     | done   | sky.ts                                                                                                  |
| BSWaterShaderProperty (33 files)                    | 33     | done   | water.wgsl                                                                                              |
| BSBlastNode (28 files)                              | 31     | done   | explosions                                                                                              |
| NiTriStripsData (17 files)                          | 31     | n/a    | collision geometry only (bhkNiTriStripsShape)                                                           |
| NiPSysSphericalCollider (15 files)                  | 28     | done   |                                                                                                         |
| BSDamageStage (7 files)                             | 13     | done   | destruction stages                                                                                      |
| BSWindModifier (7 files)                            | 10     | done   |                                                                                                         |
| BSMultiBoundAABB (6 files)                          | 6      | done   | culling by bounding spheres draws the same image                                                        |
| NiLookAtInterpolator (5 files)                      | 5      | done   | animation.ts look-at tracks                                                                             |
| NiPSysEmitterPlanarAngleCtlr (2 files)              | 4      | done   | particle-data.ts                                                                                        |
| NiPSysEmitterDeclinationCtlr (2 files)              | 4      | done   | particle-data.ts                                                                                        |
| NiBSBoneLODController (3 files)                     | 3      | n/a    | old exports (centaur, wolf, werewolf); no BSBoneLOD#Bone# names give it levels                          |
| NiMeshPSysData (1 files)                            | 3      | done   | its pool: one copy of the mesh per particle (model-data.ts)                                             |
| NiMeshParticleSystem (1 files)                      | 3      | done   | mesh parts per particle (meshParticle), particle-sim bodies                                             |
| NiPSysInitialRotSpeedCtlr (1 files)                 | 1      | done   | particle-data.ts                                                                                        |

### Records: CLMT (9)

| Item | Uses | Status | Where / why    |
| ---- | ---- | ------ | -------------- |
| FNAM | 8    | done   | read           |
| GNAM | 8    | done   | read           |
| MODL | 9    | done   | read           |
| MODT | 5    | n/a    | texture hashes |
| TNAM | 9    | done   | read           |
| WLST | 9    | done   | read           |

### Records: EFSH (280)

| Item | Uses | Status | Where / why |
| ---- | ---- | ------ | ----------- |
| DATA | 280  | done   | read        |
| ICO2 | 280  | done   | read        |
| ICON | 280  | done   | read        |
| NAM7 | 280  | done   | read        |
| NAM8 | 275  | done   | read        |
| NAM9 | 271  | done   | read        |

### Records: IMAD (256)

| Item    | Uses | Status | Where / why |
| ------- | ---- | ------ | ----------- |
| \x00IAD | 256  | done   | read        |
| \x01IAD | 256  | done   | read        |
| \x02IAD | 256  | done   | read        |
| \x03IAD | 256  | done   | read        |
| \x04IAD | 256  | done   | read        |
| \x05IAD | 256  | done   | read        |
| \x06IAD | 256  | done   | read        |
| \x07IAD | 256  | done   | read        |
| \x08IAD | 256  | done   | read        |
| \x09IAD | 256  | done   | read        |
| \x0aIAD | 256  | done   | read        |
| \x0bIAD | 256  | done   | read        |
| \x0cIAD | 256  | done   | read        |
| \x0dIAD | 256  | done   | read        |
| \x0eIAD | 256  | done   | read        |
| \x0fIAD | 256  | done   | read        |
| \x10IAD | 256  | done   | read        |
| \x11IAD | 256  | done   | read        |
| \x12IAD | 256  | done   | read        |
| \x13IAD | 256  | done   | read        |
| \x14IAD | 256  | done   | read        |
| @IAD    | 256  | done   | read        |
| AIAD    | 256  | done   | read        |
| BIAD    | 256  | done   | read        |
| BNAM    | 256  | done   | read        |
| CIAD    | 256  | done   | read        |
| DIAD    | 256  | done   | read        |
| DNAM    | 256  | done   | read        |
| EIAD    | 256  | done   | read        |
| FIAD    | 256  | done   | read        |
| GIAD    | 256  | done   | read        |
| HIAD    | 256  | done   | read        |
| IIAD    | 256  | done   | read        |
| JIAD    | 256  | done   | read        |
| KIAD    | 256  | done   | read        |
| LIAD    | 256  | done   | read        |
| MIAD    | 256  | done   | read        |
| NAM1    | 256  | done   | read        |
| NAM2    | 256  | done   | read        |
| NAM3    | 256  | done   | read        |
| NAM4    | 256  | done   | read        |
| NIAD    | 256  | done   | read        |
| OIAD    | 256  | done   | read        |
| PIAD    | 256  | done   | read        |
| QIAD    | 256  | done   | read        |
| RIAD    | 256  | done   | read        |
| RNAM    | 256  | done   | read        |
| SIAD    | 256  | done   | read        |
| SNAM    | 256  | done   | read        |
| TIAD    | 256  | done   | read        |
| TNAM    | 256  | done   | read        |
| UNAM    | 256  | done   | read        |
| VNAM    | 256  | done   | read        |
| WNAM    | 256  | done   | read        |
| XNAM    | 256  | done   | read        |
| YNAM    | 256  | done   | read        |

### Records: IMGS (294)

| Item | Uses | Status | Where / why |
| ---- | ---- | ------ | ----------- |
| CNAM | 292  | done   | read        |
| DNAM | 277  | done   | read        |
| ENAM | 2    | done   | read        |
| HNAM | 292  | done   | read        |
| TNAM | 292  | done   | read        |

### Records: LGTM (130)

| Item | Uses | Status | Where / why |
| ---- | ---- | ------ | ----------- |
| DALC | 130  | done   | read        |
| DATA | 130  | done   | read        |

### Records: LIGH (504)

| Item | Uses | Status | Where / why    |
| ---- | ---- | ------ | -------------- |
| DATA | 504  | done   | read           |
| FNAM | 504  | done   | read           |
| FULL | 4    | done   | read           |
| MODL | 16   | done   | read           |
| MODT | 16   | n/a    | texture hashes |
| SNAM | 4    | n/a    | its sound      |
| VMAD | 2    | n/a    | scripts        |

### Records: SPGD (18)

| Item | Uses | Status | Where / why |
| ---- | ---- | ------ | ----------- |
| DATA | 18   | done   | read        |
| ICON | 16   | done   | read        |

### Records: TXST (789)

| Item | Uses | Status | Where / why |
| ---- | ---- | ------ | ----------- |
| DNAM | 784  | done   | read        |
| DODT | 59   | done   | read        |
| TX00 | 789  | done   | read        |
| TX01 | 777  | done   | read        |
| TX02 | 48   | done   | read        |
| TX03 | 190  | done   | read        |
| TX04 | 115  | done   | read        |
| TX05 | 60   | done   | read        |
| TX07 | 199  | done   | read        |

### Records: VOLI (42)

| Item | Uses | Status | Where / why |
| ---- | ---- | ------ | ----------- |
| CNAM | 42   | done   | read        |
| DNAM | 42   | done   | read        |
| ENAM | 42   | done   | read        |
| FNAM | 42   | done   | read        |
| GNAM | 42   | done   | read        |
| HNAM | 42   | done   | read        |
| INAM | 42   | done   | read        |
| JNAM | 42   | done   | read        |
| KNAM | 42   | done   | read        |
| LNAM | 42   | done   | read        |
| MNAM | 42   | done   | read        |
| NNAM | 42   | done   | read        |

### Records: WATR (58)

| Item | Uses | Status | Where / why                                                                                                                                                                                                                     |
| ---- | ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ANAM | 58   | done   | read                                                                                                                                                                                                                            |
| DATA | 58   | done   | read                                                                                                                                                                                                                            |
| DNAM | 58   | done   | read                                                                                                                                                                                                                            |
| FNAM | 58   | done   | read                                                                                                                                                                                                                            |
| FULL | 3    | n/a    | name                                                                                                                                                                                                                            |
| GNAM | 58   | n/a    | empty in every vanilla water                                                                                                                                                                                                    |
| INAM | 53   | done   | read                                                                                                                                                                                                                            |
| NAM0 | 58   | done   | read                                                                                                                                                                                                                            |
| NAM1 | 58   | done   | read                                                                                                                                                                                                                            |
| NAM2 | 58   | done   | read                                                                                                                                                                                                                            |
| NAM3 | 58   | done   | read                                                                                                                                                                                                                            |
| NAM4 | 58   | done   | read                                                                                                                                                                                                                            |
| NAM5 | 10   | open   | flow normals noise texture (RiverFlow.dds): the flow-map techniques' terms are read (docs/rendering.md, rivers' flow normals); the cell water's texture coordinates and the composite flow map's placement constants are unread |
| SNAM | 26   | n/a    | its sound                                                                                                                                                                                                                       |
| TNAM | 7    | done   | read                                                                                                                                                                                                                            |

### Records: WTHR (108)

| Item | Uses | Status | Where / why                               |
| ---- | ---- | ------ | ----------------------------------------- |
| 00TX | 95   | done   | read                                      |
| 10TX | 95   | done   | read                                      |
| 20TX | 43   | done   | read                                      |
| 30TX | 95   | done   | read                                      |
| 40TX | 28   | done   | read                                      |
| 50TX | 28   | done   | read                                      |
| 60TX | 28   | done   | read                                      |
| 70TX | 28   | done   | read                                      |
| 80TX | 70   | done   | read                                      |
| 90TX | 70   | done   | read                                      |
| :0TX | 64   | done   | read                                      |
| ;0TX | 71   | done   | read                                      |
| <0TX | 15   | done   | read                                      |
| =0TX | 15   | done   | read                                      |
| >0TX | 21   | done   | read                                      |
| ?0TX | 30   | done   | read                                      |
| @0TX | 35   | done   | read                                      |
| A0TX | 15   | done   | read                                      |
| B0TX | 13   | done   | read                                      |
| C0TX | 29   | done   | read                                      |
| D0TX | 31   | done   | read                                      |
| DALC | 108  | done   | read                                      |
| DATA | 108  | done   | read                                      |
| E0TX | 35   | done   | read                                      |
| F0TX | 35   | done   | read                                      |
| FNAM | 108  | done   | read                                      |
| G0TX | 15   | done   | read                                      |
| H0TX | 9    | done   | read                                      |
| HNAM | 93   | done   | read                                      |
| I0TX | 7    | done   | read                                      |
| IMSP | 108  | done   | read                                      |
| J0TX | 7    | done   | read                                      |
| JNAM | 108  | done   | read                                      |
| K0TX | 40   | done   | read                                      |
| L0TX | 92   | done   | read                                      |
| LNAM | 108  | done   | weather.ts: the cloud layer count (29, 4) |
| MNAM | 108  | done   | read                                      |
| MODL | 38   | done   | read                                      |
| MODT | 38   | n/a    | texture hashes                            |
| NAM0 | 108  | done   | read                                      |
| NAM1 | 108  | done   | read                                      |
| NAM2 | 10   | done   | weather.ts: moon glare colours (FX)       |
| NAM3 | 10   | done   | weather.ts: sun glare colours (FX)        |
| NNAM | 108  | done   | read                                      |
| PNAM | 108  | done   | read                                      |
| QNAM | 108  | done   | read                                      |
| RNAM | 108  | done   | read                                      |
| SNAM | 36   | done   | read                                      |
| TNAM | 87   | done   | read                                      |

### Alternate textures (MODS)

| Item                                 | Uses | Status | Where / why                    |
| ------------------------------------ | ---- | ------ | ------------------------------ |
| ACTI shape at the index (other name) | 7    | done   | swapTextures by 3D index       |
| ACTI shape at the index              | 570  | done   | swapTextures by 3D index       |
| ALCH shape at the index (other name) | 12   | done   | swapTextures by 3D index       |
| ALCH shape at the index              | 45   | done   | swapTextures by 3D index       |
| ARMO shape at the index              | 148  | done   | swapTextures by 3D index       |
| BOOK shape at the index              | 6    | done   | swapTextures by 3D index       |
| CONT shape at the index              | 26   | done   | swapTextures by 3D index       |
| DOOR shape at the index (other name) | 5    | done   | swapTextures by 3D index       |
| DOOR shape at the index              | 13   | done   | swapTextures by 3D index       |
| FLOR shape at the index              | 22   | done   | swapTextures by 3D index       |
| FURN shape at the index              | 63   | done   | swapTextures by 3D index       |
| INGR shape at the index (other name) | 1    | done   | swapTextures by 3D index       |
| INGR shape at the index              | 6    | done   | swapTextures by 3D index       |
| MISC shape at the index              | 14   | done   | swapTextures by 3D index       |
| MSTT shape at the index (other name) | 1    | done   | swapTextures by 3D index       |
| MSTT shape at the index              | 137  | done   | swapTextures by 3D index       |
| STAT no shape at the index           | 6    | done   | swaps nothing, as the original |
| STAT shape at the index (other name) | 17   | done   | swapTextures by 3D index       |
| STAT shape at the index              | 2100 | done   | swapTextures by 3D index       |
| WEAP shape at the index              | 4    | done   | swapTextures by 3D index       |
