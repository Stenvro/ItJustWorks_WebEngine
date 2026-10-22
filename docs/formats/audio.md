# Sound files

Skyrim - Sounds.bsa and Skyrim - Voices_en0.bsa hold 81 655 sound files
(`src/formats/audio/`; listing and decoding: `node tools/audio-info.ts <file> [--decode]`,
`--audit [folder]` for all of them; every vanilla file parses):

| Kind                                              | Files           | Format                                                |
| ------------------------------------------------- | --------------- | ----------------------------------------------------- |
| Voice (`sound\voice\<plugin>\<voice type>\*.fuz`) | 75 408 (78.8 h) | FUZ: lip-sync + xWMA, 44100 Hz, mono (539 stereo)     |
| Sound effects (`sound\fx\...\*.wav`)              | 5 978 (4.5 h)   | WAV, 16-bit PCM, mono or stereo, 11025–44100 Hz       |
| Music (`music\...\*.xwm`)                         | 269 (5.8 h)     | xWMA stereo, 32000/44100 Hz (the main theme 48000 Hz) |

A file's kind follows from its content (RIFF form type), not its extension.

## RIFF

`"RIFF"`, u32 size of the rest, the form type (`"WAVE"`, `"XWMA"`), then chunks: four-character
id, u32 size, data, a pad byte after odd sizes. Some files state a RIFF size past their end; the
chunks are read up to the end of the file.

**`fmt `** (WAVEFORMATEX): u16 format tag (1 PCM, 3 IEEE float, 0x161 WMA v2, 0x162 WMA Pro,
0xFFFE extensible: its sub-format GUID starts with the real tag), u16 channels, u32 sample rate,
u32 bytes per second, u16 block align, u16 bits per sample.

## WAV

The samples in `data`, interleaved, `blockAlign` bytes per frame. Vanilla uses only 16-bit PCM;
8-, 24- and 32-bit PCM and 32-bit float are read too (mods), compressed WAV formats (ADPCM) are
rejected. Other chunks:

- **`smpl`** (sampler, 36 bytes + 24 per loop): u32 loop count at 28; per loop cue id, type,
  start and end frame (end inclusive). 329 vanilla effects have one, usually the whole file
  (`_lp` ambience loops); see the descriptor's looping type for how a loop plays
  ([esm.md](esm.md#sounds)).
- `LIST` (INFO tags from the editing tools) and `CDif` (unknown, from Bethesda's tools) are not
  needed.

## xWMA

Windows Media Audio packets as XAudio2 plays them: `fmt ` with tag 0x161 (all of vanilla), then
**`dpds`**: per packet of `blockAlign` bytes a u32, the decoded byte count (16-bit samples) up to
its end, so the last one gives the length (the main theme: 1842 packets, 11 311 104 frames,
235.65 s); `data`: the packets.

Decoding: WMA v2 is decoded by ffmpeg compiled to WebAssembly (`@ffmpeg/core` 0.12.10, the
single-threaded build, GPL-2.0-or-later; `src/audio/xwma-decoder.ts`): the file goes into
ffmpeg's memory file system and comes out as 32-bit float PCM at the file's rate. The core is
served from `node_modules` (no CDN); in Node `tools/ffmpeg-node.ts` loads it for tools and tests.
Decoding the 3:55 main theme takes about 0.9 s, a voice line 0.1 s. ffmpeg's decoder can
overshoot ±1 slightly (peaks of 1.16 in the main theme), as the original's does.

Music is streamed rather than decoded into memory: the worker writes it as a 16-bit PCM WAV
file (`decodeXwmaToWav`) at half its level (6 dB of headroom for those overshoots; the player
turns it back up), which the browser's media player plays. A 3:35 exploration track takes
38 MB that way instead of 76 MB of floats.

## FUZ

`"FUZE"`, u32 version (1), u32 size of the lip data, the lip data (a `.lip` file: the face
animation of the line, see LIP; 0 bytes for lines without it, such as shouts), then the audio
(RIFF `XWMA`).

## LIP

The face animation of a spoken line (`src/formats/audio/lip.ts`), as the Creation Kit
generates it with FaceFX; inside `.fuz` files, or beside a `.wav`/`.xwm` voice file. There is
no published specification: the layout below was worked out from the vanilla files and holds
for every one of them (74,070 lines in the SSE load order: `node tools/lip-info.ts --all`).
A community decoder (realfakenerd/wah-krah-jol, 2026) reads the same curves by searching for
the start of the data; reading the header as below needs no search.

| Offset | Type | Meaning                                                                     |
| -----: | ---- | --------------------------------------------------------------------------- |
|      0 | u32  | version: 1                                                                  |
|      4 | u32  | size of the expanded block, plus 16                                         |
|      8 | u32  | 13 for humanoid lines, 9 for creature lines (meaning unknown)               |
|     12 | …    | the block, byte-run compressed: a 0 byte is followed by a u16 count of zero |
|        |      | bytes; any other byte stands for itself                                     |

The expanded block: i32 frame count, i32 first frame (≤ 0: the frames before the audio
starts), i32 phoneme curve count (16, creatures 8), then frame by frame one f32 per curve.
Frames are 1/30 s apart: frame `f` is at `(f + first) / 30` seconds into the audio (the
last spoken phoneme lies a median 0.1 s before the audio ends, 80 % of lines within
−0.27…+0.14 s).

Humanoid lines (73,118) have 33 curves per frame: the 16 FaceGen phonemes (Aah, BigAah, BMP,
ChJSh, DST, Eee, Eh, FV, I, K, N, Oh, OohQ, R, Th, W), the 14 modifiers (BlinkLeft,
BlinkRight, BrowDownLeft, BrowDownRight, BrowInLeft, BrowInRight, BrowUpLeft, BrowUpRight,
LookDown, LookLeft, LookRight, LookUp, SquintLeft, SquintRight) and the head's pitch, roll
and yaw. The phoneme order holds against the lines' text: of 418 lines starting with th, w,
b/m/p, f/v or r, the first strong phoneme is Th 97/97, W 117/122, BMP 108/111, FV 39/40, R
25/26. The order of the modifiers follows from the data: curves 16/17 and 22/23 are always
equal (left and right blinks and brow raises), 18–21 and 28–29 are never used (the CK
generates no brow-down, brow-in or squint), 24–27 stay small (eye looks, ≤ 0.16), and only
the last three go negative (head rotation, −0.07…+0.16 radians). Creature lines (952:
dragons, rieklings, hagravens) have 8 curves: the phonemes of the creature's behavior graph's
lip variables, in their order (dragons' and hagravens' LipBigAah, LipDST, LipEee, LipFV, LipK,
LipL, LipR, LipTh; rieklings' LipAA ... LipTH), which move its mouth
(`creatureLipVariables`, src/animation/face.ts; docs/animation.md, "Faces"; TODO(M13): the
order is inferred, both list the same eight phonemes).
