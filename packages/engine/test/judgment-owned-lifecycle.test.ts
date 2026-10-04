import { describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort, judgmentPort } from '@goodvibes-jev/engine/errors';
import { noul, SqliteDecisionLog } from '@goodvibes-jev/judgment';
import { createAsyncDisposalScope, createDisposalScope } from '../sdk/src/platform/runtime/disposal.ts';
import { composeJudgment, type JudgmentSettingsSource } from '../sdk/src/platform/runtime/judgment-services.ts';
import { decisionLogPath } from '../sdk/src/platform/state/decision-log.ts';

const request = { state: { fixture: 'native lifecycle' }, questions: { yes: noul('Is this a lifecycle fixture?') }, context: { site: 'test.native-lifecycle' } };
const source = (endpoint: string, secrets: JudgmentSettingsSource['secrets'] = { get: async () => 'synthetic-key' }): JudgmentSettingsSource => ({
  config: { get: (key) => ({ 'judgment.endpoint': endpoint, 'judgment.model': 'jev-1.13.0', 'judgment.timeoutMs': 1000, 'judgment.keySource': 'secret' })[key] },
  env: {}, secrets,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('native judgment ownership', () => {
  test('reentrant shutdown during live settings inspection still records before closing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'judgment-reentrant-'));
    const previous = installJudgmentPort(undefined); const scope = createAsyncDisposalScope('fixture');
    const settings = source('http://127.0.0.1:1');
    const { port } = composeJudgment({ ...settings, config: { get(key) {
      if (key === 'judgment.model') scope.dispose();
      return settings.config.get(key);
    } }, stateRoot: root, disposal: scope.registry });
    try {
      await expect(port.ask(request)).rejects.toMatchObject({ kind: 'aborted' });
      await scope.close();
      using persisted = new SqliteDecisionLog(decisionLogPath(root));
      expect(persisted.query()).toMatchObject([{ status: 'failed', error: { kind: 'aborted' } }]);
    } finally { await scope.close(); installJudgmentPort(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test.each(['sync', 'async'] as const)('%s disposal retires immediately and drains accepted records before log closure', async (mode) => {
    const root = mkdtempSync(join(tmpdir(), 'judgment-owned-'));
    const previous = installJudgmentPort(undefined);
    const scope = mode === 'sync' ? createDisposalScope('fixture') : createAsyncDisposalScope('fixture');
    const entered = deferred(); const release = deferred(); const closed = deferred();
    const events: string[] = [];
    const { port, decisionLog } = composeJudgment({ ...source('http://127.0.0.1:1', { get: async () => {
      entered.resolve(); await release.promise; return 'synthetic-key';
    } }), stateRoot: root, disposal: scope.registry });
    const record = decisionLog.record.bind(decisionLog);
    const recordSpy = spyOn(decisionLog, 'record').mockImplementation((entry) => { events.push('record'); return record(entry); });
    const dispose = decisionLog[Symbol.dispose].bind(decisionLog);
    const disposeSpy = spyOn(decisionLog, Symbol.dispose).mockImplementation(() => { events.push('close'); dispose(); closed.resolve(); });
    try {
      const pending = port.ask(request).catch((error: unknown) => error);
      await entered.promise;
      scope.dispose();
      expect(installJudgmentPort(undefined)).toBeUndefined();
      expect(events).toEqual([]);
      await expect(port.ask(request)).rejects.toMatchObject({ kind: 'aborted' });
      expect(await pending).toMatchObject({ kind: 'aborted' });
      await closed.promise;
      expect(events).toEqual(['record', 'close']);
      // Settling the abandoned key acquisition after closure cannot send or
      // attempt another record against the now-closed connection.
      release.resolve(); await Bun.sleep(5); expect(events).toEqual(['record', 'close']);
      using persisted = new SqliteDecisionLog(decisionLogPath(root));
      expect(persisted.query()).toMatchObject([{ status: 'failed', error: { kind: 'aborted' } }]);
      scope.dispose(); expect(disposeSpy).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve(); scope.dispose(); await closed.promise;
      recordSpy.mockRestore(); disposeSpy.mockRestore(); installJudgmentPort(previous); rmSync(root, { recursive: true, force: true });
    }
  });

  test.each(['runtime shutdown', 'caller cancel'] as const)('%s drains even when the secret getter never cooperates', async (stop) => {
    const root = mkdtempSync(join(tmpdir(), 'judgment-key-stop-'));
    const previous = installJudgmentPort(undefined); const scope = createAsyncDisposalScope('fixture');
    const entered = deferred(); const abort = new AbortController();
    const { port, decisionLog } = composeJudgment({ ...source('http://127.0.0.1:1', { get: async () => {
      entered.resolve(); return await new Promise<string>(() => {});
    } }), stateRoot: root, disposal: scope.registry });
    try {
      const pending = port.ask({ ...request, signal: abort.signal }).catch((error: unknown) => error);
      await entered.promise;
      if (stop === 'runtime shutdown') scope.dispose(); else abort.abort();
      expect(await pending).toMatchObject({ kind: 'aborted' });
      if (stop === 'caller cancel') expect(decisionLog.query()).toMatchObject([{ status: 'failed', error: { kind: 'aborted' } }]);
      await scope.close();
      using persisted = new SqliteDecisionLog(decisionLogPath(root));
      expect(persisted.query()).toMatchObject([{ status: 'failed', error: { kind: 'aborted' } }]);
    } finally { await scope.close(); installJudgmentPort(previous); rmSync(root, { recursive: true, force: true }); }
  });

  test.each(['runtime shutdown', 'caller cancel'] as const)('%s stops central outage retries with one terminal decision record', async (stop) => {
    const root = mkdtempSync(join(tmpdir(), 'judgment-retry-stop-'));
    const previous = installJudgmentPort(undefined);
    const scope = createAsyncDisposalScope('fixture'); const retried = deferred();
    let calls = 0;
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { calls++; return new Response('', { status: 503 }); } });
    const { port, decisionLog } = composeJudgment({ ...source(`http://127.0.0.1:${server.port}`), stateRoot: root, disposal: scope.registry });
    const abort = new AbortController();
    try {
      const pending = port.ask({ ...request, signal: abort.signal, onRetry: retried.resolve }).catch((error: unknown) => error);
      await retried.promise;
      const closing = stop === 'runtime shutdown' ? scope.close() : undefined;
      if (stop === 'caller cancel') abort.abort();
      expect(await pending).toMatchObject({ kind: 'aborted' });
      if (closing) await closing;
      else {
        expect(judgmentPort('still active')).toBe(port);
        expect(decisionLog.query()).toMatchObject([{ status: 'failed', error: { kind: 'aborted' } }]);
        await scope.close();
      }
      expect(calls).toBe(1);
      using persisted = new SqliteDecisionLog(decisionLogPath(root));
      const records = persisted.query();
      expect(records).toHaveLength(1); expect(records[0]).toMatchObject({ status: 'failed', error: { kind: 'aborted' } });
      expect(records[0]?.lineage?.attempts).toHaveLength(1);
    } finally { await scope.close(); server.stop(true); installJudgmentPort(previous); rmSync(root, { recursive: true, force: true }); }
  });
});
