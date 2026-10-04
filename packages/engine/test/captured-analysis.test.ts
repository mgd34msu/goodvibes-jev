import { afterEach, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '../errors/src/index.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import { createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { capturedInputTool } from '../sdk/src/platform/tools/shared/captured-input-tools.js';
import { createAnalyzeTool } from '../sdk/src/platform/tools/analyze/index.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(root: string, ...args: string[]): string {
  const result = childProcess.spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}
async function fixture(mutable = false) {
  const root = mkdtempSync(join(tmpdir(), 'captured-analysis-')); roots.push(root);
  git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Fixture'); git(root, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(root, '.gitignore'), '.goodvibes/\n');
  writeFileSync(join(root, 'api.ts'), 'export const removedExport = "HISTORY_ONLY_MARKER";\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { 'captured-package': '^1.0.0' } }));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'before');
  const before = git(root, 'rev-parse', 'HEAD'); git(root, 'tag', 'comparison-before');
  writeFileSync(join(root, 'api.ts'), 'export const addedExport = "CAPTURED_HEAD_MARKER";\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'after');
  const after = git(root, 'rev-parse', 'HEAD');
  const snapshot = await captureContractInput(root); const view = contractInputPath(snapshot);
  git(root, 'worktree', 'add', '--no-checkout', '-b', 'captured-fixture', view, snapshot.inputCommit);
  await materializeContractInput(snapshot, view);
  const stop = new AbortController();
  const authority = await createContractInputAuthority({ inputSnapshot: snapshot, projectRoot: root } as Contract, view,
    { signal: stop.signal, mutable, branch: 'captured-fixture' });
  const denied = new Set<string>(); const reads: string[] = []; const prompts: string[] = [];
  let onRead: ((path: string) => void | Promise<void>) | undefined;
  const filter = async (path: string) => { reads.push(path); await onRead?.(path); return !denied.has(path); };
  const chat = async (prompt: string) => { prompts.push(prompt); return '{"summary":"Owned comparison.","impact":[]}'; };
  const tool = capturedInputTool(createAnalyzeTool({ chat }, undefined, view), authority, view, filter, stop.signal);
  return { root, view, before, after, authority, stop, denied, reads, prompts, filter, tool, chat,
    setOnRead(callback: typeof onRead) { onRead = callback; } };
}
for (const mode of ['diff', 'breaking', 'semantic_diff'] as const) {
  test(`captured ${mode} reuses the ordinary analyzer and identifies immutable comparison inputs`, async () => {
    const f = await fixture(); const previous = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
    try {
      const ordinary = await createAnalyzeTool({ chat: f.chat }, undefined, f.root).execute({ mode });
      const captured = await f.tool.execute({ mode });
      expect(ordinary.success).toBe(true); expect(captured.success).toBe(true);
      const live = JSON.parse(ordinary.output!); const result = JSON.parse(captured.output!);
      expect(result.comparison_inputs).toEqual({ kind: 'captured-git-comparison', captured_head: f.after,
        before: { ref: 'HEAD~1', commit: f.before }, after: { ref: 'HEAD', commit: f.after } });
      delete result.comparison_inputs; expect(result).toEqual(live);
      expect(f.reads).toContain(join(f.root, 'api.ts')); expect(f.reads).toContain(join(f.view, 'api.ts'));
      expect(f.reads.some((path) => path.includes('/.git/'))).toBe(false);
    } finally { installJudgmentPort(previous); }
  });
}
for (const control of ['original-denied', 'copy-denied', 'cancelled', 'revoked', 'original-alias'] as const) {
  test(`captured Git ${control} withholds blobs before diff and semantic providers`, async () => {
    const f = await fixture();
    if (control === 'original-denied') f.denied.add(join(f.root, 'api.ts'));
    if (control === 'copy-denied') f.denied.add(join(f.view, 'api.ts'));
    if (control === 'original-alias') { rmSync(join(f.root, 'api.ts')); symlinkSync('package.json', join(f.root, 'api.ts')); }
    f.setOnRead((path) => { if (path === join(f.root, 'api.ts')) {
      if (control === 'cancelled') f.stop.abort(); if (control === 'revoked') revokeContractInputAuthority(f.authority);
    } });
    const commands: string[][] = []; const spawn = childProcess.spawnSync;
    const tap = spyOn(childProcess, 'spawnSync').mockImplementation(((...args: Parameters<typeof childProcess.spawnSync>) => {
      if (args[0] === 'git' && Array.isArray(args[1])) commands.push(args[1] as string[]); return spawn(...args);
    }) as typeof childProcess.spawnSync);
    try {
      const result = await f.tool.execute({ mode: 'semantic_diff' });
      expect(JSON.stringify(result)).not.toContain('HISTORY_ONLY_MARKER'); expect(f.prompts).toHaveLength(0);
      expect(commands.some((args) => args.includes('diff-tree') && (args.includes('-p') || args.includes('--stat')))).toBe(false);
    } finally { tap.mockRestore(); }
  });
}
test('captured HEAD ignores later owner commits and explicit refs are pinned before path permission awaits', async () => {
  const f = await fixture();
  writeFileSync(join(f.root, 'api.ts'), 'export const ownerOnly = "LATER_OWNER_MARKER";\n');
  git(f.root, 'add', '.'); git(f.root, 'commit', '-qm', 'owner moved');
  let moved = false;
  f.setOnRead(() => { if (!moved) { moved = true; git(f.root, 'tag', '-f', 'comparison-before', 'HEAD'); } });
  const result = await f.tool.execute({ mode: 'diff', before: 'comparison-before' });
  expect(result.success).toBe(true); expect(result.output).toContain('HISTORY_ONLY_MARKER');
  expect(result.output).toContain('CAPTURED_HEAD_MARKER'); expect(result.output).not.toContain('LATER_OWNER_MARKER');
  expect(JSON.parse(result.output!).comparison_inputs.before.commit).toBe(f.before);
  expect(JSON.parse(result.output!).comparison_inputs.after.commit).toBe(f.after);
});
test('mutable captured member HEAD includes its validated descendant commits', async () => {
  const f = await fixture(true);
  writeFileSync(join(f.view, 'api.ts'), 'export const memberOnly = "MEMBER_DESCENDANT_MARKER";\n');
  git(f.view, 'add', '.'); git(f.view, 'commit', '-qm', 'member commit'); const head = git(f.view, 'rev-parse', 'HEAD');
  const result = await f.tool.execute({ mode: 'diff' });
  expect(result.success).toBe(true); expect(result.output).toContain('MEMBER_DESCENDANT_MARKER');
  expect(JSON.parse(result.output!).comparison_inputs.after.commit).toBe(head);
  expect(JSON.parse(result.output!).comparison_inputs.before.commit).toBe(f.after);
  expect(readFileSync(join(f.root, 'api.ts'), 'utf8')).not.toContain('MEMBER_DESCENDANT_MARKER');
});
test('permission revocation during semantic prose withholds output and later history delivery', async () => {
  const f = await fixture(); const previous = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
  const tool = capturedInputTool(createAnalyzeTool({ chat: async () => {
    f.denied.add(join(f.root, 'api.ts')); return 'HISTORY_ONLY_MARKER';
  } }, undefined, f.view), f.authority, f.view, f.filter, f.stop.signal);
  try {
    const result = await tool.execute({ mode: 'semantic_diff' });
    expect(result.success).toBe(false); expect(result.output).toBeUndefined();
    expect((await f.tool.execute({ mode: 'diff' })).success).toBe(false);
  } finally { installJudgmentPort(previous); }
});
for (const denied of [undefined, 'original', 'copy'] as const) {
  test(`captured upgrade reads package metadata and retains npm handling (${denied ?? 'allowed'})`, async () => {
    const f = await fixture();
    writeFileSync(join(f.root, 'package.json'), JSON.stringify({ dependencies: { 'later-owner-package': '^9.0.0' } }));
    if (denied) f.denied.add(join(denied === 'original' ? f.root : f.view, 'package.json'));
    const requests: string[] = [];
    const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      requests.push(String(url)); return Response.json({ version: '2.0.0' });
    }) as typeof globalThis.fetch);
    try {
      const result = await f.tool.execute({ mode: 'upgrade' });
      if (denied) { expect(requests).toHaveLength(0); expect(result.success).toBe(false); }
      else {
        expect(result.success).toBe(true); expect(requests).toEqual(['https://registry.npmjs.org/captured-package/latest']);
        expect(JSON.parse(result.output!).packages).toEqual([{ name: 'captured-package', current: '^1.0.0', latest: '2.0.0', breaking: true }]);
      }
      expect(JSON.stringify(result)).not.toContain('later-owner-package');
    } finally { fetch.mockRestore(); }
  });
}
test('captured upgrade cancellation reaches the existing network request and withholds its response', async () => {
  const f = await fixture(); let signal: AbortSignal | null | undefined;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (_url: string | URL | Request, init?: RequestInit) => {
    signal = init?.signal; f.stop.abort(); return Response.json({ version: '9.0.0' });
  }) as typeof globalThis.fetch);
  try {
    const result = await f.tool.execute({ mode: 'upgrade', packages: ['captured-package'] });
    expect(signal?.aborted).toBe(true); expect(result.success).toBe(false); expect(result.output).toBeUndefined();
  } finally { fetch.mockRestore(); }
});

for (const captured of [false, true]) {
  test(`actual default engine contract-member archetype executes all historical analyze modes (${captured ? 'captured' : 'ordinary control'})`, async () => {
    const { ConfigManager } = await import('../sdk/src/platform/config/index.js');
    const { createClientRuntimeServices } = await import('../sdk/src/platform/runtime/bootstrap.js');
    const { createRuntimeStore, RuntimeEventBus } = await import('../sdk/src/platform/runtime/state.js');
    const { createLaunchTolerantProviderRegistry } = await import('../sdk/src/platform/providers/index.js');
    const { unitTemplate } = await import('../sdk/src/platform/contract/workstreams.js');
    const f = await fixture(true);
    const config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(f.root, '.goodvibes', 'cfg'), workingDir: f.root, homeDir: f.root });
    config.set('permissions.engine', 'policy-engine'); config.set('permissions.mode', 'prompt');
    const runtime = createClientRuntimeServices({ surfaceRoot: 'agent', configManager: config, workingDir: f.root,
      homeDirectory: f.root, runtimeBus: new RuntimeEventBus(), runtimeStore: createRuntimeStore(),
      modelDiscovery: 'skip', providerRegistryFactory: createLaunchTolerantProviderRegistry,
      requestApproval: async () => ({ approved: true }) });
    const previous = installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
    const prose = spyOn(runtime.toolLLM, 'chat').mockResolvedValue('DEFAULT_MEMBER_SEMANTIC_SUMMARY');
    const modes = ['diff', 'breaking', 'semantic_diff', 'upgrade'];
    const requests: string[] = [];
    runtime.providerRegistry.registerRuntimeProvider({ provider: {
      name: 'analysis-fixture', models: ['fixture'], isConfigured: () => true,
      async chat(...input: unknown[]) {
        requests.push(JSON.stringify(input)); const index = requests.length - 1;
        return { content: index < modes.length ? '' : 'done',
          toolCalls: index < modes.length ? [{ id: `analysis-${index}`, name: 'analyze', arguments: { mode: modes[index] } }] : [],
          usage: { inputTokens: 1, outputTokens: 1 }, stopReason: index < modes.length ? 'tool_call' : 'completed' };
      },
    }, models: [{ id: 'fixture', provider: 'analysis-fixture', registryKey: 'analysis-fixture:fixture', displayName: 'Fixture',
      description: 'Synthetic', capabilities: { toolCalling: true, codeEditing: false, reasoning: false, multimodal: false },
      contextWindow: 16_384, selectable: true, tier: 'standard' }], replace: true });
    await runtime.providerRegistry.ready();
    const urls: string[] = [];
    const fetch = spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL | Request) => {
      urls.push(String(url)); return Response.json({ version: '2.0.0' });
    }) as typeof globalThis.fetch);
    let done!: () => void; const settled = new Promise<void>((resolve) => { done = resolve; });
    let failure: unknown; let timer: ReturnType<typeof setTimeout> | undefined;
    runtime.agentManager.setExecutor({ async runAgent(record) {
      try { await runtime.agentOrchestrator.runAgent(record); } catch (error) { failure = error; throw error; } finally { done(); }
    } });
    try {
      // No tools override: this is the same built-in engineer selected by ContractRunner's unit work item.
      const record = runtime.agentManager.spawn({ mode: 'spawn', outsideContract: true, template: unitTemplate('implement'),
        task: 'Compare the two recorded commits and package versions.', workingDirectory: captured ? f.view : f.root,
        model: 'analysis-fixture:fixture', provider: 'analysis-fixture',
        executionIntent: { filesystemPolicy: 'read-only', networkPolicy: 'allow', riskClass: 'safe' } },
      captured ? { inputReadAuthority: f.authority } : undefined);
      await Promise.race([settled, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('member did not settle')), 15_000); })]);
      expect(failure).toBeUndefined(); expect(runtime.agentManager.getStatus(record.id)!.status).toBe('completed');
      expect(requests).toHaveLength(5);
      expect(requests[1]).toContain('HISTORY_ONLY_MARKER');
      expect(requests[2]).toContain('total_breaking');
      expect(requests[3]).toContain('DEFAULT_MEMBER_SEMANTIC_SUMMARY');
      expect(requests[4]).toContain('captured-package');
      expect(urls).toEqual(['https://registry.npmjs.org/captured-package/latest']);
      if (captured) expect(requests[1]).toContain('captured-git-comparison');
      expect(requests.join('\n')).not.toContain('workflow is not yet available');
    } finally {
      if (timer) clearTimeout(timer); fetch.mockRestore(); prose.mockRestore(); runtime.dispose(); installJudgmentPort(previous);
    }
  }, 20_000);
}

test('retained captured paths and a copied scope cannot create historical read authority', async () => {
  const f = await fixture();
  const { withCapturedAnalyzeInput } = await import('../sdk/src/platform/tools/analyze/captured-git.js');
  const result = await createAnalyzeTool({ chat: f.chat }, undefined, f.view).execute({ mode: 'diff' });
  expect(result.success).toBe(false); expect(result.output).toBeUndefined();
  const scope = await withCapturedAnalyzeInput(f.authority, f.root, undefined,
    () => createAnalyzeTool({ chat: f.chat }, undefined, f.root).execute({ mode: 'diff' }));
  expect(scope.success).toBe(false); expect(scope.output).toBeUndefined();
});

test('Git attributes, external diff configuration and caller Git routing cannot run a driver or read live owner bytes', async () => {
  const f = await fixture();
  const { existsSync } = await import('node:fs');
  const marker = join(f.root, 'unexpected-driver-marker');
  const driver = join(f.root, 'driver.sh');
  writeFileSync(driver, `#!/bin/sh\necho ran > '${marker}'\necho PRIVATE_DRIVER_OUTPUT\n`, { mode: 0o755 });
  git(f.root, 'config', 'diff.external', driver);
  git(f.root, 'config', 'diff.secret.textconv', driver);
  writeFileSync(join(f.root, '.gitattributes'), '*.ts diff=secret\n');
  writeFileSync(join(f.root, 'api.ts'), 'LIVE_OWNER_BYTES_NEVER_COMPARED');
  const before = process.env.GIT_EXTERNAL_DIFF;
  process.env.GIT_EXTERNAL_DIFF = driver;
  try {
    const result = await f.tool.execute({ mode: 'diff' });
    expect(result.success).toBe(true); expect(result.output).toContain('HISTORY_ONLY_MARKER');
    expect(result.output).not.toContain('LIVE_OWNER_BYTES_NEVER_COMPARED');
    expect(result.output).not.toContain('PRIVATE_DRIVER_OUTPUT'); expect(existsSync(marker)).toBe(false);
  } finally { if (before === undefined) delete process.env.GIT_EXTERNAL_DIFF; else process.env.GIT_EXTERNAL_DIFF = before; }
});

for (const files of [['.git/config'], ['../api.ts'], [':(attr:secret)*']] as const) {
  test(`captured historical file selector remains bounded: ${files[0]}`, async () => {
    const f = await fixture();
    const result = await f.tool.execute({ mode: 'breaking', files: [...files] });
    expect(JSON.stringify(result)).not.toContain('HISTORY_ONLY_MARKER'); expect(f.prompts).toHaveLength(0);
    expect(result.output ?? result.error).toContain('unsupported captured comparison path');
  });
}

test('captured Git preserves directory file selections, HEAD alias and output provenance in summary mode', async () => {
  const f = await fixture();
  const result = await f.tool.execute({ mode: 'diff', files: ['.'], after: '@', output: { format: 'summary' } });
  expect(result.success).toBe(true);
  expect(JSON.parse(result.output!).comparison_inputs.after).toEqual({ ref: '@', commit: f.after });
});
