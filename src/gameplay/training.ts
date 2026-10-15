// Training's rules (UESP, "Trainers"): a session raises a skill by one level, at most five a
// player level, up to the trainer's class's limit (CLAS DATA: Journeyman 50, Expert 75, Master
// 90). A session at skill b costs n(10b + 5n + 45) for n = 1 up to 50, n(30b + 15n + 35) above,
// n(50b + 25n + 25) above 75: fTrainingMultCost (10) times the tier's multiplier (1,
// iTrainingExpertCost 3, iTrainingMasterCost 5) times b, plus 50. Platform-independent.

/** Sessions a player level allows. */
export const TRAININGS_PER_LEVEL = 5;

export function trainingCost(
  skill: number,
  settings: { readonly multCost: number; readonly expertCost: number; readonly masterCost: number },
): number {
  const tier = skill > 75 ? settings.masterCost : skill > 50 ? settings.expertCost : 1;
  return settings.multCost * tier * skill + 50;
}
