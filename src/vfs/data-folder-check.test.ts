import { describe, expect, it } from 'vitest';
import {
  checkDataFolder,
  REQUIRED_ARCHIVES,
  REQUIRED_MASTERS,
  type FolderEntry,
} from './data-folder-check.ts';

const file = (name: string): FolderEntry => ({ name, kind: 'file' });
const dir = (name: string): FolderEntry => ({ name, kind: 'directory' });

const complete: FolderEntry[] = [
  ...REQUIRED_MASTERS.map(file),
  ...REQUIRED_ARCHIVES.map(file),
  file('Skyrim - Voices_en0.bsa'),
  file('ccBGSSSE037-Curios.esl'),
  dir('Video'),
];

describe('checkDataFolder', () => {
  it('accepteert een complete Data-map', () => {
    const report = checkDataFolder(complete);
    expect(report.ok).toBe(true);
    expect(report.missing).toEqual([]);
    expect(report.plugins).toContain('ccBGSSSE037-Curios.esl');
    expect(report.plugins).toHaveLength(REQUIRED_MASTERS.length + 1);
    expect(report.archives).toHaveLength(REQUIRED_ARCHIVES.length + 1);
  });

  it('vergelijkt hoofdletterongevoelig en behoudt de originele schrijfwijze', () => {
    const report = checkDataFolder(complete.map((e) => ({ ...e, name: e.name.toUpperCase() })));
    expect(report.ok).toBe(true);
    expect(report.plugins).toContain('SKYRIM.ESM');
  });

  it('accepteert stemmen in een andere taal', () => {
    const report = checkDataFolder(
      complete.map((e) =>
        e.name === 'Skyrim - Voices_en0.bsa' ? file('Skyrim - Voices_de0.bsa') : e,
      ),
    );
    expect(report.ok).toBe(true);
  });

  it('meldt ontbrekende bestanden', () => {
    const report = checkDataFolder(
      complete.filter((e) => e.name !== 'Dragonborn.esm' && !e.name.includes('Voices')),
    );
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(['Dragonborn.esm', 'Skyrim - Voices_*0.bsa']);
  });

  it('herkent de installatiemap in plaats van Data', () => {
    const report = checkDataFolder([file('SkyrimSE.exe'), dir('Data'), dir('Skyrim')]);
    expect(report.ok).toBe(false);
    expect(report.looksLikeGameRoot).toBe(true);
  });
});
