/** Exact authenticated daemon captures through the production browser intake SDK. */
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import type { Page, Route } from '@playwright/test';
import { firstJsonSchemaFailure } from '@goodvibes-jev/engine/transport-http';
import operatorContract from '@goodvibes-jev/engine/contracts/operator-contract.json' with { type: 'json' };
import {
  nativeConversationIntakeCaptureRequestSchema, nativeConversationIntakeLookupResultSchema,
  nativeConversationIntakeTransitionRequestSchema,
  type NativeConversationIntakeCaptureRequest, type NativeConversationIntakeTransitionRequest,
} from '@goodvibes-jev/engine/sdk/platform/workflow/work-ledger/native-intake-client';
import { installMockDaemon } from './mock-daemon';

export type NativeIntakeCaptureName = 'work' | 'turn' | 'blocked' | 'refused' | 'cancelled' | 'recovery';
export type NativeIntakeOperation = 'capture' | 'get' | 'admit' | 'resume' | 'cancel';
export type NativeIntakeResponse = 'captured' | 'disconnected' | 'malformed' | 'server-error';
interface WireResponse {
  methodId: string;
  method: string;
  path: string;
  status: number;
  body: string;
  requestBody?: unknown;
}
interface NativeIntakeCapture {
  source: string;
  name: NativeIntakeCaptureName;
  input: NativeConversationIntakeCaptureRequest;
  transition: NativeConversationIntakeTransitionRequest;
  auth: WireResponse;
  project: WireResponse;
  lookupBefore: WireResponse;
  capture: WireResponse;
  getCaptured: WireResponse;
  admit: WireResponse;
  get: WireResponse;
  resume: WireResponse;
  cancel: WireResponse;
  pending?: WireResponse;
  replay?: WireResponse;
  repeatAdmit?: WireResponse;
  afterResume?: WireResponse;
}
type LookupPhase = 'lookupBefore' | 'getCaptured' | 'pending' | 'get' | 'resume' | 'cancel';

export function loadNativeIntakeCapture(name: NativeIntakeCaptureName) {
  const capture = JSON.parse(readFileSync(new URL(`./fixtures/native-intake/${name}.json`, import.meta.url), 'utf8')) as NativeIntakeCapture;
  if (capture.name !== name) throw new Error(`Wrong native intake capture: ${name}`);
  nativeConversationIntakeCaptureRequestSchema.parse(capture.input);
  nativeConversationIntakeTransitionRequestSchema.parse(capture.transition);
  for (const wire of [capture.auth, capture.project, capture.lookupBefore, capture.capture, capture.getCaptured, capture.admit,
    capture.get, capture.resume, capture.cancel, capture.pending, capture.replay, capture.repeatAdmit, capture.afterResume]) {
    if (!wire || wire.status >= 400) continue;
    const schema = operatorContract.operator.methods.find(entry => entry.id === wire.methodId)?.outputSchema;
    const value: unknown = JSON.parse(wire.body);
    if (!schema || firstJsonSchemaFailure(schema, value)) throw new Error(`Invalid ${name} capture: ${wire.methodId}`);
    if (!wire.methodId.startsWith('workLedger.intake.')) continue;
    const result = nativeConversationIntakeLookupResultSchema.parse(value);
    if (result.kind === 'not-found') continue;
    if (result.requestId !== capture.input.requestId || result.sourceRef.inputId !== capture.input.inputId
      || result.sourceRef.sourceRevision !== capture.transition.sourceRevision
      || result.projectId !== (JSON.parse(capture.project.body) as { projectId: string }).projectId
      || (result.kind === 'work' && result.receipt.goal !== capture.input.text)
      || (result.kind === 'turn' && result.text !== capture.input.text)) throw new Error(`Mismatched ${name} source identity`);
  }
  if (!isDeepStrictEqual(capture.capture.requestBody, capture.input) || capture.transition.inputId !== capture.input.inputId) {
    throw new Error(`Mismatched ${name} original capture request`);
  }
  return { ...capture, result: nativeConversationIntakeLookupResultSchema.parse(JSON.parse(capture.get.body)) };
}

export const NATIVE_INTAKE_CAPTURES = {
  work: loadNativeIntakeCapture('work'), turn: loadNativeIntakeCapture('turn'), blocked: loadNativeIntakeCapture('blocked'),
  refused: loadNativeIntakeCapture('refused'), cancelled: loadNativeIntakeCapture('cancelled'), recovery: loadNativeIntakeCapture('recovery'),
};

/**
 * Auth/project and native intake are exact captured responses. Unrelated Work
 * state uses the existing synthetic mock. Failure injection never edits source
 * identities, receipts or semantic outcomes to fit the request under test.
 */
export async function installNativeIntakeDaemon(page: Page, name: NativeIntakeCaptureName = 'work', options: {
  hold?: NativeIntakeOperation[];
  responses?: Partial<Record<NativeIntakeOperation, NativeIntakeResponse>>;
  seedIds?: boolean;
} = {}) {
  const daemon = await installMockDaemon(page);
  const capture = NATIVE_INTAKE_CAPTURES[name];
  const held = new Set(options.hold ?? []);
  const responses = { ...options.responses };
  const pending: { operation: NativeIntakeOperation; route: Route }[] = [];
  const intakeRequests: { operation: NativeIntakeOperation; method: string; path: string; authorization: string | undefined; body: unknown }[] = [];
  let phase: LookupPhase = 'lookupBefore';
  let admitStarted = false;
  let cancelled = false;
  let authBody = capture.auth.body;
  const reply = (route: Route, wire: WireResponse) => route.fulfill({ status: wire.status, contentType: 'application/json', body: wire.body });
  if (options.seedIds !== false) {
    await page.addInitScript(({ requestId, inputId }) => {
      // Work mounts its hosted attachment hook even with no selected session.
      // Give unrelated per-browser identities their own values before ID seeding.
      localStorage.setItem('goodvibes.webui.hosted.clientId', 'native-proof-hosted-client');
      localStorage.setItem('goodvibes.webui.push.deviceId', 'native-proof-push-device');
      const original = crypto.randomUUID?.bind(crypto);
      const ids = [requestId, inputId];
      Object.defineProperty(crypto, 'randomUUID', { configurable: true, value: () => ids.shift() ?? original?.() ?? 'unused-fixture-uuid' });
    }, capture.input);
  }
  await page.route('**/api/control-plane/auth', route => route.fulfill({ status: capture.auth.status, contentType: 'application/json', body: authBody }));
  await page.route('**/api/work-ledger/project', route => reply(route, capture.project));

  async function answer(operation: NativeIntakeOperation, route: Route) {
    let wire: WireResponse;
    if (operation === 'get') {
      const current = capture[phase];
      if (!current) throw new Error(`No captured ${name} lookup phase ${phase}`);
      wire = current;
    } else if (operation === 'capture') {
      wire = phase === 'lookupBefore' ? capture.capture : capture[phase] ?? capture.capture;
      if (phase === 'lookupBefore') phase = 'getCaptured';
    } else if (operation === 'admit') {
      wire = cancelled ? capture.admit : capture.admit.status >= 400 && phase === 'get' && capture.repeatAdmit ? capture.repeatAdmit : capture.admit;
      if (!cancelled) phase = 'get';
    } else if (operation === 'resume') {
      wire = cancelled ? capture.cancel : capture.resume;
      phase = cancelled ? 'cancel' : 'resume';
    } else {
      wire = capture.cancel;
      cancelled = true;
      phase = 'cancel';
    }
    const response = responses[operation];
    // The request may have reached durable state before any injected failure.
    if (response === 'disconnected') return route.abort('connectionreset');
    if (response === 'malformed') return route.fulfill({ json: { kind: 'work', receipt: { fabricated: true } } });
    if (response === 'server-error') return route.fulfill({ status: 503, json: { error: 'Owned browser fixture response interruption.' } });
    return reply(route, wire);
  }

  await page.route('**/api/work-ledger/intake/**', async route => {
    const request = route.request(), url = new URL(request.url());
    const operation = url.pathname.slice('/api/work-ledger/intake/'.length) as NativeIntakeOperation;
    if (request.method() !== 'POST' || !['capture', 'get', 'admit', 'resume', 'cancel'].includes(operation)) {
      return route.fulfill({ status: 405, json: { error: 'Unexpected native fixture route.' } });
    }
    const body: unknown = request.postDataJSON();
    intakeRequests.push({ operation, method: request.method(), path: url.pathname, authorization: request.headers().authorization, body });
    const expected = operation === 'capture' ? capture.input : operation === 'get' ? { inputId: capture.input.inputId } : capture.transition;
    if (!isDeepStrictEqual(body, expected)) return route.fulfill({ status: 409, json: { error: 'Browser request differs from the genuine captured source.' } });
    if (operation === 'admit' && !admitStarted) {
      admitStarted = true;
      if (capture.pending) phase = 'pending';
    }
    if (held.has(operation)) { pending.push({ operation, route }); return; }
    return answer(operation, route);
  });
  return {
    ...daemon, capture, intakeRequests,
    get writes() { return intakeRequests.filter(request => request.operation !== 'get'); },
    get reads() { return intakeRequests.filter(request => request.operation === 'get'); },
    get pendingCount() { return pending.length; },
    async release(operation?: NativeIntakeOperation) {
      if (operation) held.delete(operation); else held.clear();
      const selected = pending.filter(item => operation === undefined || item.operation === operation);
      for (const item of selected) pending.splice(pending.indexOf(item), 1);
      await Promise.all(selected.map(item => answer(item.operation, item.route)));
    },
    setResponse(operation: NativeIntakeOperation, response: NativeIntakeResponse) { responses[operation] = response; },
    setLookupPhase(next: LookupPhase) {
      if (!capture[next]) throw new Error(`No captured ${name} lookup phase ${next}`);
      phase = next;
    },
    /** Explicit authority-loss injection; ordinary replay always uses real bytes. */
    setAuthResponse(value: unknown) { authBody = JSON.stringify(value); },
  };
}
