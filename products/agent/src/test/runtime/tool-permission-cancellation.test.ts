import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import {
  createPermissionConfigReader, PermissionManager, UserPermissionRuleStore,
  type PermissionAttribution, type PermissionCheckResult,
} from '@goodvibes-jev/engine/sdk/platform/permissions';
import { security } from '@goodvibes-jev/engine/sdk/platform/runtime';
import { JudgmentError } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
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
  for (const phase of ['reading', 'prompt'] as const) {
    test(`${method} preserves real-manager attribution and cancellation during a pending ${phase}`, async () => {
      const root = mkdtempSync(join(tmpdir(), 'agent-permission-cancel-'));
      const path = join(root, 'read-target.txt');
      writeFileSync(path, 'fixture data');
      const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent') });
      config.set('permissions.mode', 'prompt');
      const entered = deferred();
      const release = deferred();
      const returned = deferred();
      const controller = new AbortController();
      const options = { signal: controller.signal };
      const attribution: PermissionAttribution = { kind: 'background-agent', agentId: 'agent-cancel-fixture', template: 'reader' };
      const store = new UserPermissionRuleStore(':memory:');
      let readingSignal: AbortSignal | undefined;
      let promptSignal: AbortSignal | undefined;
      let promptAttribution: PermissionAttribution | undefined;
      let prompts = 0;
      let fileReads = 0;
      const answers = fakePort((name, question) => {
        if (name === 'family') return choiceAnswer(question, 'generic', 0.99);
        if (name === 'kind') return choiceAnswer(question, 'read', 0.99);
        if (name === 'secrets') return noulAnswer(phase === 'prompt' ? 0.999 : 0.001);
        if (['mutates', 'outward', 'irreversible', 'beyondProject', 'weakensSecurity', 'obfuscated', 'catastrophic', 'cardDetails'].includes(name)) return noulAnswer(0.001);
        throw new Error(`Unscripted permission fixture question: ${name}`);
      });
      const previous = installJudgmentPort({
        model: answers.port.model,
        async ask(request) {
          readingSignal = request.signal;
          if (phase !== 'reading') return answers.port.ask(request);
          entered.resolve();
          await release.promise; // The underlying reader ignores cancellation.
          try { return await answers.port.ask(request); }
          finally { returned.resolve(); }
        },
      });
      const manager = new PermissionManager(async (request, execution) => {
        prompts++;
        promptAttribution = request.attribution;
        promptSignal = execution?.signal;
        entered.resolve();
        await release.promise;
        returned.resolve();
        return { approved: true, rememberTier: 'tool' };
      }, createPermissionConfigReader(config), new security.PolicyRuntimeState(), null, null, store);
      // These spies call through to the real public manager methods.
      const original = spyOn(manager, method);
      installPermissionManagerSafetyGuard(manager);
      const args = { files: [{ path }] };
      const pending = manager[method]('read', args, attribution, options).then((decision) => {
        const approved = typeof decision === 'boolean' ? decision : decision.approved;
        if (approved) { fileReads++; readFileSync(path, 'utf8'); }
        return decision;
      });
      const outcome = pending.then((value) => ({ value }), (error: unknown) => ({ error }));
      try {
        await within(entered.promise);
        expect(original.mock.calls[0]?.[2]).toBe(attribution);
        expect(original.mock.calls[0]?.[3]?.signal).toBe(controller.signal);
        expect(readingSignal).toBe(controller.signal);
        if (phase === 'prompt') {
          expect(promptAttribution).toBe(attribution);
          expect(promptSignal).toBe(controller.signal);
        } else expect(prompts).toBe(0);
        options.signal = new AbortController().signal;
        controller.abort(new Error('synthetic private cancellation context'));
        const result = await within(outcome);
        expect(result).toMatchObject({ error: { name: 'JudgmentError', kind: 'aborted' } });
        expect(JSON.stringify(result)).not.toContain('synthetic private cancellation context');
        expect(fileReads).toBe(0);
        release.resolve();
        await within(returned.promise);
        await Bun.sleep(0);
        expect(fileReads).toBe(0);
        expect(store.list()).toHaveLength(0);
        expect(await outcome).toEqual(result);
      } finally {
        release.resolve();
        controller.abort();
        await within(outcome).catch(() => undefined);
        original.mockRestore();
        installJudgmentPort(previous);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }

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
      expect(await outcome).toMatchObject({ name: 'AbortError', message: 'The permission request was cancelled' });
      expect(JSON.stringify(await outcome)).not.toContain('synthetic private racing reason');
    });
  }
}
