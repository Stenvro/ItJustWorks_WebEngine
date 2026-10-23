import { describe, expect, it } from 'vitest';
import { DRIVE_HANDLERS, driveOf } from './movement-drive.ts';

describe('the movement drive', () => {
  it('follows bAnimationDriven and bAllowRotation', () => {
    expect(driveOf(0, 0)).toBe('controller');
    expect(driveOf(0, 1)).toBe('controller');
    expect(driveOf(1, 0)).toBe('animation');
    expect(driveOf(1, 1)).toBe('animation-rotation');
  });

  it("is switched by the engine's drive handlers", () => {
    expect(DRIVE_HANDLERS.AnimationDrivenHandler).toBe('animation');
    expect(DRIVE_HANDLERS.MotionDrivenHandler).toBe('controller');
    expect(DRIVE_HANDLERS.AllowRotationHandler).toBe('animation-rotation');
  });
});
