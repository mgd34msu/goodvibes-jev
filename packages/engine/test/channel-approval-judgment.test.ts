/** The actual channel ingress path, with explicit Jev answers and a real broker/log. */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { actionOf, readingsOf } from '@goodvibes-jev/judgment';
import { ApprovalBroker } from '../sdk/src/platform/control-plane/approval-broker.ts';
import { ChannelPolicyManager } from '../sdk/src/platform/channels/policy-manager.ts';
import { DaemonSurfaceActionHelper } from '../sdk/src/platform/daemon/surface-actions.ts';
import { tryResolveApprovalReplyFromChannel } from '../sdk/src/platform/daemon/approval-reply.ts';
import { handleSlackSurfacePayload } from '../sdk/src/platform/adapters/slack/index.ts';
import type { SurfaceAdapterContext } from '../sdk/src/platform/adapters/index.ts';
import type { ChannelPolicyDecision } from '../sdk/src/platform/channels/index.ts';
import { REPLY_BATTERY, TARGET_BATTERY, useApprovalReadings } from './helpers/approval-readings.ts';

const readings = useApprovalReadings();
const OWNER = 'U-OWNER';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'gv-approval-judgment-'));
  dirs.push(dir);
  const policy = new ChannelPolicyManager({ storePath: join(dir, 'policy.json') });
  await policy.evaluateIngress({ surface: 'slack', userId: OWNER, text: 'hello', conversationKind: 'direct' });
  const broker = new ApprovalBroker({ storePath: join(dir, 'approvals.json') });
  const boundSurfaces = new Map<string, string>();
  const notices: string[] = [];
  const routeBindings = { resolve: () => undefined, getBinding: (id: string) => {
    const surfaceKind = boundSurfaces.get(id);
    return surfaceKind ? { id, surfaceKind } : undefined;
  } };
  const helper = new DaemonSurfaceActionHelper({ channelPolicy: policy, approvalBroker: broker, routeBindings,
    deliverSurfaceNotice: async (_binding: unknown, text: string) => { notices.push(text); return { delivered: true }; } } as unknown as ConstructorParameters<typeof DaemonSurfaceActionHelper>[0]);
  const submitted: string[] = [];
  let bindingsCreated = 0;
  const context = {
    authorizeSurfaceIngress: helper.authorizeSurfaceIngress.bind(helper),
    routeBindings: { upsertBinding: async () => { bindingsCreated++; return { id: 'slack-route', surfaceId: 'slack' }; } },
    sessionBroker: { submitMessage: async (input: { body: string }) => {
      submitted.push(input.body);
      return { mode: 'continued-live', session: { id: 'chat' }, activeAgentId: 'agent' };
    } },
    parseSurfaceControlCommand: () => null,
  } as unknown as SurfaceAdapterContext;
  return {
    broker, helper, policy, submitted, notices,
    moveRoute: (id: string, surface: string) => boundSurfaces.set(id, surface),
    get bindingsCreated() { return bindingsCreated; },
    async ask(tool = 'deploy', summary = 'Deploy production', surface: string | undefined = 'slack', args: Record<string, unknown> = { destination: summary }) {
      const callId = `call-${broker.listApprovals().length}`;
      const routeId = `route-${callId}`;
      if (surface) boundSurfaces.set(routeId, surface);
      return broker.raiseApproval({ routeId, request: {
        callId, tool, args, category: 'execute',
        analysis: { classification: 'execute', riskLevel: 'high', summary, reasons: [] },
      } });
    },
    async send(text: string, userId = OWNER) {
      const response = await handleSlackSurfacePayload({
        command: '/goodvibes', text, user_id: userId, user_name: 'owner',
        channel_id: 'C1', channel_name: 'general', team_id: 'T1', response_url: '',
      }, context);
      await new Promise<void>((resolve) => setImmediate(resolve));
      return response;
    },
    ingress: (text: string, userId: string | undefined = OWNER) => helper.authorizeSurfaceIngress({
      surface: 'slack', userId, text, conversationKind: 'direct',
    }),
  };
}

function assertRecorded(approvalId: string, choice: string, selected = false) {
  const expected = selected ? [REPLY_BATTERY, TARGET_BATTERY] : [REPLY_BATTERY];
  for (const battery of expected) {
    const entries = readings.log.query({ battery });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBeTruthy();
    expect(entries[0]!.status).toBe('answered');
    expect(readingsOf(entries[0]!)).toBeDefined();
    expect(actionOf(entries[0]!)).toBe(`resolve approval ${approvalId}: ${choice}`);
  }
}

describe('channel replies use settled meaning instead of leading words', () => {
  test.each([
    ['negated assent', 'Yes? No, do not deploy it.', 'reject', false],
    ['negative word with affirmative meaning', 'No problem, go ahead.', 'approve', true],
    ['exception', 'Approve, except do not touch production.', 'amend', false],
    ['conditional amendment', 'Yes, but use staging instead.', 'amend', false],
    ['approval with follow-on guidance', 'Deploy it exactly as proposed. Send the logs afterward.', 'approve', true],
  ] as const)('%s resolves with the whole owner reply preserved', async (_name, text, choice, approved) => {
    const h = await harness();
    const ask = await h.ask();
    readings.set({ reply: choice });
    const response = await h.send(text);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('approval-reply-consumed');
    expect(h.submitted).toEqual([]);
    expect(h.bindingsCreated).toBe(0);
    const decision = await ask.decision;
    expect(decision).toEqual({ approved, reason: text });
    const record = h.broker.getApproval(ask.approval.id)!;
    expect(record.status).toBe(approved ? 'approved' : 'denied');
    expect(record.decision).toMatchObject({ approved, disposition: approved ? 'approved' : choice === 'amend' ? 'amended' : 'denied' });
    expect(record.audit.at(-1)?.note).toBe(text);
    expect(record.audit.at(-1)?.actorSurface).toBe('slack');
    expect(record.resolvedBy).toBe(OWNER);
    assertRecorded(record.id, choice);
    const asked = readings.requests[0]!;
    expect(asked.context?.battery).toBe(REPLY_BATTERY);
    expect(asked.state).toEqual({ proposal: {
      approvalId: record.id, tool: 'deploy', summary: 'Deploy production', arguments: { destination: 'Deploy production' },
    }, reply: text });
  });

  test('a long reply is judged in full, including a final retraction', async () => {
    const h = await harness();
    const ask = await h.ask();
    const text = `Yes, this looks reasonable. ${'I reviewed the rollout plan. '.repeat(100)}Actually, no. Do not deploy.`;
    readings.set({ reply: 'reject' });
    await h.send(text);
    expect((await ask.decision).approved).toBe(false);
    expect((readings.requests[0]!.state as { reply: string }).reply).toBe(text);
    expect(h.broker.getApproval(ask.approval.id)?.decision?.reason).toBe(text);
    assertRecorded(ask.approval.id, 'reject');
  });

  test('an unrelated new request flows through the Slack handler as chat', async () => {
    const h = await harness();
    const ask = await h.ask();
    const text = 'Yes, can you check the weather tomorrow? I am answering the lunch question.';
    readings.set({ reply: 'unclear' });
    expect((await h.send(text)).status).toBe(200);
    expect(h.submitted).toEqual([text]);
    expect(h.broker.getApproval(ask.approval.id)?.status).toBe('pending');
    expect(h.broker.getApproval(ask.approval.id)?.decision).toBeUndefined();
    expect(actionOf(readings.log.query({ battery: REPLY_BATTERY })[0]!)).toContain('no resolution');
  });

  test.each([0.8, 0.65])('approval confidence %s leaves the ask unresolved', async (confidence) => {
    const h = await harness();
    const ask = await h.ask();
    readings.set({ reply: 'approve', confidence });
    expect((await h.ingress('approve')).allowed).toBe(true);
    expect(h.broker.getApproval(ask.approval.id)?.status).toBe('pending');
  });
});

describe('the reply must identify its target before its meaning is read', () => {
  test('two same-surface asks and a bare yes resolve neither', async () => {
    const h = await harness();
    await h.ask();
    await h.ask('export_data', 'Export customer data');
    readings.set({ reply: 'approve' });
    expect((await h.ingress('yes')).allowed).toBe(true);
    expect(h.broker.listApprovals().every((record) => record.status === 'pending')).toBe(true);
    expect(readings.requests.map((request) => request.context?.battery)).toEqual([TARGET_BATTERY]);
  });

  test('an explicit reference to the older ask never resolves the newer ask', async () => {
    const h = await harness();
    const older = await h.ask();
    const newer = await h.ask('export_data', 'Export customer data');
    // Move the newer ask to the head of the broker's updated-at ordering.
    await h.broker.claimApproval(newer.approval.id, 'reviewer');
    readings.set({ target: older.approval.id, reply: 'approve' });
    const text = `Approve ${older.approval.id}, the deployment. Leave the export waiting.`;
    await h.send(text);
    expect((await older.decision).approved).toBe(true);
    expect(h.broker.getApproval(newer.approval.id)?.status).toBe('claimed');
    expect(readings.requests.map((request) => request.context?.battery)).toEqual([TARGET_BATTERY, REPLY_BATTERY]);
    expect((readings.requests[1]!.state as { proposal: { approvalId: string } }).proposal.approvalId).toBe(older.approval.id);
    assertRecorded(older.approval.id, 'approve', true);
  });

  test.each(['uncertain-pick', 'uncertain-fit', 'conflicting-fits'] as const)('%s cannot select an ask', async (scenario) => {
    const h = await harness();
    const a = await h.ask();
    const b = await h.ask('export_data', 'Export customer data');
    readings.set({ target: a.approval.id, reply: 'approve',
      ...(scenario === 'uncertain-pick' ? { targetConfidence: 0.8 } : {}),
      ...(scenario === 'uncertain-fit' ? { fits: { [a.approval.id]: 0.8 } } : {}),
      ...(scenario === 'conflicting-fits' ? { fits: { [b.approval.id]: 0.97 } } : {}),
    });
    expect((await h.ingress('approve the deployment')).allowed).toBe(true);
    expect(h.broker.listApprovals().every((record) => record.status === 'pending')).toBe(true);
    expect(readings.requests).toHaveLength(1);
  });

  test('one surface-bound ask is preferred over asks on another surface', async () => {
    const h = await harness();
    const local = await h.ask();
    const other = await h.ask('export_data', 'Export customer data', 'telegram');
    readings.set({ reply: 'approve' });
    await h.ingress('yes');
    expect((await local.decision).approved).toBe(true);
    expect(h.broker.getApproval(other.approval.id)?.status).toBe('pending');
    expect(readings.requests).toHaveLength(1);
  });

  test('a single unbound global ask remains answerable', async () => {
    const h = await harness();
    const ask = await h.ask('deploy', 'Deploy production', '');
    readings.set({ reply: 'reject' });
    await h.ingress('no');
    expect((await ask.decision).approved).toBe(false);
  });

  test('the full pending set is offered rather than a newest-first slice', async () => {
    const h = await harness();
    for (let i = 0; i < 101; i++) await h.ask(`tool-${i}`, `Pending operation ${i}`);
    expect((await h.ingress('yes')).allowed).toBe(true);
    expect((readings.requests[0]!.state as { candidates: unknown[] }).candidates).toHaveLength(101);
    expect(h.broker.listApprovals(200).every((record) => record.status === 'pending')).toBe(true);
  });

  test('too many selector options leave all asks pending without truncation', async () => {
    const h = await harness();
    for (let i = 0; i < 255; i++) await h.ask(`tool-${i}`, `Pending operation ${i}`);
    expect((await h.ingress('yes')).allowed).toBe(true);
    expect(h.broker.listApprovals(300)).toHaveLength(255);
    expect(h.broker.listApprovals(300).every((record) => record.status === 'pending')).toBe(true);
    expect(readings.requests).toHaveLength(0);
  });

  test('several asks with none on this surface are never offered to judgment', async () => {
    const h = await harness();
    await h.ask('deploy', 'Deploy production', 'telegram');
    await h.ask('export_data', 'Export customer data', 'telegram');
    expect((await h.ingress('approve')).allowed).toBe(true);
    expect(readings.requests).toHaveLength(0);
  });
});

describe('authorization and failures are fail closed', () => {
  test('proposal serialization uses inspected descriptors instead of proxy property reads', async () => {
    const h = await harness();
    const ask = await h.ask();
    let gets = 0;
    const marker = 'password=SYNTHETIC_APPROVAL_PROXY_ONLY';
    const args = new Proxy({ destination: 'ordinary destination' }, {
      get: (target, key, receiver): unknown => {
        gets++;
        return key === 'destination' ? marker : Reflect.get(target, key, receiver);
      },
    });
    const record = { ...ask.approval, request: { ...ask.approval.request, args } };
    readings.set({ reply: 'unclear' });
    const decision = { allowed: true, policy: { allowlistUserIds: [OWNER] } } as unknown as ChannelPolicyDecision;
    expect(await tryResolveApprovalReplyFromChannel({ surface: 'slack', userId: OWNER, text: 'which deployment?' }, decision, {
      approvalBroker: { listApprovals: () => [record], resolveApproval: h.broker.resolveApproval.bind(h.broker) },
      routeBindings: { getBinding: () => undefined },
    })).toBe(false);
    expect(readings.requests.filter((request) => JSON.stringify(request.state).includes(marker))).toHaveLength(0);
    expect(gets).toBe(0);
    expect(readings.requests).toHaveLength(1);
    expect(JSON.stringify(readings.requests)).not.toContain(marker);
    expect(JSON.stringify(readings.requests)).toContain('ordinary destination');
  });

  test('an unknown sender cannot answer through the Slack adapter', async () => {
    const h = await harness();
    const ask = await h.ask();
    readings.set({ reply: 'approve' });
    const response = await h.send('approve', 'U-STRANGER');
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('user-not-allowlisted');
    expect(h.broker.getApproval(ask.approval.id)?.status).toBe('pending');
    expect(readings.requests).toHaveLength(0);
    expect(h.submitted).toEqual([]);
  });

  test('a denied policy and a missing sender cannot bypass the structural checks', async () => {
    const h = await harness();
    const ask = await h.ask();
    const decision = { allowed: false, policy: { allowlistUserIds: [OWNER] } } as unknown as ChannelPolicyDecision;
    const deps = { approvalBroker: h.broker, routeBindings: { getBinding: () => undefined } };
    expect(await tryResolveApprovalReplyFromChannel({ surface: 'slack', userId: OWNER, text: 'yes' }, decision, deps)).toBe(false);
    expect(await tryResolveApprovalReplyFromChannel({ surface: 'slack', text: 'yes' }, { ...decision, allowed: true }, deps)).toBe(false);
    expect(h.broker.getApproval(ask.approval.id)?.status).toBe('pending');
    expect(readings.requests).toHaveLength(0);
  });

  test('matched group owners take precedence over surface owners', async () => {
    const h = await harness();
    await h.ask();
    const decision = { allowed: true, policy: { allowlistUserIds: [OWNER] }, matchedGroupPolicy: { allowlistUserIds: ['GROUP-OWNER'] } } as unknown as ChannelPolicyDecision;
    expect(await tryResolveApprovalReplyFromChannel({ surface: 'slack', userId: OWNER, text: 'yes' }, decision,
      { approvalBroker: h.broker, routeBindings: { getBinding: () => undefined } })).toBe(false);
    expect(readings.requests).toHaveLength(0);
  });

  test.each(['reply', 'target'] as const)('unavailable %s judgment leaves every ask pending and records failure', async (unavailable) => {
    const h = await harness();
    await h.ask();
    if (unavailable === 'target') await h.ask('export_data', 'Export customer data');
    readings.set({ unavailable });
    await expect(h.send('approve')).rejects.toMatchObject({ kind: 'unavailable', message: 'the judgment provider could not answer' });
    expect(h.broker.listApprovals().every((record) => record.status === 'pending')).toBe(true);
    const [failure] = readings.log.query({ battery: unavailable === 'reply' ? REPLY_BATTERY : TARGET_BATTERY });
    expect(failure).toMatchObject({ status: 'failed', error: { kind: 'unavailable', message: 'the judgment provider could not answer' } });
    expect(JSON.stringify(failure)).not.toContain('judgment unavailable');
    expect(h.submitted).toEqual([]);
  });

  test('a settled target does not resolve when the subsequent reply reading is unavailable', async () => {
    const h = await harness();
    const ask = await h.ask();
    await h.ask('export_data', 'Export customer data');
    readings.set({ target: ask.approval.id, unavailable: 'reply' });
    await expect(h.send('approve the deployment')).rejects.toMatchObject({ kind: 'unavailable', message: 'the judgment provider could not answer' });
    expect(h.broker.listApprovals().every((record) => record.status === 'pending')).toBe(true);
    const [failure] = readings.log.query({ battery: REPLY_BATTERY });
    expect(failure).toMatchObject({ status: 'failed', error: { kind: 'unavailable', message: 'the judgment provider could not answer' } });
    expect(JSON.stringify(failure)).not.toContain('judgment unavailable');
    expect(actionOf(readings.log.query({ battery: TARGET_BATTERY })[0]!)).toContain('awaiting reply reading');
  });

  test('a missing installed port cannot approve even a plain yes', async () => {
    const h = await harness();
    const ask = await h.ask();
    const previous = installJudgmentPort(undefined);
    try { await expect(h.ingress('yes')).rejects.toThrow('No judgment port is installed'); }
    finally { installJudgmentPort(previous); }
    expect(h.broker.getApproval(ask.approval.id)?.status).toBe('pending');
  });

  test('a recording failure happens before broker resolution', async () => {
    const h = await harness();
    const ask = await h.ask();
    readings.set({ reply: 'approve' });
    const previous = installJudgmentPort(undefined)!;
    installJudgmentPort({ ...previous, recorder: {
      recordReadings: previous.recorder!.recordReadings,
      recordAction: () => { throw new Error('decision log unavailable'); },
    } });
    try { await expect(h.ingress('yes')).rejects.toThrow('decision log unavailable'); }
    finally { installJudgmentPort(previous); }
    expect(h.broker.getApproval(ask.approval.id)?.status).toBe('pending');
  });

  test.each(['arguments', 'call-id', 'route'] as const)('a changed %s during judgment leaves the ask unresolved', async (change) => {
    const h = await harness();
    const ask = await h.ask();
    readings.set({ reply: 'approve', beforeReply: async () => {
      if (change === 'arguments') ask.approval.request.args['destination'] = 'A different deployment';
      if (change === 'call-id') ask.approval.request.callId = 'another-tool-call';
      if (change === 'route') h.moveRoute(ask.approval.routeId!, 'telegram');
    } });
    expect((await h.ingress('yes')).allowed).toBe(true);
    expect(h.broker.getApproval(ask.approval.id)?.status).toBe('pending');
    expect(actionOf(readings.log.query({ battery: REPLY_BATTERY })[0]!)).toContain('proposal or route changed');
  });

  test.each(['approve', 'reject', 'amend'] as const)('a cancelled ask cannot receive a late %s disposition', async (choice) => {
    const h = await harness();
    const ask = await h.ask();
    readings.set({ reply: choice, beforeReply: async () => {
      await h.broker.cancelApproval(ask.approval.id, 'other-owner', 'web', 'Stop waiting for this ask.');
    } });
    expect((await h.ingress('My answer to the original ask.')).allowed).toBe(true);
    expect(await ask.decision).toEqual({ approved: false, remember: false });
    const current = h.broker.getApproval(ask.approval.id)!;
    expect(current.status).toBe('cancelled');
    expect(current.decision).toMatchObject({ approved: false, disposition: 'cancelled' });
    expect(current.resolvedBy).toBe('other-owner');
    expect(actionOf(readings.log.query({ battery: REPLY_BATTERY })[0]!)).toContain('no longer pending');
  });

  test('an ask resolved while judgment runs is not overwritten or consumed', async () => {
    const h = await harness();
    const ask = await h.ask();
    readings.set({ reply: 'approve', beforeReply: async () => {
      await h.broker.resolveApproval(ask.approval.id, { approved: false, actor: 'other-owner' });
    } });
    expect((await h.ingress('yes')).allowed).toBe(true);
    expect((await ask.decision).approved).toBe(false);
    expect(h.broker.getApproval(ask.approval.id)?.resolvedBy).toBe('other-owner');
    expect(actionOf(readings.log.query({ battery: REPLY_BATTERY })[0]!)).toContain('no longer pending');
  });
});


describe('approval judgment never receives protected input', () => {
  const SECRET = 'SYNTHETIC_APPROVAL_SECRET_DO_NOT_TRANSMIT';

  test.each([
    ['credential in pending arguments', 'deploy', 'Deploy production', { apiKey: SECRET }],
    ['credential in pending summary', 'deploy', `Deploy with password=${SECRET}`, {}],
    ['custom credential-setting operation', 'credentials.set', 'Set a custom credential', { key: 'custom.integration', value: SECRET }],
  ] as const)('%s is refused before the reply request', async (_name, tool, summary, args) => {
    const h = await harness();
    const ask = await h.ask(tool, summary, 'slack', args);
    readings.set({ reply: 'approve' });
    await expect(h.send('yes')).rejects.toThrow('Refused before judgment');
    expect(h.broker.getApproval(ask.approval.id)?.status).toBe('pending');
    expect(readings.requests).toHaveLength(0);
    expect(readings.log.query()).toHaveLength(0);
  });

  test('one protected candidate prevents a selector request containing any candidate', async () => {
    const h = await harness();
    const safe = await h.ask();
    await h.ask('fetch', 'Fetch service status', 'slack', { headers: { Authorization: `Bearer ${SECRET}` } });
    readings.set({ target: safe.approval.id, reply: 'approve' });
    await expect(h.send('approve the deployment')).rejects.toThrow('Refused before judgment');
    expect(h.broker.listApprovals().every((record) => record.status === 'pending')).toBe(true);
    expect(readings.requests).toHaveLength(0);
    expect(readings.log.query()).toHaveLength(0);
  });

  test('a protected owner reply is rejected before selecting or reading an ask', async () => {
    const h = await harness();
    await h.ask();
    await h.ask('export_data', 'Export customer data');
    const beforeAudit = h.policy.listAudit();
    const response = await h.send(`Approve the deployment in room 4021. Use password=${SECRET}`);
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain('judgment-input-refused:credential-material');
    expect(body).not.toContain(SECRET);
    expect(h.policy.listAudit()).toEqual(beforeAudit);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('secure credential setup');
    expect(h.notices[0]).not.toContain(SECRET);
    expect(h.submitted).toEqual([]);
    expect(h.broker.listApprovals().every((record) => record.status === 'pending')).toBe(true);
    expect(readings.requests).toHaveLength(0);
    expect(readings.log.query()).toHaveLength(0);
  });

  test('PAN with expiry and credentials keeps the existing card notice without any model request', async () => {
    const h = await harness();
    const ask = await h.ask();
    const beforeAudit = h.policy.listAudit();
    const text = `No, use card 4111111111111111 07/29 with password=${SECRET}`;
    const response = await h.send(text);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('card-shapes-refused:pan');
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toContain('Approving or vetoing');
    expect(h.notices[0]).not.toContain(SECRET);
    expect(h.notices[0]).not.toContain('4111');
    expect(h.policy.listAudit()).toEqual(beforeAudit);
    expect(h.broker.getApproval(ask.approval.id)?.status).toBe('pending');
    expect(readings.requests).toHaveLength(0);
    expect(readings.log.query()).toHaveLength(0);
  });

  test('protected input is refused even without a judgment port installed', async () => {
    const h = await harness();
    await h.ask('deploy', 'Deploy production', 'slack', { password: SECRET });
    const previous = installJudgmentPort(undefined);
    try { await expect(h.ingress('yes')).rejects.toThrow('Refused before judgment'); }
    finally { installJudgmentPort(previous); }
    expect(readings.requests).toHaveLength(0);
  });

  test('stored references stay readable without modifying execution arguments', async () => {
    const h = await harness();
    const args = { apiKey: 'goodvibes://secrets/goodvibes/OPENAI_API_KEY' };
    const ask = await h.ask('deploy', 'Deploy production', 'slack', args);
    readings.set({ reply: 'approve' });
    await h.send('yes');
    expect((await ask.decision).approved).toBe(true);
    expect(h.broker.getApproval(ask.approval.id)?.request.args).toEqual(args);
    expect((readings.requests[0]!.state as { proposal: { arguments: unknown } }).proposal.arguments).toEqual(args);
  });
});
