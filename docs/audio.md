# Audio

How the game's sounds play in the browser (`src/audio/`). Files: [formats/audio.md](formats/audio.md);
records: [formats/esm.md](formats/esm.md#sounds), [music](formats/esm.md#music) and
[default objects](formats/esm.md#default-objects).

## Loading

Sound files are read through the VFS on the main thread and decoded in the audio worker
(`src/workers/audio-worker.ts`): WAV directly, xWMA (music, voices) with ffmpeg.wasm, which
loads on the first xWMA file (~0.5 s with the main theme). A descriptor's file is found as the
engine finds it (its name, else the other extension). Decoded files are kept as Web Audio
buffers up to 256 MB, least recently used first out (a playing sound keeps its buffer).

Browsers start audio only after a user gesture: the first click or key resumes the audio
context.

## The graph

- **Categories** (SNCT): one gain per category, connected as the categories' tree to the
  master: a category plays at its own volume × its parents' (`_AudioCategoryMaster` 0.9 ×
  SFX 0.9 × ...) × the user's slider for categories that have one (the slider's default,
  UNAM, until the settings menu: TODO(M9)).
- **A sound** (`sound-instance.ts`): a buffer source at the descriptor's pitch (frequency
  shift ± a random variation, percent), a gain for its static attenuation and a random cut of
  up to its dB variance, a gain for the output model's distance curve, then a 3D panner (HRTF;
  output models that use HRTF) or fixed speaker levels (output models with defined speaker
  output: the mono / stereo-left / stereo-right rows onto left and right, centre at −3 dB to
  both, rear speakers to their side; no surround output yet), into its category. Its output
  model's reverb send goes to the reverb bus (at its category's volume).
- **Distance:** the panner only pans; the volume follows the output model's curve
  ([esm.md](formats/esm.md#sounds)), smoothed over 50 ms. Output models without distance
  attenuation play at full volume wherever they play.
- **Looping** (descriptor LNAM): loop plays the file's loop region (WAV `smpl`, else the whole
  file) until stopped; envelope fast and slow also play the part before the loop once (attack)
  and, when stopped, the part after it (release): fast jumps there at once, slow finishes the
  loop's pass first. Sounds stopped because their cell unloads stop at once.
- **The listener** is at the camera, facing along it, Z up.

## Placed sounds

The loaded cells' sound markers (SOUN) and the looping sounds of activators, moveable
statics, talking activators, lights (torches crackle) and doors (CellSoundEmitter) play while
the listener is within their output model's maximum distance (and stop 10 % beyond it, so
they do not flicker at the edge); those without distance attenuation play while their cell is
loaded. Doors and containers play their open and close sounds when used; load doors their
open sound as the player goes through.

## Acoustic spaces

Interiors have one (cell XCAS); in exteriors placed acoustic spaces (ASPC references) take
effect inside their box. The space in effect gives the reverb (REVB) and its ambience loop
(SNDR, 2D); switching spaces fades the old loop out and the new one in (`[Audio]`
fASFadeOutTime 8 s, fASFadeInTime 3 s). In interiors the space's region (RDAT) gives the
region sounds (below); the Creation Kit offers that field for interiors only. The
reverb is a convolver with an impulse response built from the I3DL2 parameters (decay, HF
decay ratio at the HF reference, room and room HF level, reflections and reverb level and
delay; `reverb.ts`): XAudio2's own algorithm is not documented, so this is an approximation
(TODO(M13): compare with the game). Spaces without reverb (DefaultReverb, −100 dB) have none.

## Ambience

`ambience.ts`, updated every frame with the surroundings the viewers give
(`SoundSystem.setAmbience`): the regions of the camera's cell (XCLR; indoors the acoustic
space's region), the weather and the one being left during a change, the game hour, indoors
or not, and the last lightning flash.

- **Region sounds** (REGN RDAT type 7, RDSA): each entry names the weather classifications it
  plays in (WTHR DATA flags pleasant, cloudy, rainy, snow; indoors all). Looping entries
  (vanilla: all chance 1) play 2D while the region holds and their conditions hold, fading in
  over `[Audio] fRegionLoopFadeInTime` (6 s) and out over fRegionLoopFadeOutTime (8 s). The
  others (vanilla: chance 0.01–0.1) get their chance once a second, at most
  uRegionSoundsAllowedPerUpdate (1) starting per check, placed in a random direction
  fRegionRandomSoundPlacementBase (100) + up to fRegionSoundPlacementRandomOffset (650) units
  away and fRegionSoundPlacementZOffset (256) up. The engine's audio thread runs every 33 ms
  (uAudioThreadSleepTimeGameMode); chances that small cannot be per update, so the once-a-second
  check is inferred (TODO(M13): compare with the game). A pine forest gives a wind bed,
  cicadas in the morning and a bird call or gust every few seconds; a fort interior creaks.
- **Weather sounds** (WTHR SNAM): looping ones (rain, wind) play 2D at the weather's share of
  a change (the old weather's at the rest), so rain fades in as the clouds come. Thunder
  (type 3) follows each lightning flash after 0.5–3 s (inferred: TODO(M13)); a weather's other
  single sounds (gusts in a snowstorm, distant thunder in overcast rain, which has no
  lightning) come at random with a 4 % chance a second (WTHR has no chance of its own; the
  median of the region one-shots'; TODO(M13)).
- **Conditions** (`sound-conditions.ts`) of ambient sounds use GetCurrentTime (308 uses),
  GetIsCurrentWeather (96), IsInInterior (38), IsRaining and GetGlobalValue (one each: the
  distant catapults of SkyrimOvercastWar while CWDistantCatapultsAMB is 1). Globals have their
  starting value (FLTV) until scripts run: TODO(M8).

## Music

`music.ts` decides what plays, `music-output.ts` plays it. Music types are in play: the
location's and those game events add (combat: BTMS, TODO(M10); discoveries, quest moments
and the rest through Papyrus MusicType.Add / Remove, TODO(M8)). The location's is the cell's
XCMO; indoors else the default object DFMS; outdoors else the music of the camera cell's
regions in effect (RDMO; the same priority and override rule as region sounds), the
worldspace's ZNAM, then DFMS. Tamriel's ZNAM is `_NONE`, so the regions give its music:
Riverwood's pine forest plays MUSExploreForestPine.

- **Which type plays:** the most important in play (lowest priority number; the latest added
  of equals). One flagged Doesn't Queue is dropped when it cannot play at once.
- **Ducking:** a more important type flagged Ducks Current Track (combat, discoveries) plays
  over the current one, which goes on at its Ducking dB lower (combat 100 dB: silent;
  MUSDiscoveryGeneric 3 dB) and comes back up once the ducking music has ended — combat after
  its finale. The fade takes the ducking type's Fade Duration (combat 9 s), else `[Audio]`
  fMusicDuckingSeconds / fMusicUnDuckingSeconds (6 and 8 s in Skyrim_Default.ini).
- **Other changes:** the current music leaves first, then the new type starts. A track with
  cue points (combat) plays on to its next one and crossfades into its finale
  (fMusicFinaleCrossFadeTimeIn 3 s, fMusicFinaleCrossFadeTimeOut 6 s); else it fades out over
  the arriving type's Fade Duration (the Creation Kit: how long another type fades for it),
  else the leaving one's. An abrupt transition starts the new type at once while the old one
  fades. Which fade applies where is inferred from the Creation Kit's descriptions:
  TODO(M13): compare with the game.
- **Tracks:** in order (Maintain Track Order) or shuffled per pass; those whose conditions do
  not hold are skipped (day and night pieces, weathers); after the list a type plays on only
  if it cycles, and Plays One Selection ends it after one track. Silent tracks are pauses
  (the exploration types alternate music and 10–30 s silences). A palette plays its layers at
  once, each layer's pieces one after another at random, for its duration, then fades out.
  Single tracks loop between LNAM's points as often as it says (the Sovngarde chant).
- **Playing:** each type has a bus (a gain ducking turns down) into the music category
  (default object MDSC: AudioCategoryMUS, 0.7 × the master). Files stream through `<audio>`
  elements ([formats/audio.md](formats/audio.md#xwma)); the next file of each sequence is
  decoded while the current one plays, and decoded files are kept up to 192 MB, the least
  recently used ones that are not playing going first. Music follows the audio clock and
  waits while audio is suspended (before the first click).
