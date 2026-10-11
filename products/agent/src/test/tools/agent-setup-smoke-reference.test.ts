import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { ConfigManager, DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/sdk/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/sdk/platform/runtime/security';
import { ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/sdk/platform/types';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/sdk/platform/gate';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { CommandContext } from '../../input/command-registry.ts';
import { createSetupSmokeReferenceCapture, resolveSetupSmokeNativeEvidence } from '../../tools/agent-setup-smoke-reference.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

let previous: ReturnType<typeof installJudgmentPort>, log: SqliteDecisionLog, readings: ReturnType<typeof fakePort>;
const roots: string[] = [];
const input = { mode: 'run_setup_smoke', setupItemId: 'install-smoke', fields: {
  agentBinaryOutput: 'goodvibes-agent starts\nAuthorization: Bearer private-smoke-header',
  statusJson: '{"connectedHost":{"token":"private-smoke-json"},"ok":true}',
  firstAssistantTurn: 'Ready. apiKey=private-smoke-assistant',
  notes: 'Observed https://fixture.invalid/status?token=private-smoke-query',
} };
beforeEach(() => {
  readings = fakePort((name, question) => {
    if (question.type === 'noul') return noulAnswer(0.001);
    const label = name === 'disposition' ? 'act' : name === 'kind' ? 'read'
      : name === 'family' || name === 'capability' ? 'generic' : undefined;
    if (!label) throw new Error(`Unexpected smoke-owner fixture question ${name}`);
    return choiceAnswer(question, label, 0.999);
  });
  log = new SqliteDecisionLog(':memory:'); previous = installJudgmentPort(withDecisionLog(readings.port, log));
});
afterEach(() => {
  installJudgmentPort(previous); log[Symbol.dispose]();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scene() {
  const root = makeProjectTempDir('native-smoke-owner'); roots.push(root);
  const store = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const configManager = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, 'config') });
  const context = { platform: { configManager, artifactStore: store }, workspace: { shellPaths: { homeDirectory: root, workingDirectory: root } } } as unknown as CommandContext;
  let mode: PermissionMode = 'prompt', sequence = 0, beforeCreate: (() => void) | undefined;
  let retainedArgs: Record<string, unknown> | undefined, retainedOptions: Parameters<Tool['execute']>[1];
  const permissions = () => ({ ...DEFAULT_CONFIG.permissions, mode });
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: permissions(), autoApprove: false, directory: root }),
    getSnapshot: () => ({ permissions: permissions() }), isAutoApproveEnabled: () => false, getWorkingDirectory: () => root,
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState()), registry = new ToolRegistry(manager);
  const tool: Tool = { definition: { name: 'agent_harness', description: 'Save captured redacted synthetic setup output.', sideEffects: ['state'],
    parameters: { type: 'object', properties: { mode: { type: 'string' }, setupItemId: { type: 'string' }, fields: { type: 'object', additionalProperties: { type: 'string' } } }, required: ['mode'], additionalProperties: true } },
    async execute(args, options) {
      retainedArgs = args; retainedOptions = options;
      const evidence = resolveSetupSmokeNativeEvidence(args, options, context);
      await Promise.resolve(); beforeCreate?.(); evidence.assertCurrent();
      const descriptor = await evidence.createArtifact?.({ kind: 'document', text: evidence.fields.map(field => `${field.label}\n${field.value}`).join('\n'), metadata: { purpose: 'agent-setup-smoke-evidence' } });
      evidence.assertCurrent();
      return { success: true, output: JSON.stringify({ id: descriptor?.id, fields: evidence.fields }) };
    } };
  registry.register(tool, { inputProjection: { captureNativeReferences: createSetupSmokeReferenceCapture(context), async project(request) { return { status: 'projected', args: request.args }; } } });
  const prepare = (args: Record<string, unknown>, signal?: AbortSignal) => registry.prepareCall(`native-smoke-${++sequence}`, 'agent_harness', args, { signal });
  const run = async (args: Record<string, unknown> = input, signal?: AbortSignal) => {
    const call = await prepare(args, signal);
    const admission = await manager.admitAutonomous(call.callId, call.name, call.args, { signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call },
      sourceOf: () => ({ goal: 'Save redacted synthetic user-run smoke output in an isolated local artifact', criteria: ['Keep raw credential values private and require the exact active ownership'] }) });
    expect(admission.result.autonomousDecision?.outcome).toBe('act');
    return registry.executePrepared(call, admission);
  };
  return { context, store, tool, registry, prepare, run, root, beforeCreate(callback: () => void) { beforeCreate = callback; },
    setMode(next: PermissionMode) { mode = next; }, retained: () => ({ args: retainedArgs!, options: retainedOptions }) };
}

test('recorded native intake saves only cleared evidence and complete safe subjects', async () => {
  expect(() => snapshotJudgmentInput(input)).toThrow();
  const f = scene(), result = await f.run();
  expect(result.success).toBe(true); expect(f.store.list()).toHaveLength(1);
  const artifact = await f.store.readContent(f.store.list()[0]!.id);
  const outward = `${JSON.stringify(readings.requests)}${result.output}${artifact.buffer.toString()}`;
  for (const value of Object.values(input.fields).flatMap(value => value.match(/private-smoke-[\w]+/g) ?? [])) expect(outward).not.toContain(value);
  expect(artifact.buffer.toString()).toContain('Authorization: <redacted>');
  expect(artifact.buffer.toString()).toContain('Ready. apiKey=<redacted>');
  expect(JSON.stringify(readings.requests)).toContain('goodvibes-agent starts');
  const retained = f.retained();
  expect(() => resolveSetupSmokeNativeEvidence(retained.args, retained.options, f.context)).toThrow();
});

test('issuer credentials are cleared without a model redaction lookup and display caps retain no partial credential', async () => {
  const f = scene(), issuer = `ghp_${'a'.repeat(36)}`;
  const result = await f.run({ mode: 'run_setup_smoke', fields: { notes: `${'x'.repeat(7970)} ${issuer} safe-tail-after-cap` } });
  expect(result.success).toBe(true); expect(result.output).not.toContain(issuer);
  const artifact = await f.store.readContent(f.store.list()[0]!.id);
  expect(artifact.buffer.toString()).not.toContain('ghp_');
  expect(JSON.stringify(readings.requests)).toContain('safe-tail-after-cap');
  expect(readings.requests.every(request => !JSON.stringify(request).includes('private-smoke-'))).toBe(true);
});

test.each(['basic-header', 'opaque-header', 'cookie-header', 'quoted-assignment', 'escaped-json', 'query-values', 'assignment-prose'] as const)('complete %s credential values never become independent safe tails', async kind => {
  const f = scene();
  const value = kind === 'basic-header' ? 'safe-before\nAuthorization: Basic cHJpdmF0ZS1jb21wbGV0ZS12YWx1ZQ==\nsafe-after'
    : kind === 'opaque-header' ? 'safe-before\nAuthorization: Opaque private-scheme-first private-scheme-second, proof=private-scheme-third\nsafe-after'
    : kind === 'cookie-header' ? 'safe-before\nCookie: session=private-cookie-first; owner=private-cookie-second\nsafe-after'
    : kind === 'quoted-assignment' ? 'safe-before apiKey="private-first private-second \\"private-third\\"" safe-after'
    : kind === 'escaped-json' ? JSON.stringify({ apiKey: 'private-json-first private-json-second "private-json-third"', ordinary: 'safe-after' })
    : kind === 'query-values' ? 'safe-before https://fixture.invalid/status?apiKey=private-query-first%20private-query-second&token=private-query-third&ordinary=safe-after#public-fragment'
    : 'safe-before apiKey=private-prose-secret safe-after';
  const result = await f.run({ mode: 'run_setup_smoke', fields: { notes: value } });
  expect(result.success).toBe(true);
  const artifact = await f.store.readContent(f.store.list()[0]!.id);
  const outward = `${JSON.stringify(readings.requests)}${result.output}${artifact.buffer.toString()}`;
  for (const secret of value.match(/private-[a-z-]+/g) ?? []) expect(outward).not.toContain(secret);
  expect(outward).not.toContain('cHJpdmF0ZS1jb21wbGV0ZS12YWx1ZQ==');
  expect(artifact.buffer.toString()).toContain('safe-after');
  if (kind !== 'escaped-json') expect(artifact.buffer.toString()).toContain('safe-before');
  if (kind === 'query-values') expect(artifact.buffer.toString()).toContain('public-fragment');
});

test.each(['ordinary-json', 'json-log', 'nested-json'] as const)('encoded issuer in %s remains held before readings and artifacts', async kind => {
  const f = scene(), encoded = '{"ordinary":"\\u0067hp_' + 'a'.repeat(36) + '"}';
  const value = kind === 'ordinary-json' ? encoded : kind === 'json-log' ? `Logged JSON: ${encoded}` : JSON.stringify({ ordinary: encoded });
  await expect(f.prepare({ mode: 'run_setup_smoke', fields: { notes: value } })).rejects.toThrow();
  expect(readings.requests).toHaveLength(0); expect(f.store.list()).toHaveLength(0);
});

test.each(['safe-escaped', 'encoded-credential'] as const)('supported %s JSON evidence retains safe source and no credential', async kind => {
  const f = scene();
  const value = kind === 'safe-escaped' ? '{"ordinary":"safe-\\u0061fter"}'
    : '{"apiKey":"\\u0067hp_' + 'a'.repeat(36) + '","ordinary":"safe-after"}';
  const result = await f.run({ mode: 'run_setup_smoke', fields: { notes: value } });
  expect(result.success).toBe(true); expect(f.store.list()).toHaveLength(1);
  const artifact = (await f.store.readContent(f.store.list()[0]!.id)).buffer.toString();
  const outward = `${JSON.stringify(readings.requests)}${result.output}${artifact}`;
  if (kind === 'safe-escaped') expect(artifact).toContain(value);
  else {
    expect(outward).not.toContain('a'.repeat(36));
    expect(outward).not.toContain('\\u0067hp_');
    expect(artifact).toContain('safe-after');
    expect(artifact).toContain('"apiKey":"<redacted>"');
  }
});

test.each(['unclosed-quote', 'quoted-suffix', 'unknown-escaped-json-field', 'unknown-escaped-json-log', 'malformed-json', 'object-value', 'folded-header', 'card-after-basic'] as const)('unsupported %s declarations are held before marker subjects detach them', async kind => {
  const f = scene();
  const value = kind === 'unclosed-quote' ? 'apiKey="private-first private-tail'
    : kind === 'quoted-suffix' ? 'apiKey="private-first"private-tail'
    : kind === 'unknown-escaped-json-field' ? '{"token":"private-known","access\\u005ftoken":"private-unknown"}'
    : kind === 'unknown-escaped-json-log' ? 'Logged JSON: {"Authorization":"Basic private-known","access\\u005ftoken":"private-unknown"}'
    : kind === 'malformed-json' ? '{"token":"private-known","access\\u005ftoken":"private-unknown" broken}'
    : kind === 'object-value' ? '{"apiKey":{"value":"private-object"}}'
    : kind === 'folded-header' ? 'Authorization: Basic private-basic\n private-folded-tail'
    : 'Authorization: Basic private-basic\n4111111111111111';
  await expect(f.prepare({ mode: 'run_setup_smoke', fields: { notes: value } })).rejects.toThrow();
  expect(readings.requests).toHaveLength(0); expect(f.store.list()).toHaveLength(0);
});

test.each(['early-credential', 'after-display-cap', 'structured-card'] as const)('full %s card material is refused before any reading or artifact', async kind => {
  const f = scene();
  const text = kind === 'early-credential' ? 'Authorization: Bearer local-secret\n4111111111111111'
    : kind === 'after-display-cap' ? `${'safe '.repeat(2000)}4111111111111111` : '{"apiKey":"local-secret","cardNumber":"4111111111111111"}';
  await expect(f.prepare({ mode: 'run_setup_smoke', fields: { notes: text } })).rejects.toThrow();
  expect(readings.requests).toHaveLength(0); expect(f.store.list()).toHaveLength(0);
});

test.each(['unknown-field', 'unrelated-mode', 'unselected-sibling', 'unsupported-header', 'forged-subject', 'non-string'] as const)('%s cannot inherit the native string intake domain', async kind => {
  const f = scene();
  const args: Record<string, unknown> = kind === 'unknown-field' ? { mode: 'run_setup_smoke', fields: { extra: 'apiKey=private-unknown' } }
    : kind === 'unrelated-mode' ? { ...input, mode: 'set_setting' }
    : kind === 'unselected-sibling' ? { ...input, extra: { password: 'private-sibling' } }
    : kind === 'unsupported-header' ? { mode: 'run_setup_smoke', fields: { notes: 'Inline Cookie: private-cookie' } }
    : kind === 'forged-subject' ? { ...input, nativeReferenceSubjects: { kind: 'setup-smoke-evidence' } }
    : { mode: 'run_setup_smoke', fields: { notes: { apiKey: 'private-object' } } };
  await expect(f.prepare(args)).rejects.toThrow();
  expect(readings.requests).toHaveLength(0); expect(f.store.list()).toHaveLength(0);
});

test('caller flags and forged reference/context options cannot resolve or publish evidence', async () => {
  const f = scene();
  await expect(f.tool.execute({ mode: 'run_setup_smoke', fields: { notes: 'native-smoke:notes' }, confirm: true, explicitUserRequest: 'Caller claim' }, { inputProjectionContext: Object.freeze({}) })).rejects.toThrow();
  expect(f.store.list()).toHaveLength(0); expect(readings.requests).toHaveLength(0);
});

test('copied options, copied arguments and another owner cannot borrow an active native source', async () => {
  const f = scene(), other = scene();
  f.beforeCreate(() => {
    const retained = f.retained();
    expect(() => resolveSetupSmokeNativeEvidence(retained.args, { ...retained.options }, f.context)).toThrow();
    expect(() => resolveSetupSmokeNativeEvidence({ ...retained.args }, retained.options, f.context)).toThrow();
    expect(() => resolveSetupSmokeNativeEvidence(retained.args, retained.options, other.context)).toThrow();
  });
  expect((await f.run()).success).toBe(true); expect(f.store.list()).toHaveLength(1); expect(other.store.list()).toHaveLength(0);
});

test.each(['plan', 'cancel', 'store', 'create', 'workspace', 'config'] as const)('late %s change prevents publication under the original recorded invocation', async kind => {
  const f = scene(), controller = new AbortController();
  f.beforeCreate(() => {
    if (kind === 'plan') f.setMode('plan');
    if (kind === 'cancel') controller.abort();
    if (kind === 'store') (f.context.platform as unknown as { artifactStore: unknown }).artifactStore = {};
    if (kind === 'create') f.store.create = async () => { throw new Error('Replaced create must not be called'); };
    if (kind === 'workspace') (f.context.workspace.shellPaths as { workingDirectory: string }).workingDirectory = join(f.root, 'changed');
    if (kind === 'config') (f.context.platform as unknown as { configManager: unknown }).configManager = {};
  });
  await expect(f.run(input, controller.signal)).rejects.toThrow();
  expect(f.store.list()).toHaveLength(0); expect(readdirSync(join(f.root, 'artifacts'))).toHaveLength(0);
});

test('the actual artifact writer drains a cancellation during its asynchronous write', async () => {
  const f = scene(), controller = new AbortController(), original = f.store.create;
  let started = false;
  f.store.create = async function (input, ownership) {
    started = true;
    const pending = original.call(this, input, ownership);
    controller.abort();
    return pending;
  };
  await expect(f.run(input, controller.signal)).rejects.toThrow();
  expect(started).toBe(true); expect(f.store.list()).toHaveLength(0);
  expect(readdirSync(join(f.root, 'artifacts'))).toHaveLength(0);
});

test('a replaced physical artifact root is refused before a native write', async () => {
  const f = scene(), storagePath = f.store.storagePath;
  f.beforeCreate(() => { renameSync(storagePath, `${storagePath}-previous`); mkdirSync(storagePath); });
  await expect(f.run()).rejects.toThrow();
  expect(f.store.list()).toHaveLength(0); expect(readdirSync(storagePath)).toHaveLength(0);
});

test('native capture refuses source/context accessors before their getters or any reading', async () => {
  for (const location of ['caller', 'platform', 'store'] as const) {
    const f = scene(); let getters = 0;
    const args = { ...input };
    if (location === 'caller') Object.defineProperty(args, 'fields', { enumerable: true, get() { getters++; return input.fields; } });
    if (location === 'platform') Object.defineProperty(f.context, 'platform', { get() { getters++; return {}; } });
    if (location === 'store') Object.defineProperty(f.context.platform, 'artifactStore', { get() { getters++; return f.store; } });
    await expect(f.prepare(args)).rejects.toThrow(); expect(getters).toBe(0); expect(f.store.list()).toHaveLength(0);
  }
  expect(readings.requests).toHaveLength(0);
});
