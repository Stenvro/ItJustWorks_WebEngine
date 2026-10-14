import { describe, expect, it } from 'vitest';
import {
  conditionFunctionName,
  CONDITION_FUNCTION_COUNT,
} from '../scripting/condition-functions.ts';
import { ACTOR_VALUE_COUNT, ActorValue, actorValueIndex, actorValueName } from './actor-values.ts';

describe('actor values and condition functions', () => {
  it('number the actor values as UESP lists them, by name in any case', () => {
    expect(ACTOR_VALUE_COUNT).toBe(164);
    expect(actorValueIndex('Health')).toBe(ActorValue.health);
    expect(actorValueIndex('onehanded')).toBe(ActorValue.firstSkill);
    expect(actorValueIndex('Enchanting')).toBe(23);
    expect(actorValueIndex('Variable05')).toBe(72);
    expect(actorValueIndex('Archery')).toBe(8);
    expect(actorValueIndex('NoSuchValue')).toBeUndefined();
    expect(actorValueName(163)).toBe('ReflectDamage');
  });

  it('name the condition functions by their CTDA index', () => {
    expect(CONDITION_FUNCTION_COUNT).toBe(734);
    expect(conditionFunctionName(72)).toBe('GetIsID');
    expect(conditionFunctionName(576)).toBe('GetEventData');
    expect(conditionFunctionName(629)).toBe('GetVMQuestVariable');
    expect(conditionFunctionName(733)).toBe('IsFlyingMountFastTravelling');
  });
});
