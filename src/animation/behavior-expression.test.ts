import { describe, expect, it } from 'vitest';
import { evaluateNode, parseExpression } from './behavior-expression.ts';

const variables: Record<string, number> = {
  Speed: 120,
  staggerDirection: 0.5,
  iCombatStance: 1,
  TurnDelta: -45,
  bHeadTracking: 1,
  bDisableHeadTrack: 0,
  iState_BearSwimDefault: 7,
  iState_BearDefault: 3,
  isSwimming: 1,
  Direction: 0.25,
  RotMax: 10,
};
const read = (name: string): number | undefined => variables[name];
const value = (text: string): number => {
  const expression = parseExpression(text);
  return evaluateNode(expression.value, read);
};

describe('behavior expressions', () => {
  it('evaluates the conditions of vanilla state machines', () => {
    expect(value('(staggerDirection > .25) && (staggerDirection < .75)')).toBe(1);
    expect(value('(staggerDirection < .25) || (staggerDirection > .75)')).toBe(0);
    expect(value('iCombatStance != 50')).toBe(1);
    expect(value('Speed < fMinSpeed')).toBe(0);
  });

  it('reads assignments with functions', () => {
    const assign = parseExpression('iMovementSpeed = cond((Speed < 100), 0, 1)');
    expect(assign.kind).toBe('assign');
    expect(assign.kind === 'assign' && assign.variable).toBe('iMovementSpeed');
    expect(value('iMovementSpeed = cond((Speed < 100), 0, 1)')).toBe(1);
    expect(value('turnSpeedMult = fabs(TurnDelta/90)')).toBeCloseTo(0.5);
    expect(value('bHeadTrackingOn = (bHeadTracking) && (!bDisableHeadTrack) ')).toBe(1);
    expect(
      value('iState = cond((isSwimming ==1), iState_BearSwimDefault, iState_BearDefault)'),
    ).toBe(7);
    expect(value('walkBackSpeedMult = clamp( Speed/walkBackRate, 0.01, Speed )')).toBe(0.01);
    // Names may start with a digit; sind takes degrees.
    expect(value('1stPRot = sind( Direction * 360 ) * RotMax * clamp(Speed, 0, 1)')).toBeCloseTo(
      10,
    );
  });

  it('reads events raised while a condition holds', () => {
    const event = parseExpression('SoundPlay.WPNBowZoomIn if (iWantBlock)');
    expect(event).toMatchObject({ kind: 'event', event: 'SoundPlay.WPNBowZoomIn' });
    expect(value('weaponDraw if (iCombatStance == 1)')).toBe(1);
    expect(value('recoilStop if(IsRecoiling == 0)')).toBe(1);
  });

  it('rejects what it cannot read', () => {
    expect(() => parseExpression('Speed < ')).toThrow();
    expect(() => parseExpression('Speed # 2')).toThrow();
  });
});
