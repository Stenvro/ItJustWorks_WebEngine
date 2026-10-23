// The time and weather controls of the dev panel indoors: the session's clock (time passes
// indoors too, at the timescale) and the sky's weather, which the game keeps while the player
// is inside and shows again at the door. The same controls as the world's sky (world-sky.ts),
// so the panel offers the same in both.

import type { GameSession } from './game-session.ts';
import { showClockSpeed, type SkyElements } from './world-sky.ts';

const formatHour = (hour: number): string => {
  const minutes = Math.floor((((hour % 24) + 24) % 24) * 60);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
};

export class InteriorSkyControls {
  readonly #ui: SkyElements;
  readonly #session: GameSession;
  readonly #detach: () => void;

  constructor(session: GameSession, ui: SkyElements) {
    this.#session = session;
    this.#ui = ui;
    showClockSpeed(ui, session.timeScale, session.timeSpeed);
    const onTime = (): void => {
      session.gameHour = Number(ui.time.value);
      ui.timeLabel.value = formatHour(session.gameHour);
    };
    // As outside: a weather picked is the console's `fw <weather> 1`, the region's choice `rwo`.
    const onWeather = (): void => {
      const id = Number(ui.weather.value);
      if (!Number.isFinite(id) || id === 0) session.sky.releaseOverride();
      else session.sky.forceWeather(id, true);
    };
    ui.time.addEventListener('input', onTime);
    ui.weather.addEventListener('change', onWeather);
    this.#detach = () => {
      ui.time.removeEventListener('input', onTime);
      ui.weather.removeEventListener('change', onWeather);
    };
    this.sync();
    ui.sky.hidden = false;
    void session.weathers().then((weathers) => {
      const all = document.createElement('optgroup');
      all.label = 'all weathers (outside)';
      for (const weather of weathers)
        all.append(new Option(weather.editorId, String(weather.formId)));
      ui.weather.replaceChildren(new Option('as the region picks', '0'), all);
      ui.weather.value = String(session.sky.override ?? 0);
    });
  }

  /** The slider follows the clock. */
  sync(): void {
    const hour = this.#session.gameHour;
    if (Math.abs(Number(this.#ui.time.value) - hour) > 0.04) {
      this.#ui.time.value = hour.toFixed(2);
      this.#ui.timeLabel.value = formatHour(hour);
    }
  }

  dispose(): void {
    this.#detach();
    this.#ui.sky.hidden = true;
  }
}
