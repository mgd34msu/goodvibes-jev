import type { HookDispatcher } from '@goodvibes-jev/engine/sdk/platform/hooks';
import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  createPermissionConfigReader, PermissionManager, UserPermissionRuleStore,
  type PermissionAttribution, type PermissionCheckResult,
} from '@goodvibes-jev/engine/sdk/platform/permissions';
import { security } from '@goodvibes-jev/engine/sdk/platform/runtime';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { installPermissionManagerSafetyGuard } from '../../runtime/tool-permission-safety.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Permission cancellation did not settle')), 1_000);
    })]);
  } finally { clearTimeout(timer); }
}

const ALLOWED: PermissionCheckResult = {
  approved: true, persisted: false, sourceLayer: 'config_policy', reasonCode: 'config_allow',
  analysis: { classification: 'generic', riskLevel: 'low', summary: 'fixture read', reasons: [] },
};

for (const method of ['check', 'checkDetailed'] as const) {
  test(`${method} preserves real-manager attribution and cancellation during a pending pre-permission hook`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'agent-permission-cancel-'));
    const path = join(root, 'read-target.txt'); writeFileSync(path, 'fixture data');
    const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent') });
    config.set('permissions.mode', 'prompt');
    const entered = deferred(), release = deferred(), returned = deferred();
    const controller = new AbortController(); const options = { signal: controller.signal };
    const attribution: PermissionAttribution = { kind: 'background-agent', agentId: 'agent-cancel-fixture', template: 'reader' };
    const store = new UserPermissionRuleStore(':memory:'); let prompts = 0, fileReads = 0;
    const hooks = { async fire() { entered.resolve(); await release.promise; returned.resolve(); return { ok: true, decision: 'allow' }; } } as unknown as Pick<HookDispatcher, 'fire'>;
    const manager = new PermissionManager(async () => { prompts++; return { approved: true }; },
      createPermissionConfigReader(config), new security.PolicyRuntimeState(), hooks, null, store);
    const original = spyOn(manager, method); installPermissionManagerSafetyGuard(manager);
    const pending = manager[method]('read', { files: [{ path }] }, attribution, options).then(decision => {
      if (typeof decision === 'boolean' ? decision : decision.approved) { fileReads++; readFileSync(path, 'utf8'); }
      return decision;
    });
    const outcome = pending.then(value => ({ value }), (error: unknown) => ({ error }));
    try {
      await within(entered.promise);
      expect(original.mock.calls[0]?.[2]).toBe(attribution);
      expect(original.mock.calls[0]?.[3]?.signal).toBe(controller.signal);
      options.signal = new AbortController().signal; controller.abort(new Error('synthetic private cancellation context'));
      const result = await within(outcome);
      expect(result).toMatchObject({ error: { name: 'JudgmentError', kind: 'aborted' } });
      expect(JSON.stringify(result)).not.toContain('synthetic private cancellation context');
      expect(fileReads).toBe(0); expect(prompts).toBe(0);
      release.resolve(); await within(returned.promise); await Bun.sleep(0);
      expect(fileReads).toBe(0); expect(store.list()).toHaveLength(0);
    } finally { release.resolve(); controller.abort(); await within(outcome).catch(() => undefined); original.mockRestore(); rmSync(root, { recursive: true, force: true }); }
  });

  for (const error of [new DOMException('cancelled', 'AbortError'), new JudgmentError('aborted', 'the permission request was cancelled')]) {
    test(`${method} does not turn ${error.name} into a read-only fallback grant`, async () => {
      const manager: Pick<PermissionManager, 'check' | 'checkDetailed' | 'getCategory'> = {
        check: async () => { throw error; },
        checkDetailed: async () => { throw error; },
        getCategory: () => 'read',
      };
      installPermissionManagerSafetyGuard(manager);
      await expect(manager[method]('read', {})).rejects.toBe(error);
    });
  }

  for (const fails of [false, true]) {
    test(`${method} rejects cancellation racing a late ${fails ? 'ordinary failure' : 'allowance'}`, async () => {
      const controller = new AbortController();
      const options = { signal: controller.signal };
      const manager: Pick<PermissionManager, 'check' | 'checkDetailed' | 'getCategory'> = {
        async check() { cancel(); return true; },
        async checkDetailed() { cancel(); return ALLOWED; },
        getCategory: () => 'read',
      };
      function cancel() {
        options.signal = new AbortController().signal;
        controller.abort(new Error('synthetic private racing reason'));
        if (fails) throw new Error('ordinary lookup failure after cancellation');
      }
      installPermissionManagerSafetyGuard(manager);
      const outcome = manager[method]('read', {}, undefined, options).catch((error: unknown) => error);
      expect(await outcome).toMatchObject({ name: 'JudgmentError', kind: 'aborted', message: 'the permission request was cancelled' });
      expect(JSON.stringify(await outcome)).not.toContain('synthetic private racing reason');
    });
  }
}
