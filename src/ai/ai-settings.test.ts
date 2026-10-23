import { describe, expect, it } from 'vitest';
import { AI_DEFAULTS, aiSettingNames, aiSettingsOf, readAiSettings } from './ai-settings.ts';

describe('AI settings', () => {
  it("take the load order's values over the engine's built-in ones", () => {
    const esm = readAiSettings(
      (name) => ({ fAIMarkerDestinationRadius: 50, fAIFurnitureDestinationRadius: 150 })[name],
    );
    expect(esm.markerDestinationRadius).toBe(50);
    expect(esm.furnitureDestinationRadius).toBe(150);
    // Not in Skyrim.esm: the engine's own.
    expect(esm.evaluatePackageTimer).toBe(15);
    expect(esm.horseSearchDistance).toBe(3000);
    expect(AI_DEFAULTS.markerDestinationRadius).toBe(25);
    expect(aiSettingNames()).toContainEqual(['fBigBumpSpeed', 600]);
  });

  it("are a source's built-in values until its settings are read, then its own", async () => {
    interface Read {
      number(name: string): number | undefined;
    }
    let resolve: (value: Read) => void = () => undefined;
    const source = {
      settings: () =>
        new Promise<Read>((done) => {
          resolve = done;
        }),
    };
    expect(aiSettingsOf(source)).toBe(AI_DEFAULTS);
    resolve({ number: (name) => (name === 'fEvaluatePackageTimer' ? 7 : undefined) });
    await Promise.resolve();
    await Promise.resolve();
    expect(aiSettingsOf(source).evaluatePackageTimer).toBe(7);
  });
});
