import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { handleChannelProfilesCommand } from '../../cli/channel-profiles-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];

function runtime(argv: readonly string[], withToken = true) {
  const root = makeProjectTempDir('gv-agent-channel-profiles-cli');
  roots.push(root);
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
  if (withToken) {
    writeFileSync(join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'channel-profiles-cli-token' }));
  }
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    workingDir: workingDirectory,
    homeDir: homeDirectory,
  });
  return {
    cli: parseGoodVibesCli(['channel-profiles', ...argv]),
    configManager,
    workingDirectory,
    homeDirectory,
  };
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('channel-profiles CLI command', () => {
  test('rejects an invalid --permission-mode before calling the connected host', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => { calls += 1; return jsonResponse({}); });
    try {
      const result = await handleChannelProfilesCommand(runtime(['set', 'slack', '--permission-mode', 'yolo', '--yes']));
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('--permission-mode must be one of');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('refuses to set a channel profile without --yes', async () => {
    const result = await handleChannelProfilesCommand(runtime(['set', 'slack', '--model', 'openai:gpt-5.4']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('without --yes');
  });

  test('reports auth_required when no connected-host token is on disk', async () => {
    const result = await handleChannelProfilesCommand(runtime(['list', '--json'], false));
    const payload = JSON.parse(result.output) as { readonly ok?: unknown; readonly kind?: unknown };
    expect(result.exitCode).toBe(1);
    expect(payload.kind).toBe('auth_required');
  });

  test('sets, lists, gets, and deletes a channel profile with confirmation', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ readonly url: string; readonly method: string; readonly body: string }> = [];
    const binding = {
      id: 'binding-1',
      surfaceKind: 'slack',
      model: 'openai:gpt-5.4',
      provider: 'openai',
      permissionMode: 'plan',
      updatedAt: 1,
    };
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = inputUrl(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : '';
      requests.push({ url, method, body });
      if (method === 'POST' && url.endsWith('/api/channels/profiles')) {
        return jsonResponse({ binding });
      }
      if (method === 'GET' && url.endsWith('/api/channels/profiles')) {
        return jsonResponse({ bindings: [binding] });
      }
      if (method === 'GET' && url.endsWith('/api/channels/profiles/slack')) {
        return jsonResponse({ binding });
      }
      if (method === 'DELETE' && url.endsWith('/api/channels/profiles/slack')) {
        return jsonResponse({ surfaceKind: 'slack', deleted: true });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });

    try {
      const setResult = await handleChannelProfilesCommand(runtime([
        'set', 'slack', '--model', 'openai:gpt-5.4', '--provider', 'openai', '--permission-mode', 'plan', '--yes',
      ]));
      expect(setResult.exitCode).toBe(0);
      expect(setResult.output).toContain('Set channel profile binding-1');
      const setBody = JSON.parse(requests[0]!.body) as { readonly surfaceKind?: unknown; readonly permissionMode?: unknown };
      expect(setBody.surfaceKind).toBe('slack');
      expect(setBody.permissionMode).toBe('plan');

      const listed = await handleChannelProfilesCommand(runtime(['list']));
      expect(listed.exitCode).toBe(0);
      expect(listed.output).toContain('Channel profiles (1)');
      expect(listed.output).toContain('slack');

      const got = await handleChannelProfilesCommand(runtime(['get', 'slack']));
      expect(got.exitCode).toBe(0);
      expect(got.output).toContain('Channel profile binding-1');
      expect(got.output).toContain('permission mode plan');

      const withoutYes = await handleChannelProfilesCommand(runtime(['delete', 'slack']));
      expect(withoutYes.exitCode).toBe(2);

      const deleted = await handleChannelProfilesCommand(runtime(['delete', 'slack', '--yes']));
      expect(deleted.exitCode).toBe(0);
      expect(deleted.output).toContain('Deleted channel profile slack');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
