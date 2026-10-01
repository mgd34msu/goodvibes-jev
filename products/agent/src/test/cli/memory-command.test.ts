import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { handleGoodVibesCliCommand, parseGoodVibesCli } from '../../cli/index.ts';
import { renderGoodVibesCommandHelp, renderGoodVibesHelp } from '../../cli/help.ts';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/sdk/platform/state';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];

// The `memory` CLI command now probes for a reachable connected daemon (the
// default controlPlane.host:port) before every wire-eligible subcommand and
// routes over the wire when one answers (see memory-command-wire.ts). These
// fixtures deliberately have no daemon and exercise the local-direct fallback,
// so `fetch` is stubbed to fail fast for the whole file. This must NEVER dial a
// real daemon that happens to be running on the developer's machine at the
// default port; it always fails the probe instead, exactly like "no daemon".
const originalFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = mockFetch(async () => {
    throw new Error('network disabled in this test file; memory CLI tests exercise the local-direct fallback only');
  });
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function runCli(args: readonly string[], root?: string, homeRoot?: string): Promise<{
  readonly exitCode: number;
  readonly output: string;
}> {
  const workingRoot = root ?? makeProjectTempDir('goodvibes-agent-memory-cli');
  const homeDirectory = homeRoot ?? workingRoot;
  if (!root) roots.push(workingRoot);
  const output: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (value?: unknown) => { output.push(String(value)); };
    const result = await handleGoodVibesCliCommand({
      cli: parseGoodVibesCli(args),
      configManager: new ConfigManager({ workingDir: workingRoot, homeDir: homeDirectory, surfaceRoot: 'agent' }),
      workingDirectory: workingRoot,
      homeDirectory,
    });
    return {
      exitCode: result.exitCode,
      output: output.join('\n'),
    };
  } finally {
    console.log = originalLog;
  }
}

function parseJson<T>(text: string): T {
  return JSON.parse(text) as T;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Agent memory CLI command', () => {
  test('parses memory command aliases without accepting copied recall as a CLI command', () => {
    expect(parseGoodVibesCli(['memory', 'list']).command).toBe('memory');
    expect(parseGoodVibesCli(['memories', 'list']).command).toBe('memory');
    expect(parseGoodVibesCli(['recall', 'list']).command).not.toBe('memory');
  });

  test('adds lists searches reviews and deletes Agent-owned memory', async () => {
    const root = makeProjectTempDir('goodvibes-agent-memory-flow');
    roots.push(root);

    const created = await runCli([
      'memory',
      'add',
      'fact',
      'Prefers concise morning briefings',
      '--scope',
      'project',
      '--tags',
      'preference,briefing',
      '--confidence',
      '87',
      '--json',
    ], root);
    expect(created.exitCode).toBe(0);
    const createdJson = parseJson<{
      readonly kind: string;
      readonly data: { readonly id: string; readonly scope: string; readonly cls: string; readonly confidence: number };
    }>(created.output);
    expect(createdJson.kind).toBe('agent.memory.add');
    expect(createdJson.data.scope).toBe('project');
    expect(createdJson.data.cls).toBe('fact');
    expect(createdJson.data.confidence).toBe(87);

    const listed = await runCli(['memory', 'list'], root);
    expect(listed.exitCode).toBe(0);
    expect(listed.output).toContain('Agent memory (1)');
    expect(listed.output).toContain('Prefers concise morning briefings');
    expect(listed.output).toContain('.goodvibes/shared/memory.sqlite');

    const searched = await runCli(['memory', 'search', 'morning'], root);
    expect(searched.exitCode).toBe(0);
    expect(searched.output).toContain(createdJson.data.id);

    const shown = await runCli(['memory', 'show', createdJson.data.id], root);
    expect(shown.exitCode).toBe(0);
    expect(shown.output).toContain(`Memory ${createdJson.data.id}`);
    expect(shown.output).toContain('class: fact');

    const reviewed = await runCli(['memory', 'review', createdJson.data.id, 'reviewed', '--confidence', '92', '--json'], root);
    expect(reviewed.exitCode).toBe(0);
    const reviewedJson = parseJson<{ readonly kind: string; readonly data: { readonly reviewState: string; readonly confidence: number } }>(reviewed.output);
    expect(reviewedJson.kind).toBe('agent.memory.review');
    expect(reviewedJson.data.reviewState).toBe('reviewed');
    expect(reviewedJson.data.confidence).toBe(92);

    const refused = await runCli(['memory', 'delete', createdJson.data.id], root);
    expect(refused.exitCode).toBe(2);
    expect(refused.output).toContain('without --yes');

    const deleted = await runCli(['memory', 'delete', createdJson.data.id, '--yes'], root);
    expect(deleted.exitCode).toBe(0);
    expect(deleted.output).toContain(`Agent memory deleted: ${createdJson.data.id}`);
  });

  test('exports inspects and imports Agent memory bundles', async () => {
    const root = makeProjectTempDir('goodvibes-agent-memory-bundle');
    roots.push(root);
    const bundlePath = join(root, 'handoff', 'agent-memory.json');

    const created = await runCli(['memory', 'add', 'runbook', 'Check approvals before schedule promotion', '--json'], root);
    const id = parseJson<{ readonly data: { readonly id: string } }>(created.output).data.id;

    const refusedExport = await runCli(['memory', 'export', bundlePath], root);
    expect(refusedExport.exitCode).toBe(2);
    expect(refusedExport.output).toContain('without --yes');
    expect(existsSync(bundlePath)).toBe(false);

    const exported = await runCli(['memory', 'export', bundlePath, '--yes'], root);
    expect(exported.exitCode).toBe(0);
    expect(existsSync(bundlePath)).toBe(true);

    const inspected = await runCli(['memory', 'handoff-inspect', bundlePath], root);
    expect(inspected.exitCode).toBe(0);
    expect(inspected.output).toContain('Agent memory handoff bundle');
    expect(inspected.output).toContain(id);

    const deleted = await runCli(['memory', 'delete', id, '--yes'], root);
    expect(deleted.exitCode).toBe(0);

    const refusedImport = await runCli(['memory', 'import', bundlePath], root);
    expect(refusedImport.exitCode).toBe(2);
    expect(refusedImport.output).toContain('without --yes');

    const imported = await runCli(['memory', 'import', bundlePath, '--yes'], root);
    expect(imported.exitCode).toBe(0);
    expect(imported.output).toContain('Agent memory imported: 1 record');
  });

  test('stores memory under the Agent home instead of the workspace', async () => {
    const workspace = makeProjectTempDir('goodvibes-agent-memory-workspace');
    const home = makeProjectTempDir('goodvibes-agent-memory-home');
    roots.push(workspace, home);

    const listed = await runCli(['memory', 'list'], workspace, home);

    expect(listed.exitCode).toBe(0);
    expect(listed.output).toContain(`${home}/.goodvibes/shared/memory.sqlite`);
    expect(listed.output).not.toContain(`${workspace}/.goodvibes/shared/memory.sqlite`);
  });

  test('CLI-added memory lands in the canonical cross-surface store, not a private agent-only store', async () => {
    const home = makeProjectTempDir('goodvibes-agent-memory-canonical');
    roots.push(home);

    const created = await runCli(['memory', 'add', 'fact', 'Canonical store cross-surface fact', '--json'], home, home);
    expect(created.exitCode).toBe(0);

    // The CLI must write to the same store identity the runtime and TUI read from
    // (resolveCanonicalMemoryDbPath), never to a private agent-only memory.sqlite.
    expect(existsSync(join(home, '.goodvibes', 'shared', 'memory.sqlite'))).toBe(true);
    expect(existsSync(join(home, '.goodvibes', 'agent', 'memory.sqlite'))).toBe(false);

    const canonicalStore = new MemoryStore(join(home, '.goodvibes', 'shared', 'memory.sqlite'), {
      embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ workingDir: home, homeDir: home, surfaceRoot: 'agent' }) }),
    });
    const registry = new MemoryRegistry(canonicalStore);
    await canonicalStore.init();
    try {
      const records = registry.search({});
      expect(records.some((record) => record.summary === 'Canonical store cross-surface fact')).toBe(true);
    } finally {
      canonicalStore.close();
    }
  });

  test('rejects secret-looking memory content', async () => {
    const result = await runCli(['memory', 'add', 'fact', 'api_key=supersecretvalue']);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Agent memory cannot store secret-looking values');
  });

  test('help advertises Agent-owned memory without non-Agent fallback', () => {
    const help = renderGoodVibesHelp();
    expect(help).toContain('memory');
    expect(help).toContain('Manage Agent-owned durable memory records');

    const memoryHelp = renderGoodVibesCommandHelp('memory');
    expect(memoryHelp).toContain('GoodVibes Agent memory');
    expect(memoryHelp).toContain('memory add');
    expect(memoryHelp).toContain('never falls back to default knowledge or non-Agent knowledge segments');
  });
});
