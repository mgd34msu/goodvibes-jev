import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { handleCiCommand } from '../../cli/ci-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];

function runtime(argv: readonly string[], withToken = true) {
  const root = makeProjectTempDir('gv-agent-ci-cli');
  roots.push(root);
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
  if (withToken) {
    writeFileSync(join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'ci-cli-token' }));
  }
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    workingDir: workingDirectory,
    homeDir: homeDirectory,
  });
  return {
    cli: parseGoodVibesCli(['ci', ...argv]),
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

describe('ci CLI command', () => {
  test('requires a repo for status', async () => {
    const result = await handleCiCommand(runtime(['status']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('Usage: goodvibes-agent ci status');
  });

  test('reports auth_required when no connected-host token is on disk', async () => {
    const result = await handleCiCommand({ ...runtime(['status', 'my-org/my-repo', '--json'], false) });
    const payload = JSON.parse(result.output) as { readonly ok?: unknown; readonly kind?: unknown };
    expect(result.exitCode).toBe(1);
    expect(payload.ok).toBe(false);
    expect(payload.kind).toBe('auth_required');
  });

  test('renders per-job status, not just the overall rollup', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ readonly url: string; readonly method: string; readonly body: string }> = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      requests.push({ url: inputUrl(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '' });
      return jsonResponse({
        report: {
          repo: 'my-org/my-repo',
          ref: 'main',
          overall: 'failed',
          jobs: [
            { name: 'build', status: 'completed', conclusion: 'success' },
            { name: 'test', status: 'completed', conclusion: 'failure', continueOnError: false },
          ],
          violations: ['job "test" failed'],
          checkedAt: 1_700_000_000_000,
        },
      });
    });
    try {
      const result = await handleCiCommand(runtime(['status', 'my-org/my-repo', '--ref', 'main']));
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain('overall failed');
      expect(result.output).toContain('build');
      expect(result.output).toContain('status completed');
      expect(result.output).toContain('conclusion success');
      expect(result.output).toContain('test');
      expect(result.output).toContain('conclusion failure');
      expect(result.output).toContain('violations: job "test" failed');
      expect(requests).toHaveLength(1);
      expect(requests[0]!.url).toBe('http://127.0.0.1:3421/api/ci/status');
      expect(requests[0]!.method).toBe('POST');
      const body = JSON.parse(requests[0]!.body) as { readonly repo?: unknown; readonly ref?: unknown };
      expect(body.repo).toBe('my-org/my-repo');
      expect(body.ref).toBe('main');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('refuses to create a CI watch without --yes', async () => {
    const result = await handleCiCommand(runtime(['watches', 'create', 'my-org/my-repo', '--delivery-channel', 'slack:C123']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('without --yes');
  });

  test('creates, lists, runs, and deletes a CI watch with confirmation', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ readonly url: string; readonly method: string; readonly body: string }> = [];
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = inputUrl(input);
      const method = init?.method ?? 'GET';
      requests.push({ url, method, body: typeof init?.body === 'string' ? init.body : '' });
      if (method === 'POST' && url.endsWith('/api/ci/watches')) {
        return jsonResponse({
          watch: {
            id: 'watch-1',
            repo: 'my-org/my-repo',
            ref: 'main',
            deliveryChannel: 'slack:C123',
            triggerFixSession: true,
            lastOverall: 'unknown',
            createdAt: 1,
            updatedAt: 1,
          },
        });
      }
      if (method === 'GET' && url.endsWith('/api/ci/watches')) {
        return jsonResponse({
          watches: [{
            id: 'watch-1',
            repo: 'my-org/my-repo',
            ref: 'main',
            deliveryChannel: 'slack:C123',
            triggerFixSession: true,
            lastOverall: 'passed',
            createdAt: 1,
            updatedAt: 1,
          }],
        });
      }
      if (method === 'POST' && url.endsWith('/api/ci/watches/watch-1/run')) {
        return jsonResponse({
          report: {
            repo: 'my-org/my-repo',
            ref: 'main',
            overall: 'passed',
            jobs: [{ name: 'build', status: 'completed', conclusion: 'success' }],
            violations: [],
            checkedAt: 2,
          },
          notified: true,
          notificationId: 'notif-1',
          fixSessionTriggered: false,
        });
      }
      if (method === 'DELETE' && url.endsWith('/api/ci/watches/watch-1')) {
        return jsonResponse({ watchId: 'watch-1', deleted: true });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });

    try {
      const created = await handleCiCommand(runtime(['watches', 'create', 'my-org/my-repo', '--ref', 'main', '--delivery-channel', 'slack:C123', '--trigger-fix-session', '--yes']));
      expect(created.exitCode).toBe(0);
      expect(created.output).toContain('Created CI watch watch-1');
      const createBody = JSON.parse(requests[0]!.body) as { readonly deliveryChannel?: unknown; readonly triggerFixSession?: unknown };
      expect(createBody.deliveryChannel).toBe('slack:C123');
      expect(createBody.triggerFixSession).toBe(true);

      const listed = await handleCiCommand(runtime(['watches', 'list']));
      expect(listed.exitCode).toBe(0);
      expect(listed.output).toContain('CI watches (1)');
      expect(listed.output).toContain('watch-1');

      const ran = await handleCiCommand(runtime(['watches', 'run', 'watch-1']));
      expect(ran.exitCode).toBe(0);
      expect(ran.output).toContain('overall passed');
      expect(ran.output).toContain('notified yes (notif-1)');
      expect(ran.output).toContain('fix session triggered no');

      const withoutYes = await handleCiCommand(runtime(['watches', 'delete', 'watch-1']));
      expect(withoutYes.exitCode).toBe(2);
      expect(withoutYes.output).toContain('without --yes');

      const deleted = await handleCiCommand(runtime(['watches', 'delete', 'watch-1', '--yes']));
      expect(deleted.exitCode).toBe(0);
      expect(deleted.output).toContain('Deleted CI watch watch-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
