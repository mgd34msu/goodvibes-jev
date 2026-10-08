import { describe, expect, test } from 'bun:test';
import type { BrowserJudgmentMailSubjectSource } from '@goodvibes-jev/engine/daemon-sdk';
import { DaemonControlPlaneHelper, type DaemonControlPlaneContext } from '../sdk/src/platform/daemon/control-plane.js';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.js';
import { registerDaemonEmailVerbs } from '../sdk/src/platform/control-plane/routes/email-composition.js';
import { deferred, mailFixture, tick, type ReadPlan } from './_helpers/mail-subject-source.js';

function host(plans: ReadPlan[]) {
  const mail = mailFixture({ plans });
  const catalog = new GatewayMethodCatalog();
  const issued: BrowserJudgmentMailSubjectSource[] = [];
  registerDaemonEmailVerbs(catalog, {
    emailServiceDeps: mail.deps,
    browserJudgment: {
      async execute() { throw new Error('No judgment or provider work in authorization tests.'); },
      issueMailSubjectReference(source) {
        source.snapshot.assertCurrent(); issued.push(source);
        return `synthetic-source-${issued.length}`;
      },
    },
  });
  let mode: 'session' | 'shared' | 'none' = 'session';
  let username = 'fixture-owner';
  let roles: readonly string[] = ['admin'];
  const token = 'synthetic-transport-token';
  const helper = new DaemonControlPlaneHelper({
    gatewayMethods: catalog,
    authToken: () => mode === 'shared' ? token : null,
    userAuth: {
      validateSession: (candidate: string) => mode === 'session' && candidate === token ? { username } : null,
      getUser: () => ({ username, roles }),
    },
  } as unknown as DaemonControlPlaneContext);
  const read = (uid: number, options?: { scopes?: readonly string[]; signal?: AbortSignal }) => {
    const principal = helper.describeAuthenticatedPrincipal(token);
    if (!principal) throw new Error('Synthetic initial authentication unavailable.');
    return helper.invokeGatewayMethodCall({
      authToken: token, methodId: 'email.inbox.read', query: { uid: String(uid) },
      context: { ...principal, ...(options?.scopes ? { scopes: options.scopes } : {}) },
      signal: options?.signal,
    });
  };
  return { mail, helper, read, issued, token,
    setRoles(value: readonly string[]) { roles = value; },
    setMode(value: typeof mode) { mode = value; },
    setUsername(value: string) { username = value; },
  };
}

function message(response: { status: number; body: unknown }): Record<string, unknown> {
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ subject: 'Original subject', bodyText: 'Synthetic body' });
  return response.body as Record<string, unknown>;
}

describe('mail subject issuance through real daemon fresh-auth dispatch', () => {
  test('current read + judgment scopes issue from canonical IMAP while read-only calls remain ordinary reads', async () => {
    const state = host([{}, {}]);
    expect(message(await state.read(42)).replySubjectRef).toBe('synthetic-source-1');
    expect(state.issued[0]?.snapshot.subject).toBe('Original subject');
    expect(state.issued[0]?.principal.principalId).toBe('fixture-owner');
    expect(message(await state.read(43, { scopes: ['read:email'] })).replySubjectRef).toBeUndefined();
    expect(state.issued).toHaveLength(1);
    state.mail.owner!.dispose();
  });

  test('role/scope revocation during a canonical read suppresses issuance; newer read still succeeds', async () => {
    const gate = deferred<void>();
    const state = host([{ headerGate: gate.promise }, {}, {}]);
    const pending = state.read(42);
    await tick(); await tick();
    state.setRoles([]); gate.resolve();
    expect(message(await pending).replySubjectRef).toBeUndefined();
    expect(state.issued).toHaveLength(0);
    expect(message(await state.read(43)).replySubjectRef).toBeUndefined();
    state.setRoles(['admin']);
    expect(message(await state.read(44)).replySubjectRef).toBe('synthetic-source-1');
    state.mail.owner!.dispose();
  });

  test('same textual principal ID changing from token to user during read cannot issue', async () => {
    const gate = deferred<void>();
    const state = host([{ headerGate: gate.promise }, {}]);
    state.setMode('shared'); state.setUsername('shared-token');
    const pending = state.read(42);
    await tick(); await tick();
    state.setMode('session'); gate.resolve();
    expect(message(await pending).replySubjectRef).toBeUndefined();
    expect(state.issued).toHaveLength(0);
    expect(message(await state.read(43)).replySubjectRef).toBe('synthetic-source-1');
    expect(state.issued[0]?.principal.principalKind).toBe('user');
    state.mail.owner!.dispose();
  });

  test.each(['revoked', 'different-user', 'cancelled'] as const)('%s while reading suppresses references without changing completed mail', async change => {
    const gate = deferred<void>();
    const state = host([{ headerGate: gate.promise }]);
    const abort = new AbortController();
    const pending = state.read(42, { signal: abort.signal });
    await tick(); await tick();
    if (change === 'revoked') state.setMode('none');
    if (change === 'different-user') state.setUsername('other-fixture-owner');
    if (change === 'cancelled') abort.abort();
    gate.resolve();
    expect(message(await pending).replySubjectRef).toBeUndefined();
    expect(state.issued).toHaveLength(0);
    state.mail.owner!.dispose();
  });

  test('already revoked authentication is refused before any credential or IMAP read', async () => {
    const state = host([]);
    const cached = state.helper.describeAuthenticatedPrincipal(state.token)!;
    state.setMode('none');
    const response = await state.helper.invokeGatewayMethodCall({
      authToken: state.token, methodId: 'email.inbox.read', query: { uid: '42' }, context: cached,
    });
    expect(response.status).toBe(401);
    expect(state.mail.connections()).toBe(0);
    expect(state.issued).toHaveLength(0);
    state.mail.owner!.dispose();
  });
});
