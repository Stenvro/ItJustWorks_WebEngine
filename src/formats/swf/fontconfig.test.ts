import { describe, expect, it } from 'vitest';
import { parseFontConfig, styleIsBold, styleIsItalic } from './fontconfig.ts';

const SAMPLE = [
  'fontlib "Interface\fonts_console.swf"',
  'fontlib "Interface\fonts_en.swf"',
  '',
  'map "$ConsoleFont" = "Consolas" Normal',
  'map "$EverywhereBoldFont" = "Futura Condensed" Bold',
  'map "$CClub_Font_Bold" = "Eurostile LT Cyr Std" Demi',
  'map "ControllerButtons" = "Controller  Buttons" Normal',
  'validNameChars "abc"',
].join('\r\n');

describe('parseFontConfig', () => {
  const config = parseFontConfig(SAMPLE);

  it('reads the font libraries in order', () => {
    expect(config.libraries).toEqual(['Interface\fonts_console.swf', 'Interface\fonts_en.swf']);
  });

  it('reads each mapping with its style, spaces in names kept', () => {
    expect(config.mappings).toEqual([
      { name: '$ConsoleFont', font: 'Consolas', style: 'Normal' },
      { name: '$EverywhereBoldFont', font: 'Futura Condensed', style: 'Bold' },
      { name: '$CClub_Font_Bold', font: 'Eurostile LT Cyr Std', style: 'Demi' },
      { name: 'ControllerButtons', font: 'Controller  Buttons', style: 'Normal' },
    ]);
  });

  it('keeps other settings', () => {
    expect(config.settings.get('validNameChars')).toBe('"abc"');
  });

  it('tells bold and italic styles', () => {
    expect(styleIsBold('Bold')).toBe(true);
    expect(styleIsBold('Demi')).toBe(true);
    expect(styleIsBold('Normal')).toBe(false);
    expect(styleIsItalic('BoldItalic')).toBe(true);
    expect(styleIsItalic('Roman')).toBe(false);
  });
});
