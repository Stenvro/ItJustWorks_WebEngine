// Skills, levels and actor values from the real data (src/gameplay/progression.ts,
// actor-leveling.ts, vitals.ts; the running engine: src/scripting/runtime/progression-engine.ts).
//
//   node tools/progression-info.ts                     every skill's use and improvement (AVSK),
//                                                      experience to its levels, the character's
//                                                      levels, regeneration and stamina costs
//   node tools/progression-info.ts --level-up          the engine raising the player's skills
//                                                      until a level-up waits, then taking it
//   node tools/progression-info.ts --npc HousecarlWhiterun --player-level 20 --follower
//                                                      an NPC's level and auto-calculated stats
//                                                      (as the player's follower)
//   node tools/progression-info.ts --npc EncSoldierImperialImperialM01MaleSoldier --level 10
//                                                      ... at a level of its own
//   node tools/progression-info.ts --audit             every auto-calculated NPC_ against the
//                                                      stats the Creation Kit stored in it

import { parseArgs } from 'node:util';
import { actorLevel, autoCalcStats, levelingSettings } from '../src/gameplay/actor-leveling.ts';
import {
  experienceToLevel,
  levelThreshold,
  progressionSettings,
  skillThreshold,
} from '../src/gameplay/progression.ts';
import {
  bashCost,
  powerAttackCost,
  regenPerSecond,
  sprintDrain,
  vitalSettings,
} from '../src/gameplay/vitals.ts';
import { PLAYER_REF } from '../src/scripting/runtime/forms.ts';
import { ScriptRuntime } from '../src/scripting/runtime/runtime.ts';
import { ScriptLibrary } from '../src/scripting/script-library.ts';
import { NpcFlag, TemplateFlag } from '../src/world/actor-records.ts';
import { parseNpcStats, parseRaceStats } from '../src/world/actor-stats-records.ts';
import { ActorValue, actorValueName, SKILL_COUNT } from '../src/world/actor-values.ts';
import { GameSettings } from '../src/world/game-settings.ts';
import { parseClassStats } from '../src/world/leveling-records.ts';
import { parseSkill } from '../src/world/perk-trees.ts';
import { RecordDatabase } from '../src/world/record-db.ts';
import { Vfs } from '../src/vfs/vfs.ts';
import { openGameFolder } from './gamedata-path.ts';

const { values } = parseArgs({
  options: {
    'level-up': { type: 'boolean', default: false },
    npc: { type: 'string' },
    level: { type: 'string' },
    'player-level': { type: 'string', default: '1' },
    follower: { type: 'boolean', default: false },
    audit: { type: 'boolean', default: false },
  },
});

const vfs = await Vfs.mount(openGameFolder());
const db = await RecordDatabase.open(vfs);
const gmst = await GameSettings.read(db);
const number = (id: string): number | undefined => gmst.number(id);
const progression = progressionSettings(number);
const leveling = levelingSettings(number);
const vitals = vitalSettings(number);
const hex = (id: number | undefined): string =>
  (id ?? 0).toString(16).toUpperCase().padStart(8, '0');
const fixed = (n: number, digits = 1): string => n.toFixed(digits);
/** A float setting as written (1.95, not 1.9500000476837158). */
const short = (n: number): string => String(Number(n.toPrecision(6)));

function newRuntime(): ScriptRuntime {
  const library = new ScriptLibrary(async (name) => {
    const path = `scripts\\${name}.pex`;
    return vfs.has(path) ? vfs.read(path) : undefined;
  });
  return new ScriptRuntime(db, library);
}

async function findNpc(query: string): Promise<number | undefined> {
  if (/^[0-9a-f]{1,8}$/i.test(query) && (await db.get(parseInt(query, 16)))?.type === 'NPC_')
    return parseInt(query, 16);
  for (const formId of db.formIdsOfType('NPC_')) {
    if ((await db.get(formId))?.editorId?.toLowerCase() === query.toLowerCase()) return formId;
  }
  return undefined;
}

if (values.npc !== undefined) {
  const base = await findNpc(values.npc);
  if (base === undefined) {
    console.log(`no NPC_ ${values.npc}`);
  } else {
    const runtime = newRuntime();
    runtime.state.actor(PLAYER_REF).level = Number(values['player-level']) || 1;
    // The NPC's placed reference, else one made for it.
    const placed = (await runtime.persistentIndex()).byBase.get(base)?.[0];
    const reference = placed ?? runtime.state.create(base);
    if (values.follower) runtime.state.actor(reference).playerTeammate = true;
    if (values.level !== undefined) runtime.state.actor(reference).level = Number(values.level);
    const info = await runtime.actors.info(reference);
    const stats = info?.stats;
    if (!info || !stats) {
      console.log(`${values.npc}: not an actor`);
    } else {
      const record = await db.get(info.leveled);
      const follows = (stats.flags & NpcFlag.pcLevelMult) !== 0;
      console.log(
        `${record?.editorId ?? ''} [${hex(info.leveled)}] as ${placed === undefined ? 'a made' : 'its placed'} reference [${hex(reference)}]`,
      );
      console.log(
        `  ${follows ? `level × ${String(stats.level / 1000)} of ${values.follower ? "the player's" : "its encounter's"} level (calc ${String(stats.calcMinLevel)}..${String(stats.calcMaxLevel || '-')})` : `level ${String(stats.level)}`}` +
          `, auto calc stats ${(stats.flags & NpcFlag.autoCalcStats) !== 0 ? 'on' : 'off'}, class [${hex(stats.class)}] ${(await db.get(stats.class ?? 0))?.editorId ?? ''}`,
      );
      console.log(
        `  player level ${values['player-level']} → its level ${String(await runtime.actors.level(reference))}`,
      );
      const value = async (index: number): Promise<number> =>
        (await runtime.actors.value(reference, index)).base;
      console.log(
        `  health ${String(await value(ActorValue.health))}, magicka ${String(await value(ActorValue.magicka))}, stamina ${String(await value(ActorValue.stamina))}` +
          `  (stored: ${String(stats.health)}, ${String(stats.magicka)}, ${String(stats.stamina)})`,
      );
      const skills: string[] = [];
      for (let i = 0; i < SKILL_COUNT; i++) {
        const index = ActorValue.firstSkill + i;
        skills.push(
          `${actorValueName(index)} ${String(await value(index))} (${String(stats.skills[i] ?? 0)})`,
        );
      }
      for (let i = 0; i < skills.length; i += 6)
        console.log(`  ${skills.slice(i, i + 6).join(', ')}`);
    }
  }
} else if (values['level-up']) {
  // The engine at work: skill increases from a new character's skills until a level-up waits.
  const runtime = newRuntime();
  runtime.progression.listener = {
    skillIncreased: (increase) => {
      console.log(
        `  ${increase.text}: character ${fixed(runtime.state.playerExperience, 0)} / ${fixed(levelThreshold(increase.playerLevel, progression), 0)} experience, level meter ${fixed(increase.from * 100, 0)} → ${fixed(increase.to * 100, 0)} %`,
      );
    },
  };
  runtime.world = {
    notification: (text) => {
      console.log(`  HUD: ${text}`);
    },
  };
  const skills = [ActorValue.firstSkill + 0, ActorValue.firstSkill + 8, ActorValue.firstSkill + 11];
  for (let i = 0; runtime.state.levelUps === 0 && i < 100; i++)
    await runtime.progression.incrementSkill(skills[i % skills.length] ?? ActorValue.firstSkill);
  const value = async (index: number): Promise<number> =>
    (await runtime.actors.value(PLAYER_REF, index)).base;
  console.log(
    `level-ups waiting: ${String(runtime.state.levelUps)}; before: level ${String(await runtime.actors.playerLevel())}, health ${String(await value(ActorValue.health))}, stamina ${String(await value(ActorValue.stamina))}, carry weight ${String(await value(ActorValue.carryWeight))}, perk points ${String(runtime.perkPoints)}`,
  );
  await runtime.progression.levelUp(ActorValue.stamina);
  console.log(
    `stamina chosen: level ${String(await runtime.actors.playerLevel())}, health ${String(await value(ActorValue.health))}, stamina ${String(await value(ActorValue.stamina))}, carry weight ${String(await value(ActorValue.carryWeight))}, perk points ${String(runtime.perkPoints)}, experience left ${fixed(runtime.state.playerExperience, 0)}, progress ${fixed((await runtime.progression.levelProgress()) * 100, 0)} %`,
  );
  // A lock of each level and a broken pick, at Lockpicking 15.
  const lockpicking = ActorValue.firstSkill + 8;
  const curve = await runtime.progression.curve(lockpicking);
  if (curve) {
    const uses = ['VeryEasy', 'Easy', 'Average', 'Hard', 'VeryHard', 'Broken'].map(
      (name) =>
        `${name} ${fixed(curve.useMult * (number(`fSkillUsageLockPick${name}`) ?? 0) + curve.useOffset, 2)}`,
    );
    console.log(
      `Lockpicking experience a lock (and a broken pick): ${uses.join(', ')}; 15→16 needs ${fixed(skillThreshold(15, curve, progression), 2)}`,
    );
  }
} else if (values.audit) {
  let total = 0;
  let attributes = 0;
  let skills = 0;
  const differ = { fixed: 0, follows: 0 };
  for (const formId of db.formIdsOfType('NPC_')) {
    const record = await db.get(formId);
    if (!record) continue;
    const npc = parseNpcStats(record);
    if ((npc.flags & NpcFlag.autoCalcStats) === 0) continue;
    if ((npc.templateFlags & (TemplateFlag.stats | TemplateFlag.traits)) !== 0) continue;
    const clas = await db.get(npc.class ?? 0);
    const race = await db.get(npc.race ?? 0);
    if (clas?.type !== 'CLAS' || race?.type !== 'RACE') continue;
    const follows = (npc.flags & NpcFlag.pcLevelMult) !== 0;
    // The Creation Kit stores a player level 1's stats.
    const level = actorLevel(
      {
        level: npc.level,
        followsPlayer: follows,
        calcMinLevel: npc.calcMinLevel,
        calcMaxLevel: npc.calcMaxLevel,
      },
      1,
    );
    const stats = autoCalcStats(
      {
        level,
        weights: parseClassStats(clas),
        race: parseRaceStats(race),
        healthOffset: npc.healthOffset,
        magickaOffset: npc.magickaOffset,
        staminaOffset: npc.staminaOffset,
      },
      leveling,
    );
    total++;
    // DNAM keeps negative values as u16.
    const u16 = (n: number): number => n & 0xffff;
    if (
      u16(stats.health) === npc.health &&
      u16(stats.magicka) === npc.magicka &&
      u16(stats.stamina) === npc.stamina
    )
      attributes++;
    if (stats.skills.every((skill, i) => skill === npc.skills[i])) skills++;
    else if (follows) differ.follows++;
    else differ.fixed++;
  }
  console.log(
    `${String(total)} auto-calculated NPC_ records: health, magicka and stamina as stored ${String(attributes)}, skills as stored ${String(skills)}` +
      ` (differing: ${String(differ.fixed)} of a fixed level, ${String(differ.follows)} following the player's)`,
  );
} else {
  console.log(
    `skill experience to the next level = improve mult × level ^ ${short(progression.skillUseCurve)} + improve offset; a use: use mult × use + use offset`,
  );
  console.log(
    `${'skill'.padEnd(14)}${'use mult'.padStart(9)}${'offset'.padStart(8)}${'impr mult'.padStart(10)}${'offset'.padStart(8)}${'15→16'.padStart(9)}${'50→51'.padStart(9)}${'99→100'.padStart(9)}${'15→100'.padStart(11)}`,
  );
  const forms = newRuntime().forms;
  for (let index = ActorValue.firstSkill; index < ActorValue.firstSkill + SKILL_COUNT; index++) {
    const record = await forms.actorValueForm(index);
    const curve = record ? parseSkill(record).use : undefined;
    if (!curve) continue;
    let total = 0;
    for (let level = 15; level < 100; level++) total += skillThreshold(level, curve, progression);
    console.log(
      `${actorValueName(index).padEnd(14)}${short(curve.useMult).padStart(9)}${short(curve.useOffset).padStart(8)}${short(curve.improveMult).padStart(10)}${short(curve.improveOffset).padStart(8)}` +
        [15, 50, 99]
          .map((level) => fixed(skillThreshold(level, curve, progression), 0).padStart(9))
          .join('') +
        fixed(total, 0).padStart(11),
    );
  }
  console.log(
    `\ncharacter experience to the next level = ${String(progression.levelUpBase)} + ${String(progression.levelUpMult)} × level; a skill reaching n gives n × ${String(progression.xpPerSkillRank)}`,
  );
  for (const level of [1, 2, 5, 10, 20, 30, 50, 81]) {
    console.log(
      `  level ${String(level).padStart(2)}: ${String(levelThreshold(level, progression)).padStart(5)} to the next, ${String(experienceToLevel(level, progression)).padStart(6)} from level 1`,
    );
  }
  const regen = (vital: 0 | 1 | 2, rate: number, combat: boolean): string =>
    fixed(regenPerSecond(vital, { max: 100, rate, rateMult: 100, inCombat: combat }, vitals), 2);
  console.log(
    `\nregeneration of 100 a second (Nord: 0.7, 3, 5 %): health ${regen(0, 0.7, false)} (combat ${regen(0, 0.7, true)}), magicka ${regen(1, 3, false)} (${regen(1, 3, true)}), stamina ${regen(2, 5, false)} (${regen(2, 5, true)})`,
  );
  console.log(
    `stamina: sprinting ${fixed(sprintDrain(0, vitals), 2)}/s bare, ${fixed(sprintDrain(50, vitals), 2)}/s in 50 pounds of armor; power attack with a 14-pound weapon ${fixed(powerAttackCost(14, {}, vitals), 0)}; bash ${String(bashCost(false, vitals))}, power bash ${String(bashCost(true, vitals))}`,
  );
}
await db.close();
await vfs.close();
