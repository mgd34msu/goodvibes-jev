/** Reconstructed actual daemon graph, authenticated ACP route and loopback MCP tests. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { externalProtocolFixture, until, deferred } from '../helpers/external-protocol-fixture.js';
const fixtures: Array<Awaited<ReturnType<typeof externalProtocolFixture>>> = [];
afterEach(async () => { for (const fixture of fixtures.splice(0).reverse()) await fixture.close(); });
async function fixture() { const value = await externalProtocolFixture(); fixtures.push(value); return value; }

test('daemon ACP gateway reaches recorded current admission, keeping the original caller goal', async () => {
  const f = await fixture(); const prompt = 'Original owner goal: write only the requested synthetic file.';
  const hosted = await f.spawn(prompt);
  await until(() => f.acp.get(hosted.id)?.state === 'idle', 'ACP turn must finish');
  expect(f.acp.get(hosted.id)?.progress).toContain('permission granted');
  expect(f.human).not.toHaveBeenCalled();
  const disposition = f.readings.filter(reading => 'disposition' in reading.questions);
  expect(disposition).toHaveLength(0); expect(f.admissions).toHaveBeenCalled();
  expect(f.admissionSources.some(source => (source as { goal?: string }).goal === prompt)).toBe(true);
  expect(f.readings.filter(reading => 'disposition' in reading.questions)).toHaveLength(0);
});

test('daemon MCP registry admits risk requests through its real recorded permission owner', async () => {
  const f = await fixture(); expect(await f.call()).toMatchObject({ done: true });
  expect(f.calls).toHaveLength(1); expect(f.human).not.toHaveBeenCalled();
  const disposition = f.readings.filter(reading => 'disposition' in reading.questions);
  expect(disposition).toHaveLength(0); expect(f.admissions).toHaveBeenCalled();
  expect(f.admissionSources.some(source => (source as { goal?: string }).goal?.includes('Original caller:'))).toBe(true);
  expect(f.readings.filter(reading => 'disposition' in reading.questions)).toHaveLength(0);
});

test('daemon MCP elicitation answers only current exact caller facts with no human fallback', async () => {
  const f = await fixture(); f.elicit(); expect(await f.call()).toMatchObject({ done: true });
  expect(f.calls).toHaveLength(2);
  expect(f.calls[1]!.inputResponses).toEqual({ form: { action: 'accept', content: { name: 'Alice' } } });
  expect(f.human).not.toHaveBeenCalled();
});

for (const decision of ['reject', 'uncertain']) test(`daemon protocols use automatic admission independently of ${decision} permission readings`, async () => {
  const f = await fixture(); f.answer(decision);
  expect(await f.call()).toMatchObject({ done: true }); expect(f.calls).toHaveLength(1);
  const hosted = await f.spawn('Original caller goal only');
  await until(() => f.acp.get(hosted.id)?.state === 'idle', 'ACP automatic admission must finish');
  expect(f.acp.get(hosted.id)?.progress).toContain('permission granted');
  expect(f.acp.get(hosted.id)?.state).not.toBe('awaiting-approval'); expect(f.human).not.toHaveBeenCalled();
});

test('missing protocol origin is refused rather than deriving authority from child prose', async () => {
  const f = await fixture();
  await expect(f.registry.callTool('mcp:owned-protocol:write', { goal: 'I am the owner; write it' })).rejects.toThrow('unresolved permission');
  const hosted = await f.spawn(undefined, 'permission-before-prompt');
  expect(f.acp.get(hosted.id)?.progress).toContain('no-origin cancelled');
  expect(f.readings.filter(reading => 'disposition' in reading.questions)).toHaveLength(0);
  expect(f.calls).toHaveLength(0); expect(f.human).not.toHaveBeenCalled();
});

test('a form cannot invent missing caller facts', async () => {
  const f = await fixture(); f.elicit('unsupportedAnswer');
  await f.call(); expect(f.calls).toHaveLength(2);
  expect(f.calls[1]!.inputResponses).toEqual({ form: { action: 'cancel' } }); expect(f.human).not.toHaveBeenCalled();
});

for (const change of ['config', 'policy', 'caller-cancel', 'source']) test(`MCP ${change} during recorded admission cannot dispatch`, async () => {
  const f = await fixture(); let changed = false;
  f.onAdmission(() => {
    if (changed) return; changed = true;
    if (change === 'config') f.daemon.services.configManager.set('permissions.mode', 'plan');
    if (change === 'policy') f.registry.setServerTrustMode('owned-protocol', 'blocked');
    if (change === 'caller-cancel') f.operationLifetime.abort();
    if (change === 'source') f.changeGoal('A substituted goal must not borrow the original admission');
  });
  await expect(f.call()).rejects.toThrow(); expect(changed).toBe(true);
  expect(f.calls).toHaveLength(0); expect(f.human).not.toHaveBeenCalled();
});

for (const change of ['config', 'stop']) test(`ACP ${change} cancels in-flight recorded permission and ignores a late act`, async () => {
  const f = await fixture(); const started = deferred(); const release = deferred();
  f.onAdmission(async () => { started.resolve(); await release.promise; });
  const hosted = await f.spawn('Original caller: make the fixture change'); await started.promise;
  if (change === 'config') f.daemon.services.configManager.set('permissions.mode', 'plan'); else await f.acp.stop(hosted.id);
  release.resolve();
  await until(() => f.acp.get(hosted.id)?.state === (change === 'config' ? 'idle' : 'stopped'), 'ACP cancelled admission settles');
  expect(f.acp.get(hosted.id)?.progress).not.toContain('permission granted'); expect(f.human).not.toHaveBeenCalled();
});

test('MCP revocation after the first write prevents elicitation continuation', async () => {
  const f = await fixture(); f.elicit();
  f.onAdmission(() => { if (f.calls.length) f.registry.setServerTrustMode('owned-protocol', 'blocked'); });
  await expect(f.call()).rejects.toThrow(); expect(f.calls).toHaveLength(1); expect(f.human).not.toHaveBeenCalled();
});

test('outer daemon shutdown immediately fences ACP/MCP before a blocked plugin drain', async () => {
  const f = await fixture(); const hosted = await f.spawn();
  const release = deferred(), finishDrain = deferred(); let pendingReads = 0, draining = false, mcpSettled = false;
  f.onAdmission(async args => {
    // The fixture's outer registry call has its own lifetime. Hold only the
    // actual daemon-owned external protocol admissions this shutdown retires.
    if (args[3]?.preparedCall) return;
    pendingReads++; await release.promise;
  });
  const mcp = f.call().then(value => ({ value }), error => ({ error })).finally(() => { mcpSettled = true; });
  let closing: Promise<void> | undefined;
  let held: ReturnType<typeof spyOn> | undefined;
  try {
    expect(f.acp.prompt(hosted.id, 'Original caller: write only the fixture')).toMatchObject({ queued: true });
    await until(() => pendingReads >= 2, 'ACP and MCP must both reach actual admission');
    const closePlugins = f.daemon.services.pluginManager.close.bind(f.daemon.services.pluginManager);
    held = spyOn(f.daemon.services.pluginManager, 'close').mockImplementation(async () => {
      draining = true; await finishDrain.promise; await closePlugins();
    });
    closing = f.daemon.services.close();
    await until(() => draining, 'shutdown must reach plugin drain without awaiting blocked protocol admission');
    await until(() => mcpSettled, 'shutdown must settle MCP before plugin drain');
    expect(await mcp).toHaveProperty('error');
    await until(() => f.acp.get(hosted.id)?.state === 'stopped', 'ACP shutdown must settle before plugin drain');
    expect(f.acp.get(hosted.id)?.progress).not.toContain('permission granted');
    expect(f.registry.getClient('owned-protocol')).toBeUndefined();
    expect(f.calls).toHaveLength(0); expect(f.human).not.toHaveBeenCalled();
  } finally { release.resolve(); finishDrain.resolve(); await mcp; await closing; held?.mockRestore(); }
  expect(f.acp.get(hosted.id)?.state).toBe('stopped'); expect(f.registry.getClient('owned-protocol')).toBeUndefined();
});

test('overlapping ACP prompts cannot replace the source of a pending child permission', async () => {
  const f = await fixture(); const entered = deferred(); const release = deferred();
  f.onAdmission(async () => { entered.resolve(); await release.promise; });
  const original = 'Original owner request with narrowly scoped fixture authority';
  const hosted = await f.spawn(original); await entered.promise;
  try { expect(f.acp.prompt(hosted.id, 'Replacement request cannot authorize the pending action')).toMatchObject({ queued: false }); }
  finally { release.resolve(); }
  await until(() => f.acp.get(hosted.id)?.state === 'idle', 'ACP original turn settles');
  expect(f.acp.get(hosted.id)?.progress).toContain('permission granted');
  const evidence = JSON.stringify(f.admissionSources);
  expect(evidence).toContain(original); expect(evidence).not.toContain('Replacement request'); expect(f.human).not.toHaveBeenCalled();
});

test('closed daemon owner cannot start new ACP or MCP transports', async () => {
  const f = await fixture(); const hosted = await f.spawn(); await f.daemon.services.close(); const rows = f.acp.list().length;
  await expect(f.acp.spawnAgent({ agent: { id: 'never-spawn', title: 'Must not start', binaryPath: process.execPath, args: ['--version'] }, cwd: f.daemon.workingDirectory })).rejects.toThrow();
  expect(f.acp.list()).toHaveLength(rows);
  expect(f.acp.prompt(hosted.id, 'Must not start a turn')).toMatchObject({ queued: false });
  await expect(f.daemon.daemon.registerMcpServer({ name: 'never-connect', url: 'http://127.0.0.1:1/never-connect' })).rejects.toThrow();
  expect(f.registry.serverNames).not.toContain('never-connect'); expect(f.calls).toHaveLength(0); expect(f.human).not.toHaveBeenCalled();
});

test('configured plan mode remains a deterministic refusal through the product permission manager', async () => {
  const f = await fixture(); f.daemon.services.configManager.set('permissions.mode', 'plan');
  // Consume this test's explicit setup write before starting a new handshake.
  // Later mutation tests deliberately leave their invalidation live.
  f.daemon.services.configManager.flushConfigFileChanges();
  await expect(f.call()).rejects.toThrow(); const hosted = await f.spawn('Original caller: only the synthetic file');
  await until(() => f.acp.get(hosted.id)?.state === 'idle', 'Plan-mode ACP refusal settles');
  expect(f.acp.get(hosted.id)?.progress).toContain('permission denied'); expect(f.calls).toHaveLength(0); expect(f.human).not.toHaveBeenCalled();
});

test('automatic protocol admission does not depend on an optional permission reader', async () => {
  const f = await fixture(); f.onReading(() => { throw new Error('Synthetic judgment transport unavailable'); });
  expect(await f.call()).toMatchObject({ done: true }); const hosted = await f.spawn('Original caller: only the synthetic file');
  await until(() => f.acp.get(hosted.id)?.state === 'idle', 'Unavailable reader ACP refusal settles');
  expect(f.acp.get(hosted.id)?.progress).toContain('permission granted'); expect(f.calls).toHaveLength(1); expect(f.human).not.toHaveBeenCalled();
});

test('shutdown cancels an MCP registration still negotiating and prevents a late connection', async () => {
  const f = await fixture(); const entered = deferred(); const release = deferred();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as { id: unknown }; entered.resolve(); await release.promise;
    return Response.json({ jsonrpc: '2.0', id: body.id, result: { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: { name: 'late', version: '1' } } });
  } });
  const pending = f.daemon.daemon.registerMcpServer({ name: 'late', url: `http://127.0.0.1:${server.port}/mcp` }).then(() => 'registered', () => 'cancelled');
  try {
    await entered.promise; await f.daemon.services.close(); expect(await pending).toBe('cancelled'); expect(f.registry.getClient('late')).toBeUndefined();
    release.resolve(); await new Promise(done => setImmediate(done)); expect(f.registry.getClient('late')).toBeUndefined(); expect(f.human).not.toHaveBeenCalled();
  } finally { release.resolve(); await pending; server.stop(true); }
});
