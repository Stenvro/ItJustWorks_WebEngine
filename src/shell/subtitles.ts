// A general subtitle as the HUD shows it (ShowSubtitle takes HTML; src/shell/world-lines.ts).

/**
 * The line with its speaker's name first, in [Interface] iSubtitleSpeakerNameColor (0xRRGGBB),
 * when there is one to show (bShowSubtitleSpeakerName; observed in the original:
 * "<font color='#888888'>Name</font>: text").
 */
export function subtitleText(text: string, speaker: string, color: number): string {
  if (!speaker) return text;
  const hex = (Math.max(0, Math.round(color)) & 0xffffff)
    .toString(16)
    .toUpperCase()
    .padStart(6, '0');
  return `<font color='#${hex}'>${escapeHtml(speaker)}</font>: ${text}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
