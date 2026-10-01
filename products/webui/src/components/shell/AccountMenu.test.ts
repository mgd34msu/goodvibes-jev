import { describe, expect, test } from 'bun:test';
import { activityPhrase, connectionPhrase, connectionTone, latencyPhrase } from './AccountMenu';

describe('account menu helpers', () => {
  test('each connection state and route gets a distinct phrase', () => {
    const phrases = [
      connectionPhrase({ connection: 'connected', route: 'direct' }),
      connectionPhrase({ connection: 'connected', route: 'relay' }),
      connectionPhrase({ connection: 'reconnecting', route: null }),
      connectionPhrase({ connection: 'down', route: null }),
    ];
    expect(new Set(phrases).size).toBe(phrases.length);
  });

  test('the avatar dot tone follows connection and access', () => {
    expect(connectionTone({ connection: 'connected', working: 'working' })).toBe('ok');
    expect(connectionTone({ connection: 'connected', working: 'blocked' })).toBe('warn');
    expect(connectionTone({ connection: 'reconnecting', working: 'working' })).toBe('warn');
    expect(connectionTone({ connection: 'down', working: 'unknown' })).toBe('bad');
  });

  test('latency reads in milliseconds with a space', () => {
    expect(latencyPhrase(null)).toBe('');
    expect(latencyPhrase(4)).toBe('<10 ms');
    expect(latencyPhrase(31.4)).toBe('31 ms');
    expect(latencyPhrase(1500)).toBe('1.5 s');
  });

  test('activity line carries the turn and queue counts, and changes with the live-update state', () => {
    const busy = activityPhrase({ activeTurns: 7, queuedTasks: 13, sse: 'error', working: 'working' });
    expect(busy).toContain('7');
    expect(busy).toContain('13');
    expect(activityPhrase({ activeTurns: 7, queuedTasks: 13, sse: 'active', working: 'working' })).not.toBe(busy);
    expect(activityPhrase({ activeTurns: 0, queuedTasks: 0, sse: 'relay-unsupported', working: 'blocked' }).length).toBeGreaterThan(0);
  });
});
