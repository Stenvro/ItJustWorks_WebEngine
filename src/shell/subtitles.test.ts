import { describe, expect, it } from 'vitest';
import { subtitleText } from './subtitles.ts';

describe('subtitleText', () => {
  it("puts the speaker's name first in iSubtitleSpeakerNameColor", () => {
    expect(subtitleText('Never should have come here!', 'Bandit', 0x888888)).toBe(
      "<font color='#888888'>Bandit</font>: Never should have come here!",
    );
    expect(subtitleText('Hm?', 'A <b>', 0xabc)).toBe(
      "<font color='#000ABC'>A &lt;b&gt;</font>: Hm?",
    );
  });

  it('shows the line alone without a name', () => {
    expect(subtitleText('Hm?', '', 0x888888)).toBe('Hm?');
  });
});
