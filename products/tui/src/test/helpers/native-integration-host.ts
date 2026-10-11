/** Engine-owned native fixture; product tests use only its private control pipe and public HTTP. */
import { isAbsolute, resolve } from 'node:path';
import { nativeWorkExecutionIdentitySchema, type NativeWorkExecutionIdentity } from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-execution-client';

async function within<T>(promise: Promise<T>, label: string, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

interface HostReady { baseUrl: string; token: string; identity: NativeWorkExecutionIdentity; contractId: string; projectRoot?: string; commitsBefore?: number }

export interface NativeReviewedProof {
  checks: { id: string; trigger: string; result: string; evidenceDigest: string; sourceRead: 'fixed' | 'buggy' | 'missing'; answered: boolean }[];
  decisions: { stage: string; outcome: string; sourceBound: boolean; answered: boolean }[];
  fixRounds: number; fixWorkers: number; fixPlans: number; escalations: number; status: string;
  commit: { status: string; hash?: string; note?: string } | null;
  goal: string; criteria: string[]; sourceGoal: string; sourceCriteria: string[];
}

/** Keep the host fixture behind a process/HTTP boundary, just like a daemon. */
export function launchNativeIntegrationHost(withoutInspection = false, scenario: 'conflict' | 'reviewed-repair' = 'conflict') {
  if (withoutInspection && scenario === 'reviewed-repair') throw new Error('Reviewed repair requires native inspection');
  const script = resolve(import.meta.dir, '../../../../../packages/engine/test/helpers/native-integration-host-child.ts');
  const child = Bun.spawn([process.execPath, '--no-env-file', script, ...(withoutInspection ? ['--without-inspection'] : []), ...(scenario === 'reviewed-repair' ? ['--reviewed-repair'] : [])], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const output = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = '';
  // Drain rather than retain stderr: fixture failures must not leak its ephemeral bearer.
  const drained = (async () => { const reader = child.stderr.getReader(); try { while (!(await reader.read()).done) {} } finally { reader.releaseLock(); } })().catch(() => {});
  const event = (kind: string, milliseconds = 25_000): Promise<Record<string, unknown>> => within((async () => {
    while (true) {
      const end = buffered.indexOf('\n');
      if (end >= 0) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw new Error('Native fixture emitted an invalid protocol event'); }
        if (value && typeof value === 'object' && 'kind' in value && value.kind === 'failure') {
          const failure = value as Record<string, unknown>;
          const statuses = ['queued', 'shaping', 'planning', 'checking-plan', 'running', 'judging', 'fixing', 'committing', 'awaiting-owner', 'passed', 'failed', 'cancelled'];
          if (Object.keys(failure).sort().join(',') !== 'contractStatus,fixRequestCount,kind,stage,unitCount'
            || typeof failure.stage !== 'string' || !['native-start', 'repair-readiness', 'command'].includes(failure.stage)
            || !(failure.contractStatus === null || typeof failure.contractStatus === 'string' && statuses.includes(failure.contractStatus))
            || ![failure.unitCount, failure.fixRequestCount].every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 1_000)) throw new Error('Native fixture emitted invalid failure diagnostics');
          throw new Error(`Native fixture failure: ${JSON.stringify({ stage: failure.stage, contractStatus: failure.contractStatus, unitCount: failure.unitCount, fixRequestCount: failure.fixRequestCount })}`);
        }
        if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== kind) throw new Error('Native fixture emitted an unexpected protocol event');
        return value as Record<string, unknown>;
      }
      const next = await output.read();
      if (next.done) throw new Error('Native fixture exited before its protocol reply');
      buffered += decoder.decode(next.value, { stream: true });
      if (buffered.length > 8_192) throw new Error('Native fixture protocol reply exceeded its bound');
    }
  })(), `native fixture ${kind}`, milliseconds);
  const send = async (type: 'repair' | 'inspect' | 'stop' | 'remerge' | 'finish' | 'hold-status' | 'release-status' | 'restart-host' | 'inspect-recovery' | 'reviewed-proof') => {
    child.stdin.write(`${JSON.stringify({ type })}\n`); await child.stdin.flush();
  };
  return {
    async ready(): Promise<HostReady> {
      const value = await event('ready', 30_000);
      const identity = nativeWorkExecutionIdentitySchema.safeParse(value.identity);
      if (typeof value.baseUrl !== 'string' || typeof value.token !== 'string' || !value.token || typeof value.contractId !== 'string' || !value.contractId || !identity.success) throw new Error('Native fixture ready event is incomplete');
      let url: URL;
      try { url = new URL(value.baseUrl); } catch { throw new Error('Native fixture did not provide a local HTTP endpoint'); }
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password) throw new Error('Native fixture did not provide a local HTTP endpoint');
      if (scenario === 'reviewed-repair' && (typeof value.projectRoot !== 'string' || !isAbsolute(value.projectRoot)
        || typeof value.commitsBefore !== 'number' || !Number.isSafeInteger(value.commitsBefore) || value.commitsBefore < 1)) throw new Error('Reviewed fixture source repository is incomplete');
      return { baseUrl: value.baseUrl, token: value.token, identity: identity.data, contractId: value.contractId,
        ...(scenario === 'reviewed-repair' ? { projectRoot: value.projectRoot as string, commitsBefore: value.commitsBefore as number } : {}) };
    },
    async reviewedProof(): Promise<NativeReviewedProof> {
      await within(send('reviewed-proof'), 'native reviewed proof', 2_000); const value = await event('reviewed-proof');
      const record = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input);
      const strings = (input: unknown): input is string[] => Array.isArray(input) && input.every(item => typeof item === 'string');
      if (!Array.isArray(value.checks) || !value.checks.every(check => record(check) && typeof check.id === 'string'
          && typeof check.trigger === 'string' && typeof check.result === 'string' && typeof check.evidenceDigest === 'string'
          && /^[a-f0-9]{64}$/.test(check.evidenceDigest) && ['fixed', 'buggy', 'missing'].includes(String(check.sourceRead)) && typeof check.answered === 'boolean')
        || !Array.isArray(value.decisions) || !value.decisions.every(decision => record(decision) && ['stall', 'fix-plan'].includes(String(decision.stage))
          && ['act', 'revise', 'defer', 'reject'].includes(String(decision.outcome)) && typeof decision.sourceBound === 'boolean' && typeof decision.answered === 'boolean')
        || ![value.fixRounds, value.fixWorkers, value.fixPlans, value.escalations].every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
        || typeof value.status !== 'string' || typeof value.goal !== 'string' || typeof value.sourceGoal !== 'string'
        || !strings(value.criteria) || !strings(value.sourceCriteria)
        || !(value.commit === null || record(value.commit) && typeof value.commit.status === 'string'
          && (value.commit.hash === undefined || typeof value.commit.hash === 'string' && /^[a-f0-9]{40}$/.test(value.commit.hash))
          && (value.commit.note === undefined || typeof value.commit.note === 'string'))) throw new Error('Native reviewed proof is incomplete');
      const { kind: _kind, ...proof } = value;
      return proof as unknown as NativeReviewedProof;
    },
    async repair() { await within(send('repair'), 'native repair request', 2_000); await event('repaired'); },
    async remerge() { await within(send('remerge'), 'native remerge request', 2_000); await event('remerged'); },
    async finish() { await within(send('finish'), 'native finish request', 2_000); await event('finished'); },
    async restartHost() { await within(send('restart-host'), 'native host replacement', 2_000); await event('host-restarted'); },
    async inspectRecovery() {
      await within(send('inspect-recovery'), 'native recovery inspection', 2_000); const value = await event('recovery-inspection');
      if (![value.starts, value.resumes, value.agents].every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) throw new Error('Native recovery inspection reply is incomplete');
      return { starts: value.starts, resumes: value.resumes, agents: value.agents };
    },
    async holdStatus() { await within(send('hold-status'), 'native hold request', 2_000); await event('holding'); },
    async heldStatus() {
      const value = await event('status-held', 10_000);
      if (typeof value.statusOrdinal !== 'number' || !Number.isSafeInteger(value.statusOrdinal) || value.statusOrdinal < 1) throw new Error('Native held status ordinal is invalid');
      return value.statusOrdinal;
    },
    async releaseStatus() {
      await within(send('release-status'), 'native release request', 2_000); const value = await event('status-released');
      if (typeof value.statusOrdinal !== 'number' || !Number.isSafeInteger(value.statusOrdinal) || value.statusOrdinal < 1) throw new Error('Native released status ordinal is invalid');
      return value.statusOrdinal;
    },
    async inspect() {
      await within(send('inspect'), 'native inspection request', 2_000); const value = await event('inspection');
      if (![value.remergeCalls, value.escalations, value.mutationCount].every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)) throw new Error('Native fixture inspection reply is incomplete');
      return { remergeCalls: value.remergeCalls, escalations: value.escalations, mutationCount: value.mutationCount };
    },
    async stop() {
      try {
        if (child.exitCode === null) {
          try { await within(send('stop'), 'native fixture stop request', 2_000); child.stdin.end(); await within(child.exited, 'native fixture shutdown', 10_000); }
          catch {
            child.kill('SIGTERM');
            try { await within(child.exited, 'native fixture termination', 2_000); }
            catch { child.kill('SIGKILL'); await within(child.exited, 'native fixture reap', 2_000); }
          }
        }
        const code = await within(child.exited, 'native fixture exit', 2_000);
        if (code !== 0) throw new Error('Native fixture exited unsuccessfully');
      } finally {
        await within(output.cancel().catch(() => {}), 'native fixture stdout cleanup', 2_000);
        await within(drained, 'native fixture stderr cleanup', 2_000);
      }
    },
  };
}
