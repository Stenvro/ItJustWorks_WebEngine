import { describe, expect, it } from 'vitest';
import { DialogueCamera } from './dialogue-camera.ts';

describe('the dialogue camera', () => {
  it('turns the view to the speaker and zooms in, then zooms back as it ends', () => {
    const camera = new DialogueCamera();
    expect(camera.active).toBe(false);
    // The speaker's head stands due east of the eye, level with it.
    camera.open(() => [100, 0, 50]);
    let view = camera.sample(0, [0, 0, 50], 0, 0.3);
    let yaw = view.yaw;
    let pitch = view.pitch;
    for (let t = 50; t <= 3000; t += 50) {
      view = camera.sample(t, [0, 0, 50], yaw, pitch);
      yaw = view.yaw;
      pitch = view.pitch;
    }
    expect(yaw).toBeCloseTo(Math.PI / 2, 3);
    expect(pitch).toBeCloseTo(0, 3);
    expect(view.fov).toBe(-10);
    camera.close();
    expect(camera.active).toBe(true);
    for (let t = 3050; t <= 4000; t += 50) view = camera.sample(t, [0, 0, 50], yaw, pitch);
    expect(view.fov).toBe(0);
    expect(view.yaw).toBeCloseTo(Math.PI / 2, 3);
    expect(camera.active).toBe(false);
  });

  it('turns the short way round', () => {
    const camera = new DialogueCamera();
    // Facing just west of north, the speaker just east of north.
    camera.open(() => [10, 100, 0]);
    camera.sample(0, [0, 0, 0], -0.2, 0);
    const view = camera.sample(100, [0, 0, 0], -0.2, 0);
    expect(view.yaw).toBeGreaterThan(-0.2);
    expect(view.yaw).toBeLessThan(0.1);
  });
});
