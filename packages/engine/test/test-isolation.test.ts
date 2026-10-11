import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { isolatedTestEnvironment } from '../scripts/test-isolation.ts';
import { RUNNER_ENV_FLAG } from '../scripts/test-run-tmp.ts';
import { installTestNetworkGuard, TestExternalNetworkError } from '../scripts/test-network-guard.ts';
import { runOwnedTestChild } from '../scripts/owned-test-child.ts';

const roots: string[] = [];
let restore: (() => void) | undefined;
afterEach(() => {
  restore?.(); restore = undefined;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'test-isolation-'));
  roots.push(directory);
  return directory;
}

test('child env isolates persisted state and inherited credentials while retaining explicit fixture values', () => {
  const directory = root();
  const env = isolatedTestEnvironment({
    PATH: '/bin', CI: 'true', GOODVIBES_TEST_TIMEOUT_MS: '123', [RUNNER_ENV_FLAG]: '1', GOODVIBES_SDK_PRIVATE_CONFIG: '/real/private',
    GOODVIBES_SDK_DEV_ROUNDTRIP_TEST: '1',
    OPENAI_API_KEY: 'private-key', ABACUS_API_KEY: 'private-key', TYPESAFE_API_KEY: 'private-key',
    HTTP_PROXY: 'https://private-proxy', NODE_OPTIONS: '--require=private', GIT_CEILING_DIRECTORIES: '/inherited-git-ceiling',
    HOME: '/real/home', XDG_CONFIG_HOME: '/real/config', GOODVIBES_DAEMON_HOME: '/real/daemon',
  }, directory, { TYPESAFE_API_KEY: 'declared-fixture', FIXTURE_MARKER: 'keep' });
  expect(env.PATH).toBe('/bin');
  expect(env.GOODVIBES_TEST_TIMEOUT_MS).toBe('123');
  expect(env[RUNNER_ENV_FLAG]).toBe('1');
  expect(env.GOODVIBES_SDK_DEV_ROUNDTRIP_TEST).toBe('1');
  expect(env.GOODVIBES_SDK_PRIVATE_CONFIG).toBeUndefined();
  expect(env.TYPESAFE_API_KEY).toBe('declared-fixture');
  expect(env.FIXTURE_MARKER).toBe('keep');
  for (const key of ['OPENAI_API_KEY', 'ABACUS_API_KEY', 'HTTP_PROXY', 'NODE_OPTIONS', 'GOODVIBES_DAEMON_HOME', 'GIT_CEILING_DIRECTORIES']) expect(env[key]).toBeUndefined();
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR']) {
    expect(env[key]!.startsWith(`${directory}/`)).toBe(true);
    expect(existsSync(env[key]!)).toBe(true);
  }
});

test('fetch rejects external URLs before delegation and diagnostics contain no credentials or payload', async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = Object.assign(async () => { calls++; return new Response('fixture'); }, { preconnect: () => {} });
  const violations: string[] = [];
  const undo = installTestNetworkGuard((diagnostic) => violations.push(diagnostic));
  restore = () => { undo(); globalThis.fetch = previousFetch; };
  await expect(fetch('https://user:password@outside.invalid/private-path?token=secret', {
    method: 'POST', headers: { Authorization: 'private-header' }, body: 'private-body',
  })).rejects.toBeInstanceOf(TestExternalNetworkError);
  expect(calls).toBe(0);
  expect(violations).toEqual(['Unexpected external fetch POST in ordinary tests: https://outside.invalid']);
  await expect((await fetch('http://127.0.0.1:9876/local')).text()).resolves.toBe('fixture');
  expect(calls).toBe(1);
});

test('TCP, TLS, Bun TCP and WebSocket requests are refused before connection', () => {
  const violations: string[] = [];
  restore = installTestNetworkGuard((diagnostic) => violations.push(diagnostic));
  expect(() => net.connect({ host: 'outside.invalid', port: 443 })).toThrow(TestExternalNetworkError);
  expect(() => tls.connect({ host: 'outside.invalid', port: 443 })).toThrow(TestExternalNetworkError);
  expect(() => tls.connect(443, { host: 'outside.invalid' })).toThrow(TestExternalNetworkError);
  expect(() => Bun.connect({ hostname: 'outside.invalid', port: 443, socket: { data() {}, open() {}, close() {}, error() {} } })).toThrow(TestExternalNetworkError);
  expect(() => new WebSocket('wss://outside.invalid/private?token=secret')).toThrow(TestExternalNetworkError);
  expect(violations).toHaveLength(5);
  expect(violations.join('\n')).not.toContain('token');
});

test('real loopback fixture servers and local redirects still work, external redirect hops do not', async () => {
  const violations: string[] = [];
  restore = installTestNetworkGuard((diagnostic) => violations.push(diagnostic));
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/local') return new Response(null, { status: 302, headers: { location: '/done' } });
      if (path === '/external') return new Response(null, { status: 302, headers: { location: 'https://outside.invalid/private?token=secret' } });
      return new Response(`${request.method} done`);
    },
  });
  try {
    expect(await (await fetch(`http://127.0.0.1:${server.port}/local`, { method: 'POST', body: 'test' })).text()).toBe('GET done');
    await expect(fetch(`http://127.0.0.1:${server.port}/external`)).rejects.toBeInstanceOf(TestExternalNetworkError);
    expect(violations).toEqual(['Unexpected external fetch GET redirect in ordinary tests: https://outside.invalid']);
  } finally { server.stop(true); }
});

test('existing test mocks may replace and restore the guarded fetch', async () => {
  const violations: string[] = [];
  restore = installTestNetworkGuard((diagnostic) => violations.push(diagnostic));
  const guarded = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Response('mock'), { preconnect: () => {} });
  try { expect(await (await fetch('https://outside.invalid')).text()).toBe('mock'); }
  finally { globalThis.fetch = guarded; }
  await expect(fetch('https://outside.invalid')).rejects.toBeInstanceOf(TestExternalNetworkError);
  expect(violations).toHaveLength(1);
});

test('the owned runner ignores dotenv, isolates home, preserves fixture env, and cleans it up', async () => {
  const directory = root();
  const marker = join(directory, 'home-path');
  const fixture = join(directory, 'isolation.test.ts');
  writeFileSync(join(directory, '.env'), 'TYPESAFE_API_KEY=dotenv-secret\nDOTENV_MARKER=should-not-load\n');
  writeFileSync(fixture, `
    import { test, expect } from 'bun:test'; import { writeFileSync } from 'node:fs';
    test('isolated environment', () => {
      expect(process.env.OPENAI_API_KEY).toBeUndefined();
      expect(process.env.DOTENV_MARKER).toBeUndefined();
      expect(process.env.FIXTURE_MARKER).toBe('declared');
      expect(process.env.GIT_CEILING_DIRECTORIES?.split(${JSON.stringify(delimiter)}).sort()).toEqual([
        process.env.GOODVIBES_TEST_OWNED_TMP_ROOT,
        ${JSON.stringify(join(directory, 'fixture-ceiling'))},
      ].sort());
      expect(process.env[${JSON.stringify(RUNNER_ENV_FLAG)}]).toBe('1');
      expect(process.env.GOODVIBES_SDK_DEV_ROUNDTRIP_TEST).toBe('1');
      writeFileSync(${JSON.stringify(marker)}, process.env.HOME!);
    });
  `);
  const result = await runOwnedTestChild({ argv: [fixture], cwd: directory, env: { ...process.env, GIT_CEILING_DIRECTORIES: '/inherited-git-ceiling', OPENAI_API_KEY: 'inherited-secret', [RUNNER_ENV_FLAG]: '1', GOODVIBES_SDK_DEV_ROUNDTRIP_TEST: '1' }, fixtureEnv: { FIXTURE_MARKER: 'declared', GIT_CEILING_DIRECTORIES: join(directory, 'fixture-ceiling') } });
  expect(result.exitCode).toBe(0);
  const childHome = await Bun.file(marker).text();
  expect(childHome).not.toBe(process.env.HOME);
  expect(existsSync(childHome)).toBe(false);
});

test('a swallowed blocked request still fails the owned runner with sanitized diagnostics', async () => {
  const directory = root();
  const fixture = join(directory, 'blocked.test.ts');
  writeFileSync(fixture, `import { test } from 'bun:test'; test('caught network error', async () => { await fetch('https://outside.invalid/private?token=secret').catch(() => undefined); });`);
  const result = await runOwnedTestChild({ argv: [fixture], cwd: directory, env: process.env });
  expect(result.exitCode).toBe(1);
});
