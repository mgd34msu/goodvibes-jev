/** Genuine authenticated HTTP captures; browser failures are explicitly injected. */
import { readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import operatorContract from '@goodvibes-jev/engine/contracts/operator-contract.json' with { type: 'json' };
import inspectionSchema from '../../src/lib/generated/contract-inspection-schema.json' with { type: 'json' };
import type { ContractRecord } from '../../src/lib/contract-bridge-types';
import { installMockDaemon } from './mock-daemon';

export function loadCancellationCapture(name: 'live' | 'retained') {
  const read = (suffix: string) => readFileSync(new URL(`./fixtures/contract-cancellation/${name}-${suffix}.json`, import.meta.url), 'utf8');
  function inspect(phase: 'before' | 'after') {
    const getBody = read(`${phase}-get`), listBody = read(`${phase}-list`);
    const record: unknown = JSON.parse(getBody);
    const collection: unknown = JSON.parse(listBody);
    for (const [method, value] of [['contracts.get', record], ['contracts.list', collection]] as const) {
      const schema = operatorContract.operator.methods.find(entry => entry.id === method)?.outputSchema;
      if (!schema || firstJsonSchemaFailure(schema, value)) throw new Error(`Invalid captured ${name} ${phase} ${method}`);
    }
    if (firstJsonSchemaFailure(inspectionSchema, record)) throw new Error(`Product rejected captured ${name} ${phase}`);
    return { getBody, listBody, record: record as ContractRecord };
  }
  const resultBody = read('cancel');
  const result: unknown = JSON.parse(resultBody);
  const schema = operatorContract.operator.methods.find(entry => entry.id === 'contracts.cancel')?.outputSchema;
  if (!schema || firstJsonSchemaFailure(schema, result)) throw new Error(`Invalid captured ${name} cancellation`);
  return { name, before: inspect('before'), after: inspect('after'), resultBody };
}

export const LIVE_CANCELLATION = loadCancellationCapture('live');
export const RETAINED_CANCELLATION = loadCancellationCapture('retained');
export type CancellationCapture = ReturnType<typeof loadCancellationCapture>;
export type CancellationResponse = 'captured' | 'disconnected' | 'malformed' | 'server-error';

/** Only cancellation and inspection are overlaid; unrelated Work uses the normal mock. */
export async function installCancellationDaemon(page: Page, capture: CancellationCapture, options: {
  hold?: boolean;
  response?: CancellationResponse;
} = {}) {
  const daemon = await installMockDaemon(page);
  let phase: 'before' | 'after' = 'before';
  let held = options.hold ?? false;
  const pending: Route[] = [];
  const writes: { method: string; path: string; authorization: string | undefined; body: unknown }[] = [];

  async function answerCancel(route: Route) {
    // Model a write that might have arrived even when the response is lost.
    phase = 'after';
    if (options.response === 'disconnected') return route.abort('connectionreset');
    if (options.response === 'malformed') return route.fulfill({ json: { cancelled: 'true' } });
    if (options.response === 'server-error') return route.fulfill({ status: 503, json: { error: 'Cancellation response was interrupted.' } });
    return route.fulfill({ contentType: 'application/json', body: capture.resultBody });
  }

  await page.route('**/api/contracts**', async route => {
    const request = route.request(), url = new URL(request.url());
    if (request.method() === 'POST' && url.pathname === `/api/contracts/${capture.before.record.id}/cancel`) {
      writes.push({ method: request.method(), path: url.pathname, authorization: request.headers().authorization, body: request.postDataJSON() as unknown });
      if (held) { pending.push(route); return; }
      return answerCancel(route);
    }
    if (request.method() !== 'GET') return route.fulfill({ status: 405, json: { error: 'Unexpected fixture mutation.' } });
    const current = capture[phase];
    if (url.pathname === '/api/contracts') {
      const excluded = ['passed', 'failed', 'cancelled'].includes(current.record.status) && url.searchParams.get('includeTerminal') !== 'true';
      return route.fulfill({ contentType: 'application/json', body: excluded ? '{"contracts":[]}' : current.listBody });
    }
    if (url.pathname === `/api/contracts/${capture.before.record.id}`) return route.fulfill({ contentType: 'application/json', body: current.getBody });
    return route.fulfill({ status: 404, json: { error: 'Unknown captured contract.', code: 'CONTRACT_NOT_FOUND' } });
  });
  return {
    ...daemon, writes,
    get pendingCount() { return pending.length; },
    async release() {
      held = false;
      await Promise.all(pending.splice(0).map(answerCancel));
    },
  };
}
