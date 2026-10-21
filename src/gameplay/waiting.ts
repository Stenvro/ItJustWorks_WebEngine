// Waiting and sleeping (the Sleep/Wait menu: src/shell/sleep-wait-menu.ts): when the game refuses
// them, by its messages (UESP "Skyrim:Sleep", "Skyrim:Wait"). Platform-independent.

/** Why the player may not wait (or sleep) now: the setting of the game's message, if any. */
export function noWaitReason(
  sleeping: boolean,
  state: {
    readonly waitingDisabled: boolean;
    readonly inAir: boolean;
    /** Guards pursue the player (crime). */
    readonly pursued?: boolean;
    /** The player trespasses where they are. */
    readonly trespassing?: boolean;
    /** Someone fights the player (the combat AI's). */
    readonly enemiesNear?: boolean;
    /** An effect takes the player's health now (poison, fire over time). */
    readonly takingHealthDamage?: boolean;
  },
): string | undefined {
  const kind = sleeping ? 'Sleep' : 'Wait';
  if (state.waitingDisabled) return `sNo${kind}Default`;
  if (state.inAir) return `sNo${kind}InAir`;
  if (state.enemiesNear === true) return `sNo${kind}HostileActorsNear`;
  if (state.takingHealthDamage === true) return `sNo${kind}TakingHealthDamage`;
  if (state.pursued === true) return `sNo${kind}WhileAlarm`;
  if (state.trespassing === true) return `sNo${kind}Trespass`;
  return undefined;
}
