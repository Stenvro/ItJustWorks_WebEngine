import { describe, expect, it } from 'vitest';
import { PapyrusArray } from '../scripting/values.ts';
import {
  globalLine,
  papyrusValueText,
  questStateLines,
  registrationLines,
  scriptLines,
} from './console-papyrus.ts';

const handleText = (): string => ' (00000014)';

describe("the console's script lines", () => {
  it('writes values as the VM writes them', () => {
    expect(papyrusValueText(2.9, 'int', handleText)).toBe('2');
    expect(papyrusValueText(1, 'Float', handleText)).toBe('1.000000');
    expect(papyrusValueText(false, 'bool', handleText)).toBe('False');
    expect(papyrusValueText('Whiterun', 'string', handleText)).toBe('"Whiterun"');
    expect(papyrusValueText(null, 'Actor', handleText)).toBe('None');
    expect(papyrusValueText(null, 'float[]', handleText)).toBe('[]');
    // A string too long for the VM's buffer is cut inside its quotes.
    expect(papyrusValueText('x'.repeat(300), 'string', handleText)).toHaveLength(255);
    // An array runs out of room with "...".
    const long = papyrusValueText(
      new PapyrusArray(Array.from({ length: 100 }, () => 12345)),
      'int[]',
      handleText,
    );
    expect(long.endsWith(', ...]')).toBe(true);
    expect(long.length).toBeLessThan(256);
  });

  it('says a script without variables has none', () => {
    expect(scriptLines({ script: 'Empty', state: '', variables: [] }, handleText)).toEqual([
      'Empty:',
      '\tScript state = ""',
      '\tNo variables',
    ]);
  });

  it('prints registrations, globals and a quest state as sqv and sglv do', () => {
    expect(registrationLines(undefined, 24)).toEqual([
      '\tRegistered for game-time update every 24.00 hours',
    ]);
    expect(globalLine('GameHour', 'f', 8.5)).toBe('GameHour = 8.5000');
    expect(globalLine('GameDaysPassed', 'l', 3.9)).toBe('GameDaysPassed = 3');
    expect(globalLine('Wrapped', 's', 40000)).toBe('Wrapped = -25536');
    expect(
      questStateLines({
        enabled: true,
        waitingForStage: false,
        waitingForPromotion: false,
        stage: 10,
        priority: 70,
      }),
    ).toEqual([
      '--- Quest state -----------------------------',
      'Enabled?\t\t\tYes',
      'State:\t\t\tRunning',
      'Current stage:\t10',
      'Priority:\t\t70',
    ]);
    expect(
      questStateLines({
        enabled: false,
        waitingForStage: true,
        waitingForPromotion: false,
        stage: 0,
        priority: 0,
      })[2],
    ).toBe('State:\t\t\tWaiting For Stage');
  });
});
