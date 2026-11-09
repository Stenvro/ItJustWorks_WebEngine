// Browser check of the opening's first fight in Helgen Keep, the way a player gets there: a new
// game in its own headless Chrome (WebGPU), the cart ride and the execution as the game plays
// them (AI-driven), the race menu finished, then the follow bot (tools/qa-scenarios.ts, god mode)
// after the guide through Helgen into the keep; where it stalls (it does as of 2026-11-09: it
// follows the nearest guide's marker, and does not climb the tower with Ralof), after
// --bot-minutes the keep is entered as MQ101SetStage220 has it when the player walks in with
// Ralof (stage 220, coc HelgenKeep01). In the keep god mode goes off and the player
// plays on their own: after the guide, the gear taken where the objective shows it (Take All,
// then the weapon and the armour put on), and when the keep's soldiers attack, a fight by CDP
// mouse buttons: taps (attacks), held (power attacks), the right button held (blocks, also
// pressed in the middle of a swing). It ends when the soldiers are dead and the guide leads on
// (MQ101 300 on Ralof's route: the key and the door), or the player dies.
//
//   node tools/qa-keep-fight.ts --out <folder> [--vite-port 5204] [--chrome-port 9404]
//                               [--bot-minutes 4]
//
// Writes keep-fight.json (the outcome, every blow by and on the player and the guide, who fought
// the player in Helgen's courtyard, the menus that opened, frame times) and screenshots to the
// folder, which must be OUTSIDE the repository (the screenshots show the game's content).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cdp, Page, sleep, startChrome, startVite, stopProcess, waitFor } from './qa-cdp.ts';
import { FOLLOW_BOT } from './qa-scenarios.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const at = args.indexOf(name);
  return at >= 0 ? (args[at + 1] ?? fallback) : fallback;
};
const OUT = option('--out', '');
if (!OUT || path.resolve(OUT).startsWith(ROOT)) {
  console.log('usage: node tools/qa-keep-fight.ts --out <folder outside the repository>');
  process.exit(2);
}
const VITE_PORT = Number(option('--vite-port', '5204'));
const CHROME_PORT = Number(option('--chrome-port', '9404'));
const MQ101 = 0x3372b;
/** MQ101KeepIntroSceneB (Ralof's route into the keep). */
const INTRO_RALOF = 0x4e1e2;
/** How long the follow bot may take from MQ101 160 to the keep. */
const BOT_MINUTES = Number(option('--bot-minutes', '4'));
const WIDTH = 1280;
const HEIGHT = 720;

fs.mkdirSync(OUT, { recursive: true });
const logFile = path.join(OUT, 'host.log');
fs.writeFileSync(logFile, '');
const started = Date.now();
const log = (text: string): void => {
  const line = `${((Date.now() - started) / 1000).toFixed(0)} s: ${text}`;
  fs.appendFileSync(logFile, line + '\n');
  console.log(line);
};

/** The page's helpers (window.__kf): who is who, blows, menus, frames, the player's moves. */
const HELPERS = `(() => {
  if (window.__kf) return true;
  const MQ = ${MQ101};
  const play = engineDev.play();
  // The viewer the player is in: an interior's (the model viewer) or the world's; both may be
  // playing after a load door, so the player's own place decides (kept by the interval below).
  const V = () => (window.__kf?.interior ? engineDev.viewer : engineDev.world);
  const rt = () => play.session.scriptsReady;
  const name = (ref) => ref === 0x14 ? 'player' : (V().actorStage?.get(ref)?.placed.look.editorId ?? ref.toString(16));
  const kf = {
    V, rt, name,
    t0: performance.now(),
    hits: [], menus: [], courtyard: new Set(), frames: [], att: [], lastMenus: '', lock: true,
    stage: () => rt()?.state.quests.get(MQ)?.stage ?? -1,
    alias: (a) => rt()?.state.quests.get(MQ)?.aliases.get(a),
    pos: (ref) => ref === 0x14 ? V().player?.feet : V().actorStage?.get(ref)?.position,
    distance: (ref) => { const a = kf.pos(0x14); const b = kf.pos(ref); return a && b ? Math.hypot(b[0] - a[0], b[1] - a[1]) : Infinity; },
    guide: () => [kf.alias(12), kf.alias(1)].filter((r) => r !== undefined && V().actorStage?.get(r) && !V().actorStage.get(r).dead).sort((a, b) => kf.distance(a) - kf.distance(b))[0],
    // Those who fight the player or the guide, alive.
    foes: () => {
      const stage = V().actorStage; if (!stage) return [];
      const guide = kf.guide();
      const out = [];
      for (const s of stage.all()) {
        if (s.dead || s.reference === guide) continue;
        const t = stage.combat.targetOf(s.reference);
        if (t === 0x14 || (guide !== undefined && t === guide)) out.push(s.reference);
      }
      return out.sort((a, b) => kf.distance(a) - kf.distance(b));
    },
    // Walks the player toward a reference until within 'within' units (Forward held, the view turned).
    steer: (ref, within) => {
      const me = V().player; const at = kf.pos(ref);
      if (!me || !at) return -1;
      const f = me.feet; const dx = at[0] - f[0]; const dy = at[1] - f[1];
      me.yaw = Math.atan2(dx, dy);
      const d = Math.hypot(dx, dy);
      me.press('Forward', d > within);
      return d;
    },
    stop: () => V().player?.press('Forward', false),
  };
  window.__kf = kf;
  const watch = () => {
    const r = rt(); if (!r || kf.watching === r) return;
    kf.watching = r;
    r.events.on('hit', (h) => kf.hits.push({ t: Math.round(performance.now() - kf.t0), a: name(h.aggressor), tg: name(h.target), power: !!h.powerAttack, blocked: !!h.blocked, stage: kf.stage() }));
  };
  setInterval(() => {
    watch();
    void rt()?.placement(0x14).then((at) => { kf.interior = at !== undefined && at.world === undefined; }).catch(() => undefined);
    const menus = [...play.host.menus].map((m) => m.movie.replace('.swf', '')).join('/');
    const lock = !!document.pointerLockElement;
    if (menus !== kf.lastMenus || lock !== kf.lock) {
      kf.menus.push({ t: Math.round(performance.now() - kf.t0), menus, lock, stage: kf.stage() });
      kf.lastMenus = menus; kf.lock = lock;
    }
    const stage = V().actorStage;
    if (stage && kf.stage() >= 160 && kf.stage() < 220 && !kf.inside) for (const r of stage.combat.enemiesOfPlayer()) kf.courtyard.add(name(r));
  }, 250);
  let last = performance.now();
  const tick = (now) => { kf.frames.push(now - last); last = now; if (kf.frames.length > 20000) kf.frames.splice(0, 10000); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return true;
})()`;

const procs: Parameters<typeof stopProcess>[0][] = [];

async function main(): Promise<void> {
  procs.push(await startVite(ROOT, VITE_PORT));
  procs.push(
    await startChrome({
      port: CHROME_PORT,
      profile: path.join(OUT, '.profile'),
      width: WIDTH,
      height: HEIGHT,
    }),
  );
  const cdp = await Cdp.connect(CHROME_PORT);
  const page = await Page.open(cdp, WIDTH, HEIGHT);
  await page.navigate(`http://localhost:${VITE_PORT}/?devdata`);
  const card = await waitFor(
    () =>
      page.eval<string>(
        `(() => { const card = document.getElementById('menu-play'); if (!card || card.disabled || !/ready/i.test(document.getElementById('console-status')?.textContent ?? '')) return undefined; card.click(); return 'card'; })()`,
        10000,
      ),
    90000,
  );
  if (!card) throw new Error('the shell never got ready');
  await sleep(1500);
  await page.eval(`(() => { document.getElementById('launcher-play')?.click(); return true; })()`);
  const menu = await waitFor(
    () =>
      page.eval<number | undefined>(
        `(() => { const p = window.engineDev?.play?.(); const m = p && [...p.host.menus].find(x => x.movie === 'startmenu.swf'); const n = m?.get('_root.MenuHolder.Menu_mc.MainList.entryList.length') ?? 0; return n >= 5 ? n : undefined; })()`,
        10000,
      ),
    120000,
  );
  if (!menu) throw new Error('the main menu did not open');
  await sleep(1500);
  log('new game');
  await page.eval(`(engineDev.play().startMenu.received('StartNewGame', []), true)`);
  const inWorld = await waitFor(
    () =>
      page.eval<boolean | undefined>(
        `(() => { const p = engineDev.play(); const hud = [...p.host.menus].some(x => x.movie === 'hudmenu.swf'); return hud && p.session?.scriptsReady && !p.session.loading ? true : undefined; })()`,
        10000,
      ),
    300000,
    2000,
  );
  if (!inWorld) throw new Error('the game never got into the world');
  await page.eval(HELPERS, 10000);
  log('in the world: the cart ride');

  // The opening, as the game plays it, until the player is free (MQ101 160); then the bot.
  let raced = false;
  let jumped = false;
  let bot = false;
  let botSince = 0;
  let stage = -1;
  const until = Date.now() + 25 * 60_000;
  for (;;) {
    if (Date.now() > until) throw new Error(`the opening stood at MQ101 ${String(stage)}`);
    const now = await page
      .eval<{
        stage: number;
        driven: boolean;
        menus: string;
        interior: boolean;
        loading: boolean;
      }>(
        `(async () => { const p = engineDev.play(); if (!p?.session) return undefined; const rt = p.session.scriptsReady; const at = rt && await rt.placement(0x14);
        const box = [...p.host.menus].find(x => x.movie === 'messagebox.swf');
        if (box && /Survival Mode/.test(String(box.get('_root.MessageMenu.MessageText.text') ?? ''))) box.received('buttonPress', [0, 1]);
        return { stage: window.__kf.stage(), driven: rt?.controls.aiDriven === true, menus: [...p.host.menus].map(x => x.movie.replace('.swf', '')).join('/'),
          interior: at !== undefined && at.world === undefined, loading: (engineDev.world.loading ?? engineDev.viewer.loading) !== undefined }; })()`,
        20000,
      )
      .catch(() => undefined);
    if (!now) {
      // Between games (a reload would end the run: Play is gone) or a slow frame: try again.
      await sleep(2000);
      continue;
    }
    if (now.stage !== stage) {
      stage = now.stage;
      log(`MQ101 stage ${String(stage)}`);
    }
    if (now.menus.includes('racesex_menu') && !raced) {
      raced = true;
      await sleep(3000);
      log('race menu: finished as a player would');
      await page.key('KeyR');
      await sleep(2000);
      await page.key('Enter');
      await sleep(2000);
      for (const code of ['KeyT', 'KeyE', 'KeyS', 'KeyT', 'KeyE', 'KeyR']) await page.key(code);
      await sleep(1000);
      await page.key('Enter');
      await sleep(2000);
      await page.key('Enter');
      await sleep(3000);
    }
    if (now.stage >= 160 && !now.driven && !bot) {
      bot = true;
      // The bot does not fight: god mode through Helgen (the blows on the player are logged).
      await page.eval(`(engineDev.play().session.scriptsReady.godMode = true, true)`);
      await page.eval(FOLLOW_BOT, 30000, true);
      botSince = Date.now();
      log('the player is free: the follow bot takes over (god mode)');
      await page.screenshot(path.join(OUT, 'free.jpg'));
    }
    if (bot && now.interior && !now.loading && now.stage >= 220) break;
    // The follow bot stalls in Helgen (it follows the nearest guide's marker, often Hadvar's
    // behind a wall, and does not climb the tower with Ralof): after BOT_MINUTES the keep is
    // entered as MQ101SetStage220 has it when the player walks in with Ralof.
    if (bot && !jumped && Date.now() - botSince > BOT_MINUTES * 60_000) {
      jumped = true;
      log(
        `the follow bot got no further than MQ101 ${String(now.stage)}: into the keep with Ralof (stage 220, coc HelgenKeep01)`,
      );
      await page.eval(
        `(() => { const b = window.__qaBot; if (b) { clearInterval(b.timer); b.release(); } window.__qaBot = undefined; const rt = engineDev.play().session.scriptsReady; for (const s of rt.scenes.snapshot()) rt.scenes.stop(s.scene); void rt.quests.setStage(${MQ101}, 220); return true; })()`,
      );
      await sleep(1500);
      log(
        JSON.stringify(await page.eval(`engineDev.play().runConsole('coc HelgenKeep01')`, 120000)),
      );
      await waitFor(
        () =>
          page.eval<boolean | undefined>(
            `(() => engineDev.viewer.playing && engineDev.viewer.loading === undefined && !engineDev.play().session.loading ? true : undefined)()`,
          ),
        120000,
      );
      // The scenes the jump left running (the courtyard's), all but Ralof's keep scene.
      await page.eval(
        `(() => { const rt = engineDev.play().session.scriptsReady; for (const s of rt.scenes.snapshot()) if (s.scene !== ${INTRO_RALOF}) rt.scenes.stop(s.scene); return true; })()`,
      );
    }
    await sleep(2000);
  }
  await page.eval(
    `(() => { const b = window.__qaBot; if (b) { clearInterval(b.timer); b.release(); } window.__kf.inside = true; engineDev.play().session.scriptsReady.godMode = false; return true; })()`,
  );
  log(`in the keep at MQ101 ${String(stage)}: god mode off, the player plays on`);
  await sleep(2000);
  await page.screenshot(path.join(OUT, 'keep.jpg'));

  const mouse = async (
    type: 'mousePressed' | 'mouseReleased',
    button: 'left' | 'right',
  ): Promise<void> => {
    await page.send('Input.dispatchMouseEvent', {
      type,
      x: WIDTH / 2,
      y: HEIGHT / 2,
      button,
      buttons: type === 'mousePressed' ? (button === 'left' ? 1 : 2) : 0,
      clickCount: 1,
    });
  };
  // A first click takes the pointer (the canvas asks for the lock on a left click).
  await mouse('mousePressed', 'left');
  await mouse('mouseReleased', 'left');
  await page.eval(
    `(() => { const k = window.__kf; const c = k.V().actorStage.combat; const orig = c.attack.bind(c);
      c.attack = async (r, a, m) => { const s0 = r === 0x14 ? c.combatState(0x14) : undefined; const before = s0 && { attack: s0.attack, staggered: s0.staggered, recoiling: s0.recoiling, blocking: s0.blocking, weapon: s0.weapon, life: s0.life, paired: s0.paired, knock: s0.knock }; const res = await orig(r, a, m); if (r === 0x14) k.att.push([Math.round(performance.now() - k.t0), a, res, res ? undefined : before]); return res; };
      k.blockSeen = 0; setInterval(() => { if (c.combatState(0x14)?.blocking) k.blockSeen++; }, 100);
      return true; })()`,
  );

  // The keep: after the guide, the gear where the objective shows it, the fight when it comes.
  let geared = false;
  let drawn = false;
  let fought = 0;
  let fightStart = 0;
  let quietSince = 0;
  let swings = 0;
  let tutorials = 0;
  /** Each block held, and whether the guard went up while it was. */
  const blocks: { midSwing: boolean; raised: boolean }[] = [];
  let shots = 0;
  const foesSeen = new Set<number>();
  const keepUntil = Date.now() + 18 * 60_000;
  let outcome = 'timeout';
  while (Date.now() < keepUntil) {
    const now = await page
      .eval<{
        stage: number;
        foes: number[];
        guide: number | undefined;
        d: number;
        gear: number | undefined;
        dead: boolean;
        health: number;
        menuMode: boolean;
        tutorial: boolean;
      }>(
        `(async () => { const k = window.__kf; const rt = k.rt(); const q = rt.state.quests.get(${MQ101});
        const shown = (i) => { const o = q?.objectives.get(i); return o?.displayed && !o.completed; };
        const gear = shown(65) ? k.alias(144) : shown(60) ? k.alias(62) : undefined;
        const foes = k.foes(); const guide = k.guide();
        let d = -1;
        if (foes.length > 0) d = k.steer(foes[0], 80);
        else if (gear !== undefined) d = k.steer(gear, 90);
        else if (guide !== undefined && k.distance(guide) > 250) {
          // Far behind the guide (the jump sets the player down at the cell's door marker; the
          // walk in with Ralof keeps them by him): caught up, 80 units from them.
          const at = k.pos(guide); const me = k.pos(0x14); const f = 80 / k.distance(guide);
          k.V().play.placePlayer([at[0] + (me[0] - at[0]) * f, at[1] + (me[1] - at[1]) * f, at[2] + 10], k.V().player.yaw);
        } else if (guide !== undefined) d = k.steer(guide, 90);
        else k.stop();
        return { stage: k.stage(), foes, guide, d, gear, dead: await rt.actors.isDead(0x14), health: (await rt.actors.value(0x14, 24)).current, menuMode: engineDev.play().session.menuMode, tutorial: [...engineDev.play().host.menus].some((m) => m.movie === 'tutorialmenu.swf') };
      })()`,
        20000,
      )
      .catch(() => undefined);
    if (!now) {
      await sleep(1000);
      continue;
    }
    if (now.tutorial) {
      await sleep(1500);
      await page.screenshot(path.join(OUT, `tutorial-${String(++tutorials)}.jpg`));
      log('a tutorial opened: closed with E, the pointer taken again with a click');
      await page.key('KeyE');
      await sleep(500);
      await mouse('mousePressed', 'left');
      await mouse('mouseReleased', 'left');
      continue;
    }
    if (now.dead) {
      outcome = 'player died';
      break;
    }
    if (now.gear !== undefined && !geared && now.d >= 0 && now.d <= 120) {
      geared = true;
      // Take All, then the weapon and the armour put on (the container and inventory menus).
      const taken = await page.eval<string[]>(
        `(async () => { const rt = window.__kf.rt(); const from = ${now.gear}; const names = [];
          for (const [item, count] of [...(await rt.inventory(from))]) {
            await rt.removeItem(from, rt.formHandle(item), count, true, 0x14);
            const record = await rt.forms.db.get(item);
            if (record?.type === 'WEAP' || record?.type === 'ARMO') await rt.equipment.equip(0x14, item);
            names.push(record?.editorId ?? item.toString(16));
          }
          // The body or chest activated, as the player opens it (its scripts see it: MQ101 257).
          await rt.activate(from, 0x14, false);
          return names; })()`,
        30000,
      );
      log(`gear taken and put on: ${taken.join(', ')}`);
    }
    for (const foe of now.foes) foesSeen.add(foe);
    if (now.foes.length > 0) {
      if (fightStart === 0) {
        fightStart = Date.now();
        fought++;
        log(
          `fight ${String(fought)} at MQ101 ${String(now.stage)}: ${now.foes.map((f) => f.toString(16)).join(', ')}`,
        );
        await page.screenshot(path.join(OUT, `fight${String(fought)}-start.jpg`));
      }
      quietSince = 0;
      if (!drawn) {
        drawn = true;
        await page.key('KeyR');
        await sleep(1200);
      }
      if (now.d >= 0 && now.d < 140) {
        swings++;
        if (swings % 6 === 0) {
          // A power attack: held past fInitialPowerAttackDelay.
          await mouse('mousePressed', 'left');
          await sleep(700);
          await mouse('mouseReleased', 'left');
        } else if (swings % 7 === 0 || swings % 5 === 0) {
          // A block held: pressed in the middle of a swing (every 7th), or on its own (every 5th).
          const midSwing = swings % 7 === 0;
          if (midSwing) {
            await mouse('mousePressed', 'left');
            await sleep(80);
            await mouse('mouseReleased', 'left');
            await sleep(150);
          }
          const before = await page.eval<number>(`window.__kf.blockSeen ?? 0`);
          await mouse('mousePressed', 'right');
          await sleep(900);
          await mouse('mouseReleased', 'right');
          const after = await page.eval<number>(`window.__kf.blockSeen ?? 0`);
          blocks.push({ midSwing, raised: after > before });
        } else {
          await mouse('mousePressed', 'left');
          await sleep(80);
          await mouse('mouseReleased', 'left');
        }
        if (shots < 3 && swings % 8 === 4) {
          shots++;
          await page.screenshot(path.join(OUT, `fight${String(fought)}-${String(shots)}.jpg`));
        }
        await sleep(450);
      } else {
        await sleep(250);
      }
      continue;
    }
    if (fightStart !== 0) {
      quietSince ||= Date.now();
      if (Date.now() - quietSince > 4000) {
        log(
          `fight ${String(fought)} over after ${((Date.now() - fightStart) / 1000).toFixed(0)} s, health ${now.health.toFixed(0)}`,
        );
        await page.screenshot(path.join(OUT, `fight${String(fought)}-end.jpg`));
        fightStart = 0;
      }
    }
    if (now.stage >= 300) {
      outcome = 'won: MQ101 300';
      break;
    }
    await sleep(300);
  }
  log(`outcome: ${outcome}`);
  await page.eval(`(window.__kf.stop(), true)`);
  await page.screenshot(path.join(OUT, 'end.jpg'));
  const result = await page.eval(
    `(async () => { const k = window.__kf; const rt = k.rt(); const f = k.frames.slice(-6000).sort((a, b) => a - b);
      const foes = ${JSON.stringify([...foesSeen])};
      const dead = {}; for (const r of foes) dead[k.name(r)] = await rt.actors.isDead(r);
      const by = (a, t) => k.hits.filter(h => (a === undefined || h.a === a) && (t === undefined || h.tg === t)).length;
      const guide = k.name(k.alias(12)) ;
      return {
        stage: k.stage(), foesDead: dead,
        player: { dead: await rt.actors.isDead(0x14), health: (await rt.actors.value(0x14, 24)).current },
        blows: { byPlayer: by('player'), byPlayerPower: k.hits.filter(h => h.a === 'player' && h.power).length, onPlayer: by(undefined, 'player'), onPlayerBlocked: k.hits.filter(h => h.tg === 'player' && h.blocked).length, guideOnPlayer: by(guide, 'player') },
        refusals: k.att.filter((x) => !x[2]).reduce((m, [, a, , s]) => { const key = a + ' ' + JSON.stringify(s); m[key] = (m[key] ?? 0) + 1; return m; }, {}),
        blockSeen: k.blockSeen,
        playerAttacks: k.att.reduce((m, [, a, res]) => { const key = a + (res ? '' : ' (refused)'); m[key] = (m[key] ?? 0) + 1; return m; }, {}),
        courtyardFoes: [...k.courtyard],
        hits: k.hits.filter(h => h.stage >= 160),
        menus: k.menus,
        frames: { n: f.length, median: f[Math.floor(f.length / 2)], p95: f[Math.floor(f.length * 0.95)], fps: 1000 / f[Math.floor(f.length / 2)] },
      }; })()`,
    30000,
  );
  fs.writeFileSync(
    path.join(OUT, 'keep-fight.json'),
    JSON.stringify({ outcome, fights: fought, blocks, result }, null, 1),
  );
  log(JSON.stringify({ outcome, fights: fought }));
  cdp.close();
}

main()
  .catch((error: unknown) => {
    log(`error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  })
  .finally(() => {
    for (const child of procs) stopProcess(child);
    setTimeout(() => process.exit(0), 2000);
  });
