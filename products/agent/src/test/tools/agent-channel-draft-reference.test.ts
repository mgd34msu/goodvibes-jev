import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ConfigManager, DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { createShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { ChannelDeliveryRouter, type ChannelDeliveryRequest } from '@goodvibes-jev/engine/sdk/platform/channels';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { CommandRegistry, type CommandContext } from '../../input/command-registry.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { channelDraftFilePath, getDraft } from '../../agent/channel-draft.ts';
import { registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { connectedHostOperatorTokenPath } from '../../runtime/connected-host-auth.ts';
import { EXPLICIT_USER_REQUEST_HEADER } from '../../agent/daemon-operator-client.ts';
import { getSessionUntrustedContentLedger, resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { cleanupResearchScreeningFixtures, exactSensitiveSpans, researchScreeningFixture } from '../helpers/research-screening.ts';

const legacyId = 'draft-20261011000001-deadbeef';
const fetchOwner: { fetch: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> } = globalThis;
const args = { mode: 'channel_draft_send', draftId: legacyId };
let previous: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog;
let readings: ReturnType<typeof fakePort>;
const roots: string[] = [];
beforeEach(() => {
  resetSessionUntrustedContentLedgerForTests();
  readings = fakePort((name, question) => {
    if (question.type === 'noul') return noulAnswer(0.001);
    const label = name === 'disposition' ? 'act'
      : name === 'kind' ? Object.hasOwn(question.criteria, 'read') ? 'read' : 'other'
      : name === 'family' || name === 'capability' ? 'generic' : undefined;
    if (!label) throw new Error(`Unexpected native-reference fixture question ${name}`);
    return choiceAnswer(question, label, 0.999);
  });
  log = new SqliteDecisionLog(':memory:'); previous = installJudgmentPort(withDecisionLog(readings.port, log));
});
afterEach(() => {
  installJudgmentPort(previous); log[Symbol.dispose](); resetSessionUntrustedContentLedgerForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
afterAll(cleanupResearchScreeningFixtures);

function scene(screening = researchScreeningFixture(), extra: Record<string, unknown> = {}, connected = false) {
  const root = makeProjectTempDir('native-draft-reference'); roots.push(root);
  const paths = createShellPathService({ homeDirectory: root, workingDirectory: root });
  const path = channelDraftFilePath(paths);
  mkdirSync(dirname(path), { recursive: true });
  const draft = { version: 1, id: legacyId, createdAt: '2026-10-10T10:00:00.000Z', updatedAt: '2026-10-10T10:00:00.000Z',
    status: 'draft', message: 'Send the completed review to the owned fixture channel.', channel: 'slack:fixture', ...extra };
  writeFileSync(path, JSON.stringify({ version: 1, drafts: [draft] }));
  let mode: PermissionMode = 'prompt', beforeSend: (() => void) | undefined;
  const delivery: ChannelDeliveryRequest[] = [];
  const router = new ChannelDeliveryRouter({ strategies: [{ id: 'native-reference-fixture', supportsGuardedDelivery: true,
    canHandle: () => true, async deliver(request) {
      await Promise.resolve(); beforeSend?.(); request.signal?.throwIfAborted(); request.assertCurrent?.();
      delivery.push(request); return { responseId: 'native-reference-receipt' };
    } }] });
  const permissionReader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: { ...DEFAULT_CONFIG.permissions, mode }, autoApprove: false, directory: root }),
    getSnapshot: () => ({ permissions: { ...DEFAULT_CONFIG.permissions, mode } }),
    isAutoApproveEnabled: () => false, getWorkingDirectory: () => root,
  };
  const manager = new PermissionManager(undefined, permissionReader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager);
  const configManager = connected ? new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root,
    configDir: join(root, '.goodvibes', 'agent') }) : undefined;
  const context = { workspace: { shellPaths: paths }, platform: { config: {}, channelDeliveryRouter: router, ...(configManager ? { configManager } : {}) },
    session: { runtime: { sessionId: 'native-draft-reference-session' } }, clients: {}, extensions: { toolRegistry: registry }, ops: {} } as unknown as CommandContext;
  bindAgentResearchSourceOwner(registry, screening.owner);
  registerAgentHarnessTool(registry, new CommandRegistry(), context);
  let sequence = 0;
  const prepare = (input: Record<string, unknown>, signal?: AbortSignal) => registry.prepareCall(`native-draft-${++sequence}`, 'agent_harness', input, { signal });
  const run = async (input: Record<string, unknown> = args, signal?: AbortSignal) => {
    const call = await prepare(input, signal);
    const admission = await manager.admitAutonomous(call.callId, call.name, call.args, {
      sourceOf: () => ({ goal: 'Deliver the exact stored fixture review.', criteria: ['Use only the captured owned fixture draft and channel'] }),
      preparedCall: { registry, call }, signal, schemaRevision: call.schemaRevision,
    });
    expect(admission.result.approved).toBe(true);
    return registry.executePrepared(call, admission);
  };
  return { context, root, path, paths, screening, registry, manager, prepare, run, delivery,
    setMode(next: PermissionMode) { mode = next; }, beforeSend(callback: () => void) { beforeSend = callback; } };
}

test('actual registered harness delivers an exact legacy native reference without exposing its private ID', async () => {
  expect(() => snapshotJudgmentInput(args)).toThrow('payment card material');
  const f = scene();
  const result = await f.run();
  expect(result.success).toBe(true);
  const body = JSON.parse(result.output!);
  const publicId: unknown = body.draftId;
  if (typeof publicId !== 'string') throw new Error('Missing native draft public reference');
  expect(body).toMatchObject({ status: 'sent', draftId: expect.stringMatching(/^draft-reference-[a-p]{32}$/), draft: { id: body.draftId, status: 'sent' } });
  expect(f.delivery).toHaveLength(1);
  expect(f.delivery[0]?.body).toBe('Send the completed review to the owned fixture channel.');
  expect(getDraft(f.paths, legacyId)?.status).toBe('sent');
  expect(JSON.stringify(readings.requests)).not.toContain(legacyId);
  expect(JSON.stringify(f.screening.calls)).not.toContain(legacyId);
  expect(result.output).not.toContain(legacyId);
  expect(readings.requests).toHaveLength(0);
  expect(JSON.stringify(f.screening.calls)).toContain('Send the completed review to the owned fixture channel.');
  const retry = await f.run({ mode: 'channel_draft_send', draftId: publicId });
  expect(retry.success).toBe(false);
  expect(retry.error).toContain('already sent');
  expect(retry.error).toContain(publicId);
  expect(JSON.stringify(retry)).not.toContain(legacyId);
  expect(f.delivery).toHaveLength(1);
  expect(getDraft(f.paths, legacyId)?.status).toBe('sent');
});

test('an existing safe native draft ID stays usable in its send receipt', async () => {
  const id = 'draft_becaddef_facedbee';
  const f = scene(undefined, { id });
  const result = await f.run({ mode: 'channel_draft_send', draftId: id });
  expect(result.success).toBe(true);
  expect(JSON.parse(result.output!)).toMatchObject({ status: 'sent', draftId: id, draft: { id, status: 'sent' } });
  expect(getDraft(f.paths, id)?.status).toBe('sent');
  expect(f.delivery).toHaveLength(1);
});

test.each(['complete', 'private-field'] as const)('connected send preserves the complete %s native payload before transport', async kind => {
  const privateValue = 'private-connected-native-draft-field';
  const screening = researchScreeningFixture(kind === 'private-field' ? { spans: exactSensitiveSpans([privateValue]) } : {});
  const f = scene(screening, kind === 'private-field' ? { undisplayed: { note: privateValue } } : {}, true);
  const tokenPath = connectedHostOperatorTokenPath(f.root);
  mkdirSync(dirname(tokenPath), { recursive: true });
  writeFileSync(tokenPath, JSON.stringify({ token: 'fixture-native-reference-private-token' }));
  const connectedEnv = process.env.GOODVIBES_CONNECTED_HOST_TOKEN, daemonEnv = process.env.GOODVIBES_DAEMON_TOKEN;
  delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; delete process.env.GOODVIBES_DAEMON_TOKEN;
  const requests: { input: Record<string, unknown>; headers: Headers }[] = [];
  const fetchSpy = spyOn(fetchOwner, 'fetch').mockImplementation(async (_url, init) => {
    requests.push({ input: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return Response.json({ saved: true });
  });
  try {
    if (kind === 'private-field') {
      await expect(f.run()).rejects.toThrow();
      expect(requests).toHaveLength(0); expect(readings.requests).toHaveLength(0); expect(f.delivery).toHaveLength(0);
      expect(getDraft(f.paths, legacyId)?.status).toBe('draft');
      return;
    }
    const result = await f.run();
    expect(result.success).toBe(true);
    const receipt = JSON.parse(result.output!);
    expect(receipt.status).toBe('sent'); expect(requests).toHaveLength(1); expect(f.delivery).toHaveLength(1);
    expect(requests[0]?.input).toMatchObject({ id: receipt.draftId, admission: 'autonomous',
      message: 'Send the completed review to the owned fixture channel.', channel: 'slack:fixture' });
    expect(requests[0]?.headers.get(EXPLICIT_USER_REQUEST_HEADER)).toBeNull();
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer fixture-native-reference-private-token');
    expect(JSON.stringify(requests)).not.toContain(legacyId);
    expect(JSON.stringify(readings.requests)).not.toContain(legacyId);
    expect(result.output).not.toContain('fixture-native-reference-private-token');
    expect(getDraft(f.paths, legacyId)?.status).toBe('sent');
  } finally {
    fetchSpy.mockRestore();
    if (connectedEnv === undefined) delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; else process.env.GOODVIBES_CONNECTED_HOST_TOKEN = connectedEnv;
    if (daemonEnv === undefined) delete process.env.GOODVIBES_DAEMON_TOKEN; else process.env.GOODVIBES_DAEMON_TOKEN = daemonEnv;
  }
});

test('an unknown card-shaped ID never qualifies as a native reference', async () => {
  const f = scene();
  await expect(f.prepare({ ...args, draftId: 'draft-4111111111111111-unknown' })).rejects.toThrow();
  expect(readings.requests).toHaveLength(0); expect(f.screening.calls).toHaveLength(0); expect(f.delivery).toHaveLength(0);
  expect(getDraft(f.paths, legacyId)?.status).toBe('draft');
});

test('a known native reference cannot turn a read-only admission into a write or send', async () => {
  const f = scene(); f.setMode('plan');
  await expect(f.run({ ...args, confirm: true, explicitUserRequest: 'Caller-supplied claim' })).rejects.toThrow();
  expect(f.delivery).toHaveLength(0); expect(getDraft(f.paths, legacyId)?.status).toBe('draft');
});

test('complete undisplayed native draft payload is protected before hosted admission', async () => {
  const protectedValue = 'private-native-draft-context';
  const screening = researchScreeningFixture({ spans: exactSensitiveSpans([protectedValue]) });
  const f = scene(screening, { undisplayed: { note: protectedValue } });
  await expect(f.prepare(args)).rejects.toThrow();
  expect(JSON.stringify(screening.calls)).toContain(protectedValue);
  expect(readings.requests).toHaveLength(0); expect(f.delivery).toHaveLength(0);
  expect(getDraft(f.paths, legacyId)?.status).toBe('draft');
});

test('a selected draft reference cannot survive a same-bytes native file ABA', async () => {
  let f: ReturnType<typeof scene>;
  const screening = researchScreeningFixture({ beforeProposal: async () => { writeFileSync(f.path, readFileSync(f.path)); } });
  f = scene(screening);
  await expect(f.prepare(args)).rejects.toThrow();
  expect(readings.requests).toHaveLength(0); expect(f.delivery).toHaveLength(0);
  expect(getDraft(f.paths, legacyId)?.status).toBe('draft');
});

test.each(['project', 'release'] as const)('late source-owner %s accessors cannot inspect a reference or hijack cleanup', async method => {
  let getters = 0;
  const screening = researchScreeningFixture({ beforeProposal: async () => {
    Object.defineProperty(screening.owner, method, { configurable: true, get() { getters++; throw new Error('Unexpected owner accessor'); } });
  } });
  const descriptor = Object.getOwnPropertyDescriptor(screening.owner, method)!;
  const f = scene(screening);
  try {
    await expect(f.prepare(args)).rejects.toThrow();
    expect(getters).toBe(0); expect(readings.requests).toHaveLength(0); expect(f.delivery).toHaveLength(0);
    expect(getDraft(f.paths, legacyId)?.status).toBe('draft');
  } finally { Object.defineProperty(screening.owner, method, descriptor); }
});

test.each(['revoke', 'cancel', 'reference-aba', 'new-taint'] as const)('late %s preserves the queued draft without sending', async change => {
  const f = scene(), controller = new AbortController();
  f.beforeSend(() => {
    if (change === 'revoke') f.setMode('plan');
    if (change === 'cancel') controller.abort();
    if (change === 'reference-aba') writeFileSync(f.path, readFileSync(f.path));
    if (change === 'new-taint') getSessionUntrustedContentLedger().record({ surface: 'web-page', origin: 'https://fixture.invalid', at: 'fixture', content: 'A newly arrived source' });
  });
  await expect(f.run(args, controller.signal)).rejects.toThrow();
  expect(f.delivery).toHaveLength(0); expect(getDraft(f.paths, legacyId)?.status).toBe('queued');
});

test.each(['caller', 'workspace', 'platform', 'paths'] as const)('%s accessors are refused without getters or any wire', async target => {
  const f = scene(); let getters = 0;
  const input = { ...args };
  if (target === 'caller') Object.defineProperty(input, 'draftId', { enumerable: true, get() { getters++; return legacyId; } });
  if (target === 'workspace') Object.defineProperty(f.context, 'workspace', { get() { getters++; return { shellPaths: f.paths }; } });
  if (target === 'platform') Object.defineProperty(f.context, 'platform', { get() { getters++; return {}; } });
  if (target === 'paths') Object.defineProperty(f.context.workspace, 'shellPaths', { get() { getters++; return f.paths; } });
  await expect(f.prepare(input)).rejects.toThrow();
  expect(getters).toBe(0); expect(readings.requests).toHaveLength(0); expect(f.screening.calls).toHaveLength(0); expect(f.delivery).toHaveLength(0);
});
