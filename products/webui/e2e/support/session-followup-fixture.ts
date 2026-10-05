/** Exact real HTTP captures, replayed through the production browser SDK. */
import { readFileSync } from 'node:fs';
import type { Page, Route } from '@playwright/test';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import type { OperatorMethodOutput } from '@goodvibes-jev/engine/contracts';
import operatorContract from '@goodvibes-jev/engine/contracts/operator-contract.json' with { type: 'json' };
import { installMockDaemon } from './mock-daemon';

export type FollowUpOutcome = 'completed' | 'failed' | 'cancelled';
type ReceiptPhase = 'queued' | 'delivered' | 'terminal';
interface WireResponse {
  methodId: string;
  method: string;
  path: string;
  status: number;
  body: string;
  requestBody?: unknown;
}
interface FollowUpCapture {
  source: string;
  outcome: FollowUpOutcome;
  registration: WireResponse;
  initialSession: WireResponse;
  initialMessages: WireResponse;
  post: WireResponse;
  queued: WireResponse;
  messages: WireResponse;
  sessionAfterPost: WireResponse;
  delivery?: WireResponse;
  delivered?: WireResponse;
  terminalWrite?: WireResponse;
  terminalMutation?: { method: string; error: string };
  terminal: WireResponse;
}

export function loadFollowUpCapture(outcome: FollowUpOutcome) {
  const capture = JSON.parse(readFileSync(new URL(`./fixtures/session-followup/${outcome}.json`, import.meta.url), 'utf8')) as FollowUpCapture;
  for (const wire of [capture.registration, capture.initialSession, capture.initialMessages, capture.post, capture.queued,
    capture.messages, capture.sessionAfterPost, capture.delivery, capture.delivered, capture.terminalWrite, capture.terminal]) {
    if (!wire) continue;
    const schema = operatorContract.operator.methods.find(entry => entry.id === wire.methodId)?.outputSchema;
    const value: unknown = JSON.parse(wire.body);
    if (!schema || firstJsonSchemaFailure(schema, value)) throw new Error(`Invalid ${outcome} capture: ${wire.methodId} ${wire.path}`);
  }
  const post = JSON.parse(capture.post.body) as OperatorMethodOutput<'sessions.followUp'>;
  const terminal = JSON.parse(capture.terminal.body) as OperatorMethodOutput<'sessions.inputs.list'>;
  if (!post.session || capture.outcome !== outcome || capture.post.status !== 202 || post.mode !== 'queued-for-surface'
    || post.agentId !== null || post.input.state !== 'queued'
    || terminal.inputs[0]?.id !== post.input.id || terminal.inputs[0]?.state !== outcome) {
    throw new Error(`Broken input lifecycle capture: ${outcome}`);
  }
  return { ...capture, input: post.input, session: post.session, terminalInput: terminal.inputs[0] };
}

export const FOLLOWUP_CAPTURES = {
  completed: loadFollowUpCapture('completed'),
  failed: loadFollowUpCapture('failed'),
  cancelled: loadFollowUpCapture('cancelled'),
};

/** Unrelated Work state is synthetic; these session REST response bodies are not. */
export async function installFollowUpDaemon(page: Page, outcome: FollowUpOutcome = 'completed', options: {
  postResponse?: 'captured' | 'disconnected';
} = {}) {
  const daemon = await installMockDaemon(page);
  const capture = FOLLOWUP_CAPTURES[outcome];
  let phase: ReceiptPhase = 'queued';
  let submitted = false;
  let failReads = false;
  const reads: { path: string; phase: ReceiptPhase; failed: boolean }[] = [];
  const writes: { method: string; path: string; body: unknown }[] = [];
  const reply = (route: Route, wire: WireResponse) => route.fulfill({ status: wire.status, contentType: 'application/json', body: wire.body });
  const path = `/api/sessions/${capture.input.sessionId}`;
  await page.route('**/api/sessions/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'POST') {
      writes.push({ method: request.method(), path: url.pathname, body: request.postDataJSON() as unknown });
      if (url.pathname !== `${path}/follow-up`) return route.fulfill({ status: 405, json: { error: 'Unexpected fixture mutation.' } });
      submitted = true;
      if (options.postResponse === 'disconnected') return route.abort('connectionreset');
      return reply(route, capture.post);
    }
    if (url.pathname === `${path}/inputs`) {
      reads.push({ path: url.pathname, phase, failed: failReads });
      if (failReads) return route.fulfill({ status: 503, json: { error: 'Fixture input refresh unavailable.' } });
      const response = capture[phase];
      if (!response) throw new Error(`No genuine ${phase} response for ${outcome}`);
      return reply(route, response);
    }
    if (url.pathname === `${path}/messages`) return reply(route, submitted ? capture.messages : capture.initialMessages);
    if (url.pathname === path) return reply(route, submitted ? capture.sessionAfterPost : capture.initialSession);
    return route.fallback();
  });
  return {
    ...daemon, capture, reads, writes,
    setPhase(next: ReceiptPhase) { phase = next; },
    setReadFailure(failed: boolean) { failReads = failed; },
  };
}
