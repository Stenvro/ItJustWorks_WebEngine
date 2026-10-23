import { describe, expect, it } from 'vitest';
import { EventHub } from './event-hub.ts';

describe('event hub', () => {
  it('tells every listener of a kind, in order, and no other kind', async () => {
    const hub = new EventHub();
    const heard: string[] = [];
    hub.on('openClose', (event) => {
      heard.push(`a ${String(event.reference)} ${String(event.opened)}`);
    });
    hub.on('openClose', async (event) => {
      await Promise.resolve();
      heard.push(`b ${String(event.reference)}`);
    });
    hub.on('reset', () => {
      heard.push('reset');
    });
    await hub.emitted('openClose', { reference: 7, actor: undefined, opened: true });
    expect(heard).toEqual(['a 7 true', 'b 7']);
  });

  it('keeps going past a failing listener and reports it', async () => {
    const hub = new EventHub();
    const failures: string[] = [];
    hub.onError = (kind) => failures.push(kind);
    let reached = false;
    hub.on('enterBleedout', () => {
      throw new Error('broken');
    });
    hub.on('enterBleedout', async () => {
      await Promise.reject(new Error('broken too'));
    });
    hub.on('enterBleedout', () => {
      reached = true;
    });
    await hub.emitted('enterBleedout', { actor: 20 });
    expect(reached).toBe(true);
    expect(failures).toEqual(['enterBleedout', 'enterBleedout']);
  });

  it('stops telling a listener that left', async () => {
    const hub = new EventHub();
    let count = 0;
    const leave = hub.on('reset', () => {
      count++;
    });
    await hub.emitted('reset', { reference: 1 });
    leave();
    await hub.emitted('reset', { reference: 1 });
    expect(count).toBe(1);
  });
});
