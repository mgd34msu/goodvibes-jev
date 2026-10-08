import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createSystemOnePort, SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { createBrowserJudgmentHttpHandler, type AuthenticatedPrincipal, type BrowserJudgmentRequest } from '../daemon-sdk/src/index.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { createEmailInboxReadHandler, type EmailGatewayMessageDetail } from '../sdk/src/platform/control-plane/routes/email.ts';
import { createServiceBackedGateway, instrumentEmailGateway } from '../sdk/src/platform/control-plane/routes/email-composition.ts';
import { createSettingsJudgmentPort } from '../sdk/src/platform/runtime/judgment-services.ts';
import { createWebuiBrowserJudgment } from '../sdk/src/platform/judgment-browser/webui-runtime.ts';
import { withWebuiAnswerBoundary } from '../sdk/src/platform/judgment-browser/batteries/webui-answers.ts';
import { deferred, mailFixture, type ReadPlan } from './_helpers/mail-subject-source.ts';

const owner: AuthenticatedPrincipal = { principalId: 'synthetic-mail-owner', principalKind: 'user', admin: false, scopes: ['read:email', 'write:judgment'] };
const ORIGIN = 'https://daemon.fixture.invalid';
const request = (subjectRef: string): BrowserJudgmentRequest<'webui.mail.reply-subject'> => ({ protocolVersion: 1, batteryVersion: 1, requestId: crypto.randomUUID(), battery: 'webui.mail.reply-subject', input: { subjectRef } });
function fixture(options: { plans?: ReadPlan[]; probability?: number; transport?: JudgmentPort; beforeAnswer?: () => Promise<void> } = {}) {
  const mail = mailFixture(options.plans ? { plans: options.plans } : {});
  const gateway = instrumentEmailGateway(createServiceBackedGateway(mail.service), {});
  const log = new SqliteDecisionLog(':memory:');
  const calls: unknown[] = [];
  let actor = owner; let authorized = true;
  const inner: JudgmentPort = options.transport ?? { model: 'jev-1.13.0', async ask(input) {
    calls.push(input.state); await options.beforeAnswer?.();
    return { model: 'jev-1.13.0', requestedModel: 'jev-1.13.0', requestId: undefined, usage: { inputTokens: 1, outputTokens: 1 }, latencyMs: 1,
      answers: { already_reply: { type: 'noul', noul: options.probability ?? 0.99 } } as never };
  } };
  const methods = new GatewayMethodCatalog();
  const service = createWebuiBrowserJudgment({ methods,
    currentRoute: () => ({ revision: 'synthetic-configured-route', kind: 'local', port: withDecisionLog(withWebuiAnswerBoundary(inner), log), assertCurrent() {} }),
    authorize: input => authorized && input.battery === 'webui.mail.reply-subject' && input.sources.length === 1 && input.sources[0] === 'mail-subject',
  });
  const readHandler = createEmailInboxReadHandler(gateway, service);
  const read = async (uid = 12, fresh = true) => await readHandler({ query: { uid }, context: owner, isAuthorized: () => fresh }) as EmailGatewayMessageDetail;
  const handler = createBrowserJudgmentHttpHandler({ authenticate: () => actor, sameOrigins: () => [ORIGIN], cors: () => ({ enabled: false, allowedOrigins: [] }), service });
  const wire = async (input: BrowserJudgmentRequest, signal?: AbortSignal) => {
    const response = await handler(new Request(`${ORIGIN}/api/judgment/batteries/run`, { method: 'POST', ...(signal ? { signal } : {}),
      headers: { origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(input) }));
    return { status: response.status, body: await response.text() };
  };
  return { mail, gateway, service, read, wire, calls, log, methods, setActor: (value: AuthenticatedPrincipal) => { actor = value; }, deny: () => { authorized = false; },
    async close() { mail.owner?.dispose(); await service.close(); log[Symbol.dispose](); } };
}

test('canonical IMAP read issues an authenticated opaque reference and only a recorded boolean reaches the browser', async () => {
  const f = fixture({ plans: [{ subject: 'RE: Synthetic lunch' }] });
  try {
    const message = await f.read();
    expect(message.replySubjectRef).toBeString();
    expect(f.gateway.getReplySubjectSource?.({ ...message })).toBeUndefined();
    const result = await f.wire(request(message.replySubjectRef!));
    expect(result.status, result.body).toBe(200);
    expect(JSON.parse(result.body)).toMatchObject({ status: 'settled', value: { alreadyReply: true }, outcome: 'act', evidence: [{ decisionId: expect.any(String) }] });
    expect(f.calls).toEqual([{ subject: 'RE: Synthetic lunch' }]);
    expect(f.mail.connections()).toBe(1);
    const records = f.log.query(); expect(records).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain('Synthetic lunch');
    expect(JSON.stringify(records)).not.toContain('owner@example.invalid');
    expect(JSON.stringify(records)).not.toContain('Synthetic body');
  } finally { await f.close(); }
});

test.each(['forged-ref', 'principal', 'kind', 'read-scope', 'judgment-scope', 'purpose', 'retired', 'registration'] as const)('%s cannot transmit or record a subject', async kind => {
  const f = fixture();
  try {
    const message = await f.read(); let ref = message.replySubjectRef!;
    if (kind === 'forged-ref') ref = crypto.randomUUID();
    if (kind === 'principal') f.setActor({ ...owner, principalId: 'other' });
    if (kind === 'kind') f.setActor({ ...owner, principalKind: 'token' });
    if (kind === 'read-scope') f.setActor({ ...owner, scopes: ['write:judgment'] });
    if (kind === 'judgment-scope') f.setActor({ ...owner, scopes: ['read:email'] });
    if (kind === 'purpose') f.deny();
    if (kind === 'retired') f.mail.owner?.invalidate();
    if (kind === 'registration') f.methods.register({ ...f.methods.get('email.inbox.read')!, scopes: ['read:email', 'read:other'] }, undefined, { replace: true });
    const result = await f.wire(request(ref)); expect(result.status).not.toBe(200);
    expect(f.calls).toEqual([]); expect(f.log.query()).toEqual([]);
  } finally { await f.close(); }
});


test('the owned reference deadline retires a subject without another read', async () => {
  const callbacks: (() => void)[] = [];
  const original = globalThis.setTimeout;
  const timers = spyOn(globalThis, 'setTimeout').mockImplementation(new Proxy(original, { apply(target, receiver: unknown, args: unknown[]) {
    if (typeof args[0] === 'function' && Number(args[1]) > 290_000) {
      const callback = args[0]; callbacks.push(() => Reflect.apply(callback, undefined, args.slice(2)));
    }
    return Reflect.apply(target, receiver, args);
  } }));
  const f = fixture();
  try {
    const message = await f.read(); expect(callbacks).toHaveLength(1);
    callbacks[0]!();
    expect((await f.wire(request(message.replySubjectRef!))).status).toBe(422);
    expect(f.calls).toEqual([]); expect(f.log.query()).toEqual([]);
  } finally { timers.mockRestore(); await f.close(); }
});

test.each(['password=synthetic-value', 'x'.repeat(4097), `${'x'.repeat(4097)} password=synthetic-value`])('complete protected or oversized subject is held before issuance', async subject => {
  const f = fixture({ plans: [{ subject }] });
  try {
    const message = await f.read();
    if (subject.length <= 4096) expect(message.subject).toBe(subject);
    expect(message.replySubjectRef).toBeUndefined();
    expect(f.calls).toEqual([]); expect(f.log.query()).toEqual([]);
  } finally { await f.close(); }
});

test('old backends, spoofed wire references, missing fresh auth and absent UIDVALIDITY preserve ordinary reading without a reference', async () => {
  const legacy = { uid: 12, from: 'synthetic@example.invalid', subject: 'Synthetic', date: '', messageId: '<synthetic>', bodyText: 'Synthetic body', replySubjectRef: 'forged' };
  const f = fixture({ plans: [{ uidValidity: null }, {}] });
  try {
    expect((await f.read()).replySubjectRef).toBeUndefined();
    expect((await f.read(12, false)).replySubjectRef).toBeUndefined();
    const { getReplySubjectSource: _source, ...legacyGateway } = f.gateway;
    const handler = createEmailInboxReadHandler({ ...legacyGateway, readMessage: async () => legacy }, f.service);
    expect(await handler({ query: { uid: 12 }, context: owner, isAuthorized: () => true })).toEqual({ ...legacy, replySubjectRef: undefined });
    expect(f.calls).toEqual([]);
  } finally { await f.close(); }
});

test.each(['reread', 'gone', 'mailbox-generation', 'account', 'shutdown', 'caller'] as const)('%s while judgment waits cannot overwrite with a stale reading or retain a response', async kind => {
  const entered = deferred<void>(); const finish = deferred<void>();
  const f = fixture({ plans: [{}, { ...(kind === 'gone' ? { gone: true } : {}), ...(kind === 'mailbox-generation' ? { uidValidity: 8 } : {}) }],
    beforeAnswer: async () => { entered.resolve(); await finish.promise; } });
  const abort = new AbortController(); let pending: Promise<unknown> | undefined;
  try {
    const message = await f.read(); pending = f.wire(request(message.replySubjectRef!), abort.signal);
    await entered.promise;
    if (kind === 'reread' || kind === 'gone' || kind === 'mailbox-generation') await f.mail.service.readMessage(kind === 'mailbox-generation' ? 13 : 12);
    if (kind === 'account') f.mail.owner?.invalidate();
    if (kind === 'shutdown') f.mail.owner?.dispose();
    if (kind === 'caller') abort.abort();
    finish.resolve();
    expect(await pending).not.toMatchObject({ status: 200 });
    expect(f.log.query()).toEqual([]);
  } finally { finish.resolve(); await pending; await f.close(); }
});

test('shared retry survives provider outages and source invalidation stops the next retry without a record', async () => {
  for (const revoke of [false, true]) {
    let attempts = 0; let retire = () => {};
    const transport = createSystemOnePort({ endpoint: { kind: 'local', baseURL: 'http://127.0.0.1:1', apiKey: 'synthetic' }, model: 'jev-1.13.0', timeoutMs: 1000,
      retry: { backoffInitialMs: 1, backoffMaxMs: 1, backoffJitter: 0 }, fetch: async () => {
        attempts++; if (revoke) retire();
        return attempts < 4 ? new Response('', { status: 503 }) : Response.json({ model: 'jev-1.13.0', answers: { already_reply: { type: 'noul', noul: 0.01 } }, usage: { input_tokens: 1, output_tokens: 1 } });
      } });
    const f = fixture({ transport }); retire = () => f.mail.owner?.invalidate();
    try {
      const message = await f.read(); const result = await f.wire(request(message.replySubjectRef!));
      expect(result.status).toBe(revoke ? 422 : 200);
      expect(attempts).toBe(revoke ? 1 : 4);
      expect(f.log.query()).toHaveLength(revoke ? 0 : 1);
    } finally { await f.close(); }
  }
});

test('capture genuine synthetic mail-read references and browser judgment wires for UI replay', async () => {
  const captures: unknown[] = [];
  for (const [subject, probability] of [['Nightly build finished', 0.01], ['RE: Synthetic lunch', 0.99], ['Re[2]: Synthetic lunch', 0.99], ['AW: Synthetic lunch', 0.99], ['SV: Synthetic lunch', 0.99], ['Synthetic uncertain', 0.5]] as const) {
    const f = fixture({ plans: [{ subject }], probability });
    try {
      const message = await f.read(1002); const requestBody = request(message.replySubjectRef!);
      const result = await f.wire(requestBody);
      expect(result.status, result.body).toBe(200);
      expect(f.calls).toEqual([{ subject }]);
      captures.push({ message, requestBody, ...result });
    } finally { await f.close(); }
  }
  if (process.env.GOODVIBES_TEST_MAIL_JUDGMENT_FIXTURE_DIR) {
    const file = resolve(process.env.GOODVIBES_TEST_MAIL_JUDGMENT_FIXTURE_DIR, 'runtime.json');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ source: 'Canonical in-memory IMAP read, authenticated browser judgment handler, shared service and recorded synthetic answers. No live calibration.', captures }, null, 2) + '\n');
  }
});


test('source retirement during asynchronous key acquisition cannot dispatch or record the subject', async () => {
  const entered = deferred<void>(); const key = deferred<string>();
  let dispatches = 0;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(new Proxy(globalThis.fetch, { apply() { dispatches++; return Promise.reject(new Error('Unexpected synthetic dispatch')); } }));
  const transport = createSettingsJudgmentPort({ config: { get: name => ({ 'judgment.endpoint': 'http://127.0.0.1:1', 'judgment.model': 'jev-1.13.0', 'judgment.keySource': 'secret', 'judgment.timeoutMs': 1000 })[name] },
    secrets: { get: async () => { entered.resolve(); return key.promise; } }, env: {} });
  const f = fixture({ transport }); let pending: Promise<unknown> | undefined;
  try {
    const message = await f.read(); pending = f.wire(request(message.replySubjectRef!));
    await entered.promise; f.mail.owner?.invalidate(); key.resolve('synthetic-key');
    expect(await pending).not.toMatchObject({ status: 200 });
    expect(dispatches).toBe(0); expect(f.log.query()).toEqual([]);
  } finally { key.resolve('synthetic-key'); await pending; await f.close(); fetch.mockRestore(); }
});
