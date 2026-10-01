import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../sdk/src/platform/config/manager.js';
import type { HookEvent } from '../sdk/src/platform/hooks/types.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'config-hook-owner-'));
  const config = new ConfigManager({ configDir: root });
  const change = () => config.set('watchers.enabled', !config.get('watchers.enabled'));
  return { config, change, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function dispatcher() {
  const calls: HookEvent[] = [];
  return { calls, fire: async (event: HookEvent) => { calls.push(event); return { ok: true }; } };
}

test('release detaches this config hook without disabling ordinary config subscribers', () => {
  const { config, change, cleanup } = fixture(); const hook = dispatcher();
  try {
    let changes = 0; const unsubscribe = config.subscribe('watchers.enabled', () => changes++);
    const release = config.attachHookDispatcher(hook);
    change(); expect(hook.calls).toHaveLength(1);
    release(); release(); change();
    expect(hook.calls).toHaveLength(1); expect(changes).toBe(2);
    unsubscribe();
  } finally { cleanup(); }
});
test('releasing an older runtime cannot clear the newer attachment or revive a retired one', () => {
  const { config, change, cleanup } = fixture(); const first = dispatcher(); const second = dispatcher();
  try {
    const releaseFirst = config.attachHookDispatcher(first);
    const releaseSecond = config.attachHookDispatcher(second);
    releaseFirst(); change();
    expect(first.calls).toHaveLength(0); expect(second.calls).toHaveLength(1);
    releaseSecond(); change();
    expect(first.calls).toHaveLength(0); expect(second.calls).toHaveLength(1);
  } finally { cleanup(); }
});
test('repeated attachment of the same dispatcher still has distinct owners', () => {
  const { config, change, cleanup } = fixture(); const hook = dispatcher();
  try {
    const releaseFirst = config.attachHookDispatcher(hook);
    const releaseSecond = config.attachHookDispatcher(hook);
    releaseFirst(); change(); expect(hook.calls).toHaveLength(1);
    releaseSecond(); change(); expect(hook.calls).toHaveLength(1);
  } finally { cleanup(); }
});
test('legacy callers may ignore the release and explicit clearing remains supported', () => {
  const { config, change, cleanup } = fixture(); const hook = dispatcher();
  try {
    config.attachHookDispatcher(hook); change();
    config.attachHookDispatcher(null); change();
    expect(hook.calls).toHaveLength(1);
  } finally { cleanup(); }
});
