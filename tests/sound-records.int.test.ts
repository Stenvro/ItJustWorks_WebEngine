// Integration test: the sound and music records of the local game data. Skipped without game
// data.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadCellData } from '../src/world/cell-loader.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import {
  MusicTypeFlag,
  parseAcousticSpace,
  parseMusicTrack,
  parseMusicType,
  parseRegionAudio,
  parseReverb,
  parseSoundCategory,
  parseSoundDescriptor,
  parseSoundOutputModel,
  soundFileCandidates,
  type SoundCategory,
} from '../src/world/sound-records.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { DefaultObjects, DefaultObjectUse } from '../src/world/default-objects.ts';
import { parseWorldspace } from '../src/world/worldspace.ts';
import { hasGamedata, openGameFolder } from '../tools/gamedata-path.ts';

describe.skipIf(!hasGamedata())('sound records in the local game data', () => {
  let vfs: Vfs;
  let db: RecordDatabase;
  const byEditorId = async (type: string, editorId: string) => {
    for (const formId of db.formIdsOfType(type)) {
      const record = await db.get(formId);
      if (record?.editorId === editorId) return record;
    }
    throw new Error(`${type} ${editorId} not found`);
  };

  beforeAll(async () => {
    vfs = await Vfs.mount(openGameFolder());
    db = await RecordDatabase.open(vfs);
  }, 60_000);
  afterAll(async () => {
    await db.close();
    await vfs.close();
  });

  it('finds the files of nearly every sound descriptor, as the engine does', async () => {
    let files = 0;
    let found = 0;
    for (const formId of db.formIdsOfType('SNDR')) {
      const record = await db.get(formId);
      if (!record) continue;
      for (const path of parseSoundDescriptor(record).files) {
        files++;
        if (soundFileCandidates(path).some((candidate) => vfs.has(candidate))) found++;
      }
    }
    expect(files).toBeGreaterThan(6000);
    // 50 vanilla names point at files that were never shipped.
    expect(files - found).toBeLessThanOrEqual(50);
  }, 60_000);

  it('reads a looping descriptor with its category and output model', async () => {
    const loop = parseSoundDescriptor(await byEditorId('SNDR', 'AMBDungeonDwemerFlameLPSD'));
    expect(loop.looping).toBe('loop');
    expect(loop.files.every((path) => path.startsWith('sound\\fx\\'))).toBe(true);
    expect(loop.category).toBeDefined();
    const model = parseSoundOutputModel(await byEditorId('SOPM', 'SOMMono01400_verb'));
    expect(model.uses3d).toBe(true);
    expect(model.reverbSend).toBeCloseTo(1);
    expect(model.attenuation).toEqual({
      minDistance: 150,
      maxDistance: 1400,
      curve: [100, 50, 20, 5, 0],
    });
  });

  it('builds the category tree under the master category', async () => {
    const categories = new Map<number, SoundCategory>();
    for (const formId of db.formIdsOfType('SNCT')) {
      const record = await db.get(formId);
      if (record) categories.set(formId, parseSoundCategory(record));
    }
    const master = [...categories.values()].find((c) => c.editorId === '_AudioCategoryMaster');
    expect(master?.parent).toBeUndefined();
    for (const category of categories.values()) {
      // Every category leads up to the master.
      let at: SoundCategory | undefined = category;
      for (let guard = 0; at?.parent !== undefined && guard < 16; guard++) {
        at = categories.get(at.parent);
      }
      expect(at?.editorId, category.editorId).toBe('_AudioCategoryMaster');
    }
    const music = [...categories.values()].find((c) => c.editorId === 'AudioCategoryMUS');
    expect(music?.volume).toBeCloseTo(0.7, 2);
    expect(music?.onMenu).toBe(true);
  });

  it('reads music types and tracks, files under music\\ with cue points and finales', async () => {
    const reward = parseMusicType(await byEditorId('MUSC', 'MUSDungeonCleared'));
    expect(reward.flags & MusicTypeFlag.playsOneSelection).not.toBe(0);
    expect(reward.tracks).toHaveLength(4);
    const combat = parseMusicTrack(await byEditorId('MUST', 'MUSCombat06'));
    expect(combat.type).toBe('single');
    expect(combat.file).toBe('music\\combat\\mus_combat_06.wav');
    expect(soundFileCandidates(combat.file ?? '').some((path) => vfs.has(path))).toBe(true);
    expect(combat.finale).toBe('music\\combat\\mus_combat_06_finale.wav');
    expect(combat.cuePoints[0]).toBeCloseTo(8.23, 2);
    const chant = parseMusicTrack(await byEditorId('MUST', 'MUSSovngardeChantLP'));
    expect(chant.loop?.end).toBeCloseTo(209.24, 2);
    const spacer = parseMusicTrack(await byEditorId('MUST', '_MUSExploreSILENT15TypeSpacerNIGHT'));
    expect(spacer.type).toBe('silent');
    expect(spacer.duration).toBe(15);
    expect(spacer.conditions.length).toBeGreaterThan(0);
  });

  it("lists Breezehome's sounds: its loops, door sounds and acoustic space", async () => {
    const data = await loadCellData(db, 0x000165a8);
    expect(data.emitters.length).toBeGreaterThan(0);
    for (const emitter of data.emitters) {
      const record = await db.require(emitter.descriptor);
      expect(record.type).toBe('SNDR');
      const descriptor = parseSoundDescriptor(record);
      expect(descriptor.files.length, descriptor.editorId).toBeGreaterThan(0);
    }
    const door = data.objects.find((object) => object.teleport);
    expect(door?.sounds?.open).toBeDefined();
    expect(door?.sounds?.close).toBeDefined();
    const space = data.cell.acousticSpace;
    expect(space).toBeDefined();
    expect((await db.require(space ?? 0)).editorId).toBe('IntRoomWoodMediumAcousticSpace');
  });

  it('reads acoustic spaces and their reverb', async () => {
    const space = parseAcousticSpace(await byEditorId('ASPC', 'IntDungeonBlackreachAcousticSpace'));
    expect(space.ambient).toBeDefined();
    const reverb = parseReverb(await db.require(space.reverb ?? 0));
    expect(reverb?.editorId).toBe('IntRoomStoneLargeReverb');
    expect(reverb?.decayTime).toBe(2877);
    expect(reverb?.room).toBe(-3);
  });

  it('reads the sounds and music of regions (REGN RDAT type 7)', async () => {
    const forest = parseRegionAudio(await byEditorId('REGN', 'WeatherPineForest'));
    expect(forest.sounds).toHaveLength(60);
    expect((await db.require(forest.music ?? 0)).editorId).toBe('MUSExploreForestPine');
    const town = parseRegionAudio(await byEditorId('REGN', 'AudioExtForestPineTownRegion'));
    const crickets = town.sounds[0];
    expect((await db.require(crickets?.sound ?? 0)).editorId).toBe('AMBrCricketsIndividual01SD');
    expect(crickets?.flags).toBe(0xb);
    expect(crickets?.chance).toBeCloseTo(0.02);
    // Data-wide: loops always play (chance 1), single sounds get a small chance per check.
    for (const formId of db.formIdsOfType('REGN')) {
      const region = await db.require(formId);
      for (const entry of parseRegionAudio(region).sounds) {
        const record = await db.require(entry.sound);
        expect(record.type, region.editorId).toBe('SNDR');
        const looping = parseSoundDescriptor(record).looping !== 'none';
        if (looping) expect(entry.chance, record.editorId).toBe(1);
        else expect(entry.chance, record.editorId).toBeLessThan(0.11);
        expect(entry.flags & ~0xf, record.editorId).toBe(0);
      }
    }
    // Interiors take their region sounds from their acoustic space.
    const fort = parseAcousticSpace(await byEditorId('ASPC', 'IntDungeonFortAcousticSpace'));
    expect((await db.require(fort.region ?? 0)).editorId).toBe('AudioIntDungeonFort01');
    expect(forest.priority).toBe(50);
  });

  it('reads the palettes of exploration music as layers', async () => {
    const palette = parseMusicTrack(await byEditorId('MUST', 'MUSExploreForestPineDayPalette'));
    expect(palette.type).toBe('palette');
    expect(palette.duration).toBe(120);
    expect(palette.fadeOut).toBe(15);
    expect(palette.layers).toHaveLength(2);
    const first = await db.require(palette.layers[0]?.[0] ?? 0);
    expect(first.editorId).toBe('MUSExploreForestPineDayPaletteA01');
    const second = await db.require(palette.layers[1]?.[0] ?? 0);
    expect(second.editorId).toBe('MUSExploreForestPineDayPaletteB01');
  });

  it('reads the default objects: the music category, default and combat music', async () => {
    const objects = await DefaultObjects.read(db);
    const name = async (use: string) => (await db.require(objects.get(use) ?? 0)).editorId;
    expect(await name(DefaultObjectUse.musicCategory)).toBe('AudioCategoryMUS');
    expect(await name(DefaultObjectUse.defaultMusic)).toBe('MUSExploreTestb');
    expect(await name(DefaultObjectUse.battleMusic)).toBe('MUSCombat');
    expect(await name(DefaultObjectUse.dungeonClearedMusic)).toBe('MUSDungeonCleared');
    // Later plugins add their own uses (HearthFires, Dragonborn: KWSP).
    expect(objects.get('KWSP')).toBe(0x3c);
  });

  it('names the music of worldspaces and cells', async () => {
    const music = async (editorId: string) => {
      const world = parseWorldspace(await byEditorId('WRLD', editorId));
      return (await db.require(world.music ?? 0)).editorId;
    };
    expect(await music('Tamriel')).toBe('_NONE');
    expect(await music('WhiterunWorld')).toBe('MUSTownTest');
    const breezehome = await loadCellData(db, 0x000165a8);
    expect((await db.require(breezehome.cell.musicType ?? 0)).editorId).toBe('MUSTownTest');
  });
});
