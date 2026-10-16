// The animation event responses: meshes\responses\actorresponse.txt and
// playercharacterresponse.txt. One "event : handler" per line: which engine handler answers an
// event an actor's behavior graph raises (weaponSwing → WeaponRightSwingHandler, HitFrame →
// HitFrameHandler). "BackupResponse : ActorResponse" makes the player's list fall back to the
// actors' one for the events it does not name.
// Notes: docs/formats/hkx.md ("Animation data").

export interface AnimationResponses {
  /** Handler class by lower-case event name, in file order. */
  readonly handlers: ReadonlyMap<string, string>;
  /** The list it falls back to ("ActorResponse"), from BackupResponse. */
  readonly backup: string | undefined;
}

export function parseAnimationResponses(text: string): AnimationResponses {
  const handlers = new Map<string, string>();
  let backup: string | undefined;
  for (const raw of text.split(/\r?\n/)) {
    const colon = raw.indexOf(':');
    if (colon < 0) continue;
    const event = raw.slice(0, colon).trim().toLowerCase();
    const handler = raw.slice(colon + 1).trim();
    if (event === '' || handler === '') continue;
    if (event === 'backupresponse') backup = handler;
    else handlers.set(event, handler);
  }
  return { handlers, backup };
}

/** The handler of an event (any case): the list's own, else its backup's. */
export function animationResponse(
  event: string,
  responses: AnimationResponses,
  backup?: AnimationResponses,
): string | undefined {
  const key = event.toLowerCase();
  return responses.handlers.get(key) ?? backup?.handlers.get(key);
}
