// Which file a sound plays at once when the file it picked is not in memory yet (observed in
// the original): its audio cache is searched first for that file; failing that for another file
// of the same descriptor (one of them at random), then for a file of its "Alternate Sound For"
// descriptor (SNDR SNAM: the player's footsteps on wood have FSTPlayerDirtWalkLSD, the item
// sounds ITMGenericUpLoFi, 247 descriptors in all); that file plays now with the requested
// sound's own category, output model and attenuation, while the picked file loads for the next
// time. With none of them in memory the sound waits for its file. Pure: sound-system.ts asks it.

/**
 * The file to play now in place of `wanted` (undefined: none is ready, wait for `wanted`):
 * `wanted` itself if ready, else a ready file of the same descriptor, else a ready file of
 * its alternate.
 */
export function readyStandIn(
  wanted: string,
  files: readonly string[],
  alternateFiles: readonly string[],
  ready: (path: string) => boolean,
  random: () => number,
): string | undefined {
  if (ready(wanted)) return wanted;
  const pick = (paths: readonly string[]): string | undefined =>
    paths.length === 0
      ? undefined
      : paths[Math.min(paths.length - 1, Math.floor(random() * paths.length))];
  return (
    pick(files.filter((path) => path !== wanted && ready(path))) ??
    pick(alternateFiles.filter((path) => ready(path)))
  );
}
