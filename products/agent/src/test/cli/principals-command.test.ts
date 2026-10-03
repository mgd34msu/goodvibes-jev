import { mockFetch } from '../helpers/typed-fetch-mock.ts';
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { handlePrincipalsCommand } from '../../cli/principals-command.ts';
import { parseGoodVibesCli } from '../../cli/parser.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];

function runtime(argv: readonly string[], withToken = true) {
  const root = makeProjectTempDir('gv-agent-principals-cli');
  roots.push(root);
  const workingDirectory = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(join(homeDirectory, '.goodvibes', 'daemon'), { recursive: true });
  if (withToken) {
    writeFileSync(join(homeDirectory, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'principals-cli-token' }));
  }
  const configManager = new ConfigManager({
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
    workingDir: workingDirectory,
    homeDir: homeDirectory,
  });
  return {
    cli: parseGoodVibesCli(['principals', ...argv]),
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

describe('principals CLI command', () => {
  test('rejects an invalid --kind before calling the connected host', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockFetch(async () => { calls += 1; return jsonResponse({}); });
    try {
      const result = await handlePrincipalsCommand(runtime(['create', '--name', 'Mike', '--kind', 'robot', '--yes']));
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain('--kind must be one of');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('refuses to create a principal without --yes', async () => {
    const result = await handlePrincipalsCommand(runtime(['create', '--name', 'Mike', '--kind', 'user']));
    expect(result.exitCode).toBe(2);
    expect(result.output).toContain('without --yes');
  });

  test('reports auth_required when no connected-host token is on disk', async () => {
    const result = await handlePrincipalsCommand(runtime(['list', '--json'], false));
    const payload = JSON.parse(result.output) as { readonly ok?: unknown; readonly kind?: unknown };
    expect(result.exitCode).toBe(1);
    expect(payload.kind).toBe('auth_required');
  });

  test('creates, lists, gets, updates, and deletes a principal with confirmation', async () => {
    const originalFetch = globalThis.fetch;
    const requests: Array<{ readonly url: string; readonly method: string; readonly body: string }> = [];
    let principal = {
      id: 'principal-1',
      name: 'Mike Davis',
      kind: 'user',
      identities: [{ channel: 'slack', value: 'U123' }],
      createdAt: 1,
      updatedAt: 1,
    };
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = inputUrl(input);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? init.body : '';
      requests.push({ url, method, body });
      if (method === 'POST' && url.endsWith('/api/principals')) {
        return jsonResponse({ principal });
      }
      if (method === 'GET' && url.endsWith('/api/principals')) {
        return jsonResponse({ principals: [principal] });
      }
      if (method === 'GET' && url.endsWith('/api/principals/principal-1')) {
        return jsonResponse({ principal });
      }
      if (method === 'POST' && url.endsWith('/api/principals/principal-1/update')) {
        principal = { ...principal, name: 'Michael Davis' };
        return jsonResponse({ principal });
      }
      if (method === 'DELETE' && url.endsWith('/api/principals/principal-1')) {
        return jsonResponse({ principalId: 'principal-1', deleted: true });
      }
      if (method === 'POST' && url.endsWith('/api/principals/resolve')) {
        const parsedBody = JSON.parse(body) as { readonly channel?: string; readonly value?: string };
        if (parsedBody.channel === 'slack' && parsedBody.value === 'U123') return jsonResponse({ principal, known: true });
        return jsonResponse({ principal, known: false });
      }
      throw new Error(`unexpected request ${method} ${url}`);
    });

    try {
      const created = await handlePrincipalsCommand(runtime([
        'create', '--name', 'Mike Davis', '--kind', 'user', '--identity', 'slack:U123,email:mike@example.com', '--yes',
      ]));
      expect(created.exitCode).toBe(0);
      expect(created.output).toContain('Created principal principal-1');
      const createBody = JSON.parse(requests[0]!.body) as { readonly identities?: readonly { readonly channel: string; readonly value: string }[] };
      expect(createBody.identities).toEqual([{ channel: 'slack', value: 'U123' }, { channel: 'email', value: 'mike@example.com' }]);

      const listed = await handlePrincipalsCommand(runtime(['list']));
      expect(listed.exitCode).toBe(0);
      expect(listed.output).toContain('Principals (1)');
      expect(listed.output).toContain('Mike Davis');

      const got = await handlePrincipalsCommand(runtime(['get', 'principal-1']));
      expect(got.exitCode).toBe(0);
      expect(got.output).toContain('Principal principal-1');
      expect(got.output).toContain('slack:U123');

      const updated = await handlePrincipalsCommand(runtime(['update', 'principal-1', '--name', 'Michael Davis', '--yes']));
      expect(updated.exitCode).toBe(0);
      expect(updated.output).toContain('Michael Davis');

      const resolvedKnown = await handlePrincipalsCommand(runtime(['resolve', '--channel', 'slack', '--value', 'U123']));
      expect(resolvedKnown.exitCode).toBe(0);
      expect(resolvedKnown.output).toContain('known: true');

      const resolvedUnknown = await handlePrincipalsCommand(runtime(['resolve', '--channel', 'slack', '--value', 'U999']));
      expect(resolvedUnknown.exitCode).toBe(0);
      expect(resolvedUnknown.output).toContain('known: false');
      expect(resolvedUnknown.output).not.toContain('Principal principal-1');

      const withoutYes = await handlePrincipalsCommand(runtime(['delete', 'principal-1']));
      expect(withoutYes.exitCode).toBe(2);

      const deleted = await handlePrincipalsCommand(runtime(['delete', 'principal-1', '--yes']));
      expect(deleted.exitCode).toBe(0);
      expect(deleted.output).toContain('Deleted principal principal-1');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
