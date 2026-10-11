/** Engine-owned test host. Product acceptance reaches it over the public HTTP
 * contract instead of importing private engine fixtures across workspaces. */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitFor } from '../contract/runner-support.js';
import { terminal } from '../contract/steps-support.js';
import { createNativeIntegrationRepairFixture, integrationBarrier } from '../contract/native-integration-support.js';
import { createNativeReviewedRepairFixture } from '../contract/native-reviewed-repair-support.js';
import { createOperatorSdk } from '../../operator-sdk/src/client.js';
import { createOperatorNativeWorkExecutionClient } from '../../sdk/src/platform/workflow/work-ledger/native-execution-client.js';

const reviewed = process.argv.includes('--reviewed-repair');
const reviewedFixture = reviewed ? await createNativeReviewedRepairFixture() : undefined;
const f = reviewedFixture ?? await createNativeIntegrationRepairFixture({ withoutInspection: process.argv.includes('--without-inspection') });
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let hold: { gate: ReturnType<typeof integrationBarrier>; delivered: ReturnType<typeof integrationBarrier>; captured: boolean; statusOrdinal?: number } | undefined;
let statusOrdinal = 0;
// Transport interruption only: capture the actual authenticated status bytes
// before holding delivery. Neither product nor fixture fabricates an inspection.
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, async fetch(request) {
  const isStatus = new URL(request.url).pathname === '/api/work-ledger/execution/status';
  const ordinal = isStatus ? ++statusOrdinal : undefined;
  const response = await f.fetch(request);
  const active = hold;
  if (ordinal !== undefined && active && !active.captured) {
    active.captured = true; active.statusOrdinal = ordinal;
    const body = await response.arrayBuffer();
    emit({ kind: 'status-held', statusOrdinal: ordinal });
    await active.gate.wait();
    active.delivered.release();
    return new Response(body, { status: response.status, headers: response.headers });
  }
  return response;
} });
const baseUrl = `http://127.0.0.1:${server.port}`;
const client = createOperatorNativeWorkExecutionClient(createOperatorSdk({ baseUrl, authToken: f.paired.token, retry: { maxAttempts: 1 } }), 'project');
let remergeCalls = 0;
let recovery: { starts: number; resumes: number; agents: () => number } | undefined;
let stop = false;
let stage = 'native-start';
let contractId: string | undefined;
try {
  const started = await client.start(f.identity);
  if (started.kind !== 'execution' || !started.receipt) throw new Error('Missing actual native test receipt');
  contractId = started.receipt.contractId;
  stage = 'repair-readiness';
  await f.waitForRepair();
  const engine = f.engines.get(contractId);
  if (!engine) throw new Error('Missing actual native test engine');
  const retry = engine.retryItemIntegration.bind(engine);
  engine.retryItemIntegration = (...args) => { remergeCalls++; return retry(...args); };
  // The ephemeral fixture token is sent only through the child's private pipe.
  emit({ kind: 'ready', baseUrl, token: f.paired.token, identity: f.identity, contractId,
    ...(reviewedFixture ? { projectRoot: reviewedFixture.root, commitsBefore: reviewedFixture.commitsBefore } : {}) });
  stage = 'command';
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 4096) throw new Error('Oversized test-host control message');
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      const command: unknown = JSON.parse(line);
      if (command === null || typeof command !== 'object' || Object.keys(command).length !== 1 || !('type' in command)) throw new Error('Invalid test-host control message');
      if (command.type === 'repair') {
        f.releaseRepair(); await f.waitForRepaired(contractId); emit({ kind: 'repaired' });
      } else if (command.type === 'reviewed-proof') {
        if (!reviewedFixture) throw new Error('Reviewed proof requires the reviewed-repair scenario');
        emit({ kind: 'reviewed-proof', ...reviewedFixture.proof(contractId) });
      } else if (command.type === 'remerge') {
        // Reconcile the genuine preserved branch, exactly as the engine-owned
        // lifecycle acceptance does; only the real engine can clear conflict.
        const inspection = f.harness.runner.inspectIntegration(contractId);
        const unit = inspection.state === 'live' ? inspection.units.find(candidate => candidate.item.state === 'recorded' && candidate.item.integration === 'conflict') : undefined;
        if (!unit || unit.item.state !== 'recorded' || !unit.item.worktreePath || unit.unitStatus !== 'passed') throw new Error('Missing repaired preserved branch');
        const worktree = unit.item.worktreePath;
        const branch = f.harness.runner.get(contractId)?.branch;
        if (!branch) throw new Error('Missing native integration branch');
        const merge = spawnSync('git', ['-C', worktree, 'merge', '--no-commit', branch], { encoding: 'utf8' });
        if (merge.status !== 0 && merge.status !== 1) throw new Error('Native branch reconciliation failed');
        writeFileSync(join(worktree, 'src/shared.ts'), 'both writers repaired\n');
        for (const args of [['add', 'src/shared.ts'], ['commit', '--allow-empty', '-m', 'Reconcile original branch with native repair']]) {
          if (spawnSync('git', ['-C', worktree, ...args], { encoding: 'utf8' }).status !== 0) throw new Error('Native branch reconciliation failed');
        }
        if (await engine.retryItemIntegration(unit.item.itemId) !== 'merged') throw new Error('Native remerge failed');
        emit({ kind: 'remerged' });
      } else if (command.type === 'finish') {
        f.releaseTail();
        await waitFor(() => terminal(f.harness, contractId!), 'native terminal completion', 15_000);
        await f.harness.runner.join(contractId);
        if (f.harness.runner.get(contractId)?.status !== 'passed') throw new Error('Native completion did not pass');
        emit({ kind: 'finished' });
      } else if (command.type === 'restart-host') {
        const replacement = f.replaceHostForRecovery();
        const counts = { starts: 0, resumes: 0, agents: () => replacement.harness.manager.list().length };
        recovery = counts;
        const start = replacement.harness.runner.startDurable.bind(replacement.harness.runner);
        const resume = replacement.harness.runner.resumeDurable.bind(replacement.harness.runner);
        replacement.harness.runner.startDurable = (...args) => { counts.starts++; return start(...args); };
        replacement.harness.runner.resumeDurable = (...args) => { counts.resumes++; return resume(...args); };
        emit({ kind: 'host-restarted' });
      } else if (command.type === 'inspect-recovery') {
        if (!recovery) throw new Error('Native fixture host was not replaced');
        emit({ kind: 'recovery-inspection', starts: recovery.starts, resumes: recovery.resumes, agents: recovery.agents() });
      } else if (command.type === 'hold-status') {
        if (hold) throw new Error('A native status hold already exists');
        hold = { gate: integrationBarrier(), delivered: integrationBarrier(), captured: false };
        emit({ kind: 'holding' });
      } else if (command.type === 'release-status') {
        if (!hold?.captured) throw new Error('No captured native status reply');
        const releasedOrdinal = hold.statusOrdinal;
        hold.gate.release(); await hold.delivered.wait(); hold = undefined;
        emit({ kind: 'status-released', statusOrdinal: releasedOrdinal });
      } else if (command.type === 'inspect') {
        emit({ kind: 'inspection', remergeCalls, escalations: f.harness.runner.get(contractId)?.escalations.length ?? -1,
          mutationCount: f.requests.filter(request => /\/(start|resume|cancel)$/.test(new URL(request.url).pathname)).length });
      } else if (command.type === 'stop') { stop = true; break; }
      else throw new Error('Unknown test-host control message');
    }
    if (stop) break;
  }
} catch {
  // Only bounded fixture-owned enum/count facts cross the diagnostic pipe.
  // Never forward exception prose, bearer tokens, request bodies or paths.
  const run = contractId ? f.harness.runner.get(contractId) : null;
  emit({ kind: 'failure', stage, contractStatus: run?.status ?? null,
    unitCount: run?.units.length ?? 0, fixRequestCount: f.fixRequests.length });
  throw new Error(`Native fixture failed during ${stage}`);
} finally {
  hold?.gate.release(); client.dispose(); await server.stop(true); await f.dispose();
}
