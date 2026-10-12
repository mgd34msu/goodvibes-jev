import { afterAll, afterEach, expect, test } from 'bun:test';
import { ToolInputProjectionError, ToolRegistry } from '@goodvibes-jev/engine/sdk/platform/tools';
import type { ArtifactCreateInput, ArtifactDescriptor, ArtifactStore } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import { bindAgentResearchSourceOwner, createAgentResearchReportProjector, prepareProtectedResearchReport } from '../../agent/protected-research-report.ts';
import { createAgentResearchReportTool, registerAgentResearchReportTool } from '../../tools/agent-research-report-tool.ts';
import { registerAgentResearchTool } from '../../tools/agent-research-tool.ts';
import { registerAgentHarnessTool } from '../../tools/agent-harness-tool.ts';
import { registerAgentWorkspaceTool } from '../../tools/agent-workspace-tool.ts';
import { installToolExecutionSafetyGuard } from '../../tools/tool-execution-safety.ts';
import { cleanupResearchScreeningFixtures, exactSensitiveSpans, researchScreeningFixture } from '../helpers/research-screening.ts';
import type { CommandContext, CommandRegistry } from '../../input/command-registry.ts';
import { effectAdmissionFixture } from '../helpers/effect-admission.ts';

afterAll(cleanupResearchScreeningFixtures);
const base = { title: 'Report', question: 'What is supported?', summary: 'Evidence [S1].', confirm: true, explicitUserRequest: 'Save the report.', sources: [{ title: 'Source', url: 'https://example.test/article?id=123#section-2' }] };
function artifactStore() {
  const records: ArtifactCreateInput[] = [];
  const store: Pick<ArtifactStore, 'create'> = { async create(input) {
    records.push(input);
    return { id: 'synthetic-artifact', filename: input.filename, mimeType: input.mimeType, sizeBytes: input.text?.length ?? 0, sha256: 'synthetic-digest', metadata: input.metadata } as ArtifactDescriptor;
  } };
  return { store, records };
}
const deferredReleases: Array<() => void> = [];
const pendingOperations: Promise<unknown>[] = [];
afterEach(async () => {
  for (const release of deferredReleases.splice(0)) release();
  await Promise.allSettled(pendingOperations.splice(0));
});
function deferred() {
  const gate = Promise.withResolvers<void>();
  deferredReleases.push(gate.resolve);
  return gate;
}
function ownPending<T>(pending: Promise<T>): Promise<T> { pendingOperations.push(pending); return pending; }
async function awaitStarted(entered: ReturnType<typeof deferred>, pending: Promise<{ success: boolean; error?: string }>): Promise<void> {
  await Promise.race([entered.promise, pending.then(result => { throw new Error(`Synthetic operation ended before its awaited I/O: ${result.error ?? result.success}`); })]);
}
function admittedReportTool(...args: Parameters<typeof createAgentResearchReportTool>) {
  const admission = effectAdmissionFixture();
  return admission.tool(createAgentResearchReportTool(...args), { inputProjection: createAgentResearchReportProjector(args[1]) });
}
function registeredTool(registry: ToolRegistry, name: string) {
  const tool = registry.list().find(candidate => candidate.definition.name === name);
  if (!tool) throw new Error(`Synthetic research tool was not registered: ${name}`);
  return tool;
}

test('actual report artifact contains unbound TAB/LF/CR source references through verified spans', async () => {
  for (const control of ['\t', '\n', '\r']) {
    const reference = `https://example.test/doc${control}ument?opaque=sentinel`;
    const f = researchScreeningFixture({ spans: exactSensitiveSpans([reference]) });
    const { store, records } = artifactStore();
    const result = await admittedReportTool(store, f.owner).execute({ ...base,
      title: `Before ${reference} after`, question: `What ${reference}?`, summary: `Evidence ${reference} [S1].`, reportMarkdown: `Claim ${reference} [S1].`,
      findings: [`Finding ${reference} [S1]`], gaps: [reference], recommendations: [reference], methodology: reference, confidence: reference,
      tags: [reference], explicitUserRequest: `Save ${reference}`, sources: [{ title: `Source ${reference}`, note: `Before ${reference} after.\nOrdinary second line.`, publisher: reference, credibility: reference }],
    });
    expect(result.success).toBe(true);
    expect(JSON.stringify([result, records])).not.toContain('sentinel');
    expect(records[0]?.text).toContain('Ordinary second line.');
    expect(records[0]?.text).toContain('Before [redacted] after');
  }
});

test('role omission precedes released alias projection even when privacy spans select only the value', async () => {
  const url = 'https://example.test/doc?opaque=sentinel#anchor';
  const f = researchScreeningFixture({ spans: exactSensitiveSpans(['sentinel']), role: name => name === 'opaque' ? 1 : 0 });
  const prepared = await prepareProtectedResearchReport(f.owner, { ...base, summary: `Read ${url} [S1]`, reportMarkdown: `Read ${url.replace('example.test', 'EXAMPLE.TEST')} [S1]`, sources: [{ title: url, url, note: url }] });
  try {
    expect(JSON.stringify(prepared.args)).not.toContain('sentinel');
    expect(JSON.stringify(prepared.args)).not.toContain('?opaque=');
    expect(prepared.args.sources).toEqual([{ title: '[source URL withheld]', credibility: 'unreviewed', note: '[source URL withheld]', urlOmitted: true }]);
    const roleCalls = f.calls.filter(call => (call.body.state as Record<string, unknown> | undefined)?.parameter);
    expect(roleCalls.map(call => call.body.state)).toEqual([{ parameter: 'opaque' }]);
  } finally { await prepared.release(); }
});

test('benign exact URL bytes and S2 survive first-source omission', async () => {
  const f = researchScreeningFixture({ role: name => name === 'opaque' ? 1 : 0 });
  const url = 'HTTPS://EXAMPLE.TEST:443/doc%2fpart?id=one&id=two&q=ordinary+words#anchor';
  const prepared = await prepareProtectedResearchReport(f.owner, { ...base, summary: 'Evidence [S2].', sources: [{ title: 'Omitted', url: 'https://example.test/?opaque=synthetic' }, { title: 'Kept', url }] });
  try { expect(prepared.args.sources).toEqual([{ title: 'Omitted', credibility: 'unreviewed', urlOmitted: true }, { title: 'Kept', credibility: 'unreviewed', url }]); }
  finally { await prepared.release(); }
});

test('invalid source slots, over-limit reports and key projections cannot silently rebind citations', async () => {
  const f = researchScreeningFixture({ spans: exactSensitiveSpans(['private-key']) });
  for (const sources of [[null, base.sources[0]], Array.from({ length: 51 }, () => base.sources[0])]) {
    await expect(prepareProtectedResearchReport(f.owner, { ...base, sources })).rejects.toThrow();
  }
  await expect(prepareProtectedResearchReport(f.owner, { ...base, summary: 'a'.repeat(40_001) })).rejects.toThrow();
  await expect(prepareProtectedResearchReport(f.owner, { ...base, 'private-key': 'ordinary' })).rejects.toThrow();
});

test('privacy changes to an ordinary URL hold rather than manufacture another usable reference', async () => {
  const f = researchScreeningFixture({ spans: exactSensitiveSpans(['sentinel']) });
  await expect(prepareProtectedResearchReport(f.owner, { ...base, sources: [{ title: 'Source', url: 'https://example.test/?id=sentinel' }] })).rejects.toThrow();
});

test('source-list separator redaction holds the whole report', async () => {
  const f = researchScreeningFixture({ spans: exactSensitiveSpans(['first\nsecond']) });
  await expect(prepareProtectedResearchReport(f.owner, { ...base, sources: 'first\nsecond' })).rejects.toThrow();
});

test('missing owner and semantic uncertainty never invoke artifact persistence', async () => {
  const { store, records } = artifactStore();
  expect((await admittedReportTool(store).execute(base)).success).toBe(false);
  const f = researchScreeningFixture({ complete: 0.5 });
  expect((await admittedReportTool(store, f.owner).execute(base)).success).toBe(false);
  expect(records).toEqual([]); expect(f.calls.length).toBeGreaterThan(0);
});

test('cancellation owns pending local requests and prevents artifact invocation', async () => {
  const started = deferred(), gate = deferred();
  const f = researchScreeningFixture({ beforeProposal: async () => { started.resolve(); await gate.promise; } });
  const { store, records } = artifactStore();
  const controller = new AbortController();
  const pending = ownPending(admittedReportTool(store, f.owner).execute(base, { signal: controller.signal }));
  await awaitStarted(started, pending); controller.abort(); gate.resolve();
  expect((await pending).success).toBe(false); expect(records).toEqual([]);
});

test('registered report projection precedes generic readers and actual artifact execution', async () => {
  const privateText = 'synthetic-private-contact';
  const f = researchScreeningFixture({ spans: exactSensitiveSpans([privateText]) });
  const admission = effectAdmissionFixture(); const registry = admission.registry; installToolExecutionSafetyGuard(registry);
  const { store, records } = artifactStore(); registerAgentResearchReportTool(registry, store, f.owner);
  const call = await registry.projectCall('report-projection', 'agent_research_report', { ...base, summary: `Before ${privateText} after [S1].` });
  expect(JSON.stringify(call)).not.toContain(privateText);
  await registry.releaseProjected(call);
  const result = await admission.run(registeredTool(registry, 'agent_research_report'), { ...base, summary: `Before ${privateText} after [S1].` });
  expect(result.success).toBe(true); expect(JSON.stringify(records)).not.toContain(privateText);
});

test('public research action aliases project before registration consumers', async () => {
  const f = researchScreeningFixture({ spans: exactSensitiveSpans(['synthetic-private']) });
  const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, f.owner);
  registerAgentResearchTool(registry, {} as CommandRegistry, { workspace: {}, platform: {} } as CommandContext);
  for (const route of [{ action: 'report' }, { action: 'save-report' }, { mode: 'visual_report' }, { action: 'unknown', mode: 'report' }]) {
    const call = await registry.projectCall(`alias-${JSON.stringify(route)}`, 'research', { ...base, ...route, summary: 'synthetic-private' });
    try { expect(JSON.stringify(call)).not.toContain('synthetic-private'); } finally { await registry.releaseProjected(call); }
  }
});

test('harness and public workspace report aliases screen complete original editor fields first', async () => {
  const f = researchScreeningFixture({ spans: exactSensitiveSpans(['synthetic-private']) });
  const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, f.owner);
  installToolExecutionSafetyGuard(registry);
  const context = { workspace: {}, platform: {} } as CommandContext;
  registerAgentHarnessTool(registry, {} as CommandRegistry, context);
  registerAgentWorkspaceTool(registry, {} as CommandRegistry, context);
  for (const [name, route] of [
    ['agent_harness', { mode: 'run_workspace_action', actionId: 'research-save-report' }],
    ['agent_harness', { mode: 'run_workspace_action', target: 'Save research report' }],
    ['workspace', { action: 'submit', workspaceActionId: 'research-save-report' }],
  ] as const) {
    const call = await registry.projectCall(`editor-${name}-${JSON.stringify(route)}`, name, { ...route, fields: { title: 'Report', question: 'Question', summary: 'synthetic-private', sources: 'Source | https://example.test/doc', confirm: 'yes' }, confirm: true, explicitUserRequest: 'Save it.' });
    try { expect(JSON.stringify(call)).not.toContain('synthetic-private'); } finally { await registry.releaseProjected(call); }
  }
});


test('numeric report fields are screened before generic schema repair', async () => {
  const f = researchScreeningFixture({ spans: exactSensitiveSpans(['5551234567']) });
  const registry = new ToolRegistry(); registerAgentResearchReportTool(registry, artifactStore().store, f.owner);
  await expect(registry.projectCall('numeric-private', 'agent_research_report', { ...base, summary: 5551234567 })).rejects.toThrow();
  expect(JSON.stringify(f.calls)).toContain('5551234567');
});

test('report-shaped arguments cannot reach repair through a misspelled route', async () => {
  const f = researchScreeningFixture({ spans: exactSensitiveSpans(['synthetic-private']) });
  const registry = new ToolRegistry(); bindAgentResearchSourceOwner(registry, f.owner);
  registerAgentResearchTool(registry, {} as CommandRegistry, { workspace: {}, platform: {} } as CommandContext);
  const input = { ...base, action: 'repotr', summary: 'synthetic-private' };
  const refusal: unknown = await registry.projectCall('typo-report', 'research', input).then(
    async call => { await registry.releaseProjected(call); return null; }, (error: unknown) => error);
  expect(refusal).toBeInstanceOf(ToolInputProjectionError);
  expect(JSON.stringify(refusal)).not.toContain('synthetic-private');
  expect(f.calls).toEqual([]);
});

test('prepared reuse checks the new operation after authority callbacks and freezes derived bindings', async () => {
  const controller = new AbortController(); let abortFromAuthority = false;
  const f = researchScreeningFixture({ assertCurrent: () => { if (abortFromAuthority) controller.abort(); } });
  const prepared = await prepareProtectedResearchReport(f.owner, base);
  try {
    expect(Object.isFrozen(prepared.args)).toBe(true);
    expect(Object.isFrozen(prepared.args.sources)).toBe(true);
    const reused = await prepareProtectedResearchReport(f.owner, prepared.args, { signal: controller.signal });
    abortFromAuthority = true;
    expect(() => reused.assertCurrent()).toThrow();
  } finally { await prepared.release(); }
});

for (const route of ['harness', 'workspace'] as const) {
  test(`${route} preserves exact original citation bytes through actual nested artifact execution`, async () => {
    const f = researchScreeningFixture(); const { store, records } = artifactStore();
    const admission = effectAdmissionFixture(); const registry = admission.registry; registerAgentResearchReportTool(registry, store, f.owner);
    const context = { workspace: {}, platform: { artifactStore: store } } as unknown as CommandContext;
    const deps = { commandRegistry: {} as CommandRegistry, commandContext: context, toolRegistry: registry };
    if (route === 'harness') registerAgentHarnessTool(registry, deps.commandRegistry, context);
    else registerAgentWorkspaceTool(registry, deps.commandRegistry, context);
    const tool = registeredTool(registry, route === 'harness' ? 'agent_harness' : 'workspace');
    const url = 'HTTPS://EXAMPLE.TEST:443/doc%2fpart?id=one&id=two#anchor';
    const result = await admission.run(tool, { ...(route === 'harness' ? { mode: 'run_workspace_action' } : { action: 'run' }), actionId: 'research-save-report', fields: { title: 'Report', question: 'Question', summary: 'Evidence [S1]', sources: `Source | ${url} | high`, confirm: 'yes' }, confirm: true, explicitUserRequest: 'Save it.' });
    expect(result.success).toBe(true); expect(records).toHaveLength(1);
    expect((records[0]!.metadata?.sources as { url: string }[])[0]!.url).toBe(url);
  });
  test(`${route} cancellation during nested report screening prevents artifact invocation`, async () => {
    for (const retirement of route === 'workspace' ? ['signal', 'admission'] : ['signal']) {
      const started = deferred(), gate = deferred();
      const f = researchScreeningFixture({ beforeProposal: async source => {
        if (source.parts[0] === 'title' && source.parts[1] === 'Report') { started.resolve(); await gate.promise; }
      } });
      const { store, records } = artifactStore(); const admission = effectAdmissionFixture(); const registry = admission.registry; registerAgentResearchReportTool(registry, store, f.owner);
      const context = { workspace: {}, platform: { artifactStore: store } } as unknown as CommandContext;
      const deps = { commandRegistry: {} as CommandRegistry, commandContext: context, toolRegistry: registry };
      if (route === 'harness') registerAgentHarnessTool(registry, deps.commandRegistry, context);
      else registerAgentWorkspaceTool(registry, deps.commandRegistry, context);
      const tool = registeredTool(registry, route === 'harness' ? 'agent_harness' : 'workspace');
      const controller = new AbortController();
      const pending = ownPending(admission.run(tool, { ...(route === 'harness' ? { mode: 'run_workspace_action' } : { action: 'run' }), actionId: 'research-save-report', fields: { title: 'Report', question: 'Question', summary: 'Evidence [S1]', sources: 'Source | https://example.test/doc | high', confirm: 'yes' }, confirm: true, explicitUserRequest: 'Save it.' }, { signal: controller.signal }));
      await awaitStarted(started, pending);
      if (retirement === 'signal') controller.abort(); else admission.revoke();
      gate.resolve(); await pending.catch(() => undefined);
      expect((await pending).success).toBe(false);
      expect(records).toEqual([]);
    }
  });
}


test('explicit unrelated editor with a sources field retains its own boundary', async () => {
  const registry = new ToolRegistry(); const context = { workspace: {}, platform: {} } as CommandContext;
  registerAgentHarnessTool(registry, {} as CommandRegistry, context);
  registerAgentWorkspaceTool(registry, {} as CommandRegistry, context);
  for (const [name, route] of [['agent_harness', { mode: 'run_workspace_action' }], ['workspace', { action: 'run' }]] as const) {
    const input = { ...route, actionId: 'knowledge-import-browser-history', fields: { sources: 'history,bookmark' } };
    const call = await registry.projectCall(`non-report-${name}`, name, input);
    try { expect(call.args).toEqual(input); } finally { await registry.releaseProjected(call); }
  }
});


test('unrelated registered workspace routes retain ordinary argument repair', async () => {
  const registry = new ToolRegistry(); const context = { workspace: {}, platform: {} } as CommandContext;
  registerAgentWorkspaceTool(registry, {} as CommandRegistry, context);
  const result = await registry.execute('ordinary-workspace', 'workspace', { action: 'ACTIONS', limit: '1' });
  expect(result.success).toBe(true);
});

test('cancellation inside candidate capture drains the late returned handle', async () => {
  const fixture = researchScreeningFixture({ role: name => name === 'opaque' ? 1 : 0 });
  const controller = new AbortController(); const live = new Set<object>(); let abortedInsideCapture = false;
  const owner = { ...fixture.owner,
    capture(parts: readonly string[]) {
      const handle = fixture.owner.capture(parts); live.add(handle);
      if (parts.some(part => part.includes('[source URL withheld]'))) { abortedInsideCapture = true; controller.abort(); }
      return handle;
    },
    captureResearchReference(url: string) { const handle = fixture.owner.captureResearchReference(url); live.add(handle); return handle; },
    async release(handle: Parameters<typeof fixture.owner.release>[0]) { await fixture.owner.release(handle); live.delete(handle); },
  };
  await expect(prepareProtectedResearchReport(owner, { ...base, sources: [{ title: 'Source', url: 'https://example.test/doc?opaque=synthetic' }] }, { signal: controller.signal })).rejects.toThrow();
  expect(abortedInsideCapture).toBe(true); expect(live.size).toBe(0);
});
