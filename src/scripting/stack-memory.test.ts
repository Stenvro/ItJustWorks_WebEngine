import { describe, expect, it } from 'vitest';
import { MemoryPagePolicy, StackMemory } from './stack-memory.ts';

describe('the stack memory (iMaxAllocatedMemoryBytes and its pages)', () => {
  it('gives pages of at least iMinMemoryPageSize while they fit under the limit', () => {
    const policy = new MemoryPagePolicy();
    policy.configure(128, 512, 1000);
    expect(policy.allocate(64)).toBe(128);
    expect(policy.allocate(800)).toBe(800);
    // 72 bytes left: a page of 128 does not fit.
    expect(policy.allocate(64)).toBeUndefined();
    // The largest page still to be had is what is left.
    expect(policy.largest()).toBe(72);
    policy.dispose(800);
    expect(policy.inUse).toBe(200);
  });

  it('gives pages over the limit while overstressed or asked with the limit ignored', () => {
    const policy = new MemoryPagePolicy();
    policy.configure(128, 512, 256);
    expect(policy.allocate(256)).toBe(256);
    expect(policy.allocate(128, 'ignoreLimit')).toBe(128);
    policy.ignoreLimit = true;
    expect(policy.allocate(128)).toBe(128);
    expect(policy.peakOverrun).toBe(256);
    // Past the limit the room left counts without sign, as the original's: the largest page.
    expect(policy.largest()).toBe(512);
  });

  it('fits a frame of 64 bytes and 16 a variable into the stack’s pages', () => {
    const policy = new MemoryPagePolicy();
    const stack = new StackMemory(policy);
    // A frame of 2 variables: a new page of (2 + 4) * 16 = 96, at least 128.
    expect(stack.push(2)).toBe(true);
    expect(stack.bytes).toBe(128);
    // 32 bytes left: the next frame takes a new page of its own size.
    expect(stack.push(10)).toBe(true);
    expect(stack.bytes).toBe(128 + 224);
    stack.pop();
    expect(stack.bytes).toBe(128);
    stack.release();
    expect(policy.inUse).toBe(0);
  });

  it('makes a thread wait for memory, giving back what the frame took', () => {
    const policy = new MemoryPagePolicy();
    policy.configure(128, 512, 300);
    const stack = new StackMemory(policy);
    expect(stack.push(4)).toBe(true);
    // 172 bytes left: the frame's header fits in the largest page, its 20 variables do not.
    expect(stack.push(30)).toBe(false);
    expect(policy.inUse).toBe(128);
    expect(stack.depth).toBe(1);
    // Once memory is given back, the frame is made.
    const other = new StackMemory(policy);
    expect(other.push(30, 'ignoreLimit')).toBe(true);
    other.release();
    stack.pop();
    expect(stack.push(10)).toBe(true);
  });
});
