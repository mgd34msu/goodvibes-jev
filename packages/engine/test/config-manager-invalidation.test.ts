import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mail-config-epoch-')); roots.push(root);
  const workingDir = join(root, 'workspace'); mkdirSync(workingDir);
  return new ConfigManager({ configDir: join(root, 'config'), homeDir: root, workingDir, surfaceRoot: 'tui', ownsDaemonTier: true });
}

describe('opaque ConfigManager lifetime invalidation', () => {
  test('every mutation path invalidates synchronously before values change', () => {
    const manager = fixture();
    const events: unknown[] = [];
    manager.onDidInvalidate(() => { events.push(manager.get('provider.model')); });
    let count = 0;
    const assertMutation = (mutate: () => void) => {
      const previous = manager.get('provider.model');
      mutate();
      expect(events.length).toBeGreaterThan(count);
      expect(events[count]).toBe(previous);
      count = events.length;
    };
    assertMutation(() => manager.set('provider.model', 'openai:fixture-first'));
    assertMutation(() => manager.setProjectValue('provider.model', 'openai:fixture-project'));
    assertMutation(() => manager.setDaemonValues({ 'surfaces.email.host': 'synthetic.invalid' }));
    assertMutation(() => manager.mergeCategory('helper', { syntheticEpoch: 'value' } as never));
    assertMutation(() => manager.removeCategoryKey('helper', 'syntheticEpoch'));
    assertMutation(() => manager.reset('provider.model'));
    assertMutation(() => manager.load());
    assertMutation(() => manager.reset());
  });

  test('ABA and identical writes remain distinguishable, with failing listeners isolated', () => {
    const manager = fixture();
    const start = manager.get('provider.model');
    let epoch = 0;
    manager.onDidInvalidate(() => { throw new Error('synthetic bad subscriber'); });
    const stop = manager.onDidInvalidate(() => { epoch += 1; });
    manager.set('provider.model', 'openai:fixture-other');
    manager.set('provider.model', start);
    manager.set('provider.model', start);
    expect(epoch).toBe(3);
    stop(); manager.load(); expect(epoch).toBe(3);
  });
});
