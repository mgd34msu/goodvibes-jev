/** Engine-owned test host. Product acceptance reaches it over the public HTTP
 * contract instead of importing private engine fixtures across workspaces. */
import { createNativeIntegrationRepairFixture } from '../contract/native-integration-support.js';
import { createOperatorSdk } from '../../operator-sdk/src/client.js';
import { createOperatorNativeWorkExecutionClient } from '../../sdk/src/platform/workflow/work-ledger/native-execution-client.js';

const f = await createNativeIntegrationRepairFixture({ withoutInspection: process.argv.includes('--without-inspection') });
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: request => f.fetch(request) });
const baseUrl = `http://127.0.0.1:${server.port}`;
const client = createOperatorNativeWorkExecutionClient(createOperatorSdk({ baseUrl, authToken: f.paired.token, retry: { maxAttempts: 1 } }), 'project');
const emit = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
let remergeCalls = 0;
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
  emit({ kind: 'ready', baseUrl, token: f.paired.token, identity: f.identity, contractId });
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
  client.dispose(); await server.stop(true); await f.dispose();
}
