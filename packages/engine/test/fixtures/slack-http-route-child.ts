import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'undici/index.js';
import { createSlackInboxHttpOwner } from '../../sdk/src/platform/intake/providers/slack-http.ts';

// Every endpoint and credential is synthetic and owned. Proxy/TLS mutations
// live only in this canonical-network-guarded child; restoring process.env
// cannot reset Bun's native proxy cache in the shared parent test process.
const mode = process.argv[2];
const name = process.argv[3];
assert.ok(name && ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'HtTp_PrOxY', 'HtTpS_PrOxY', 'AlL_PrOxY'].includes(name));
const url = new URL('https://slack.com/api/auth.test');
const request = { method: 'GET' as const, headers: { Authorization: 'Bearer xoxb-synthetic-owned-fixture', Accept: 'application/json' as const } };

if (mode === 'tls-reject') {
  const root = process.env.HOME;
  assert.ok(root);
  const key = join(root, 'synthetic-slack-localhost.key');
  const cert = join(root, 'synthetic-slack-localhost.crt');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1', '-days', '1'], { timeout: 5_000, stdio: 'ignore' });
  assert.equal(generated.status, 0, 'owned synthetic TLS certificate generation');
  let calls = 0;
  const local = Bun.serve({ hostname: '127.0.0.1', port: 0, tls: { key: readFileSync(key), cert: readFileSync(cert) },
    fetch() { calls++; return Response.json({ ok: true }); } });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const owner = createSlackInboxHttpOwner({ signal: new AbortController().signal, assertCurrent() {}, timeoutMs: 1_000,
    createClient(origin, options) { assert.equal(origin, 'https://slack.com'); return new Client(`https://127.0.0.1:${local.port}`, options); } });
  try {
    await assert.rejects(owner.http(url, request), { message: 'Slack HTTP response is unavailable' });
    assert.equal(calls, 0);
    console.log(JSON.stringify({ mode, passed: true, proxyCalls: 0 }));
  } finally {
    await owner.close(); await local.stop(true);
    rmSync(key, { force: true }); rmSync(cert, { force: true });
  }
  process.exit(0);
}

let proxyCalls = 0; let localCalls = 0;
const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { proxyCalls++; return Response.json({ syntheticProxy: true }); } });
const local = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { localCalls++; return Response.json({ ok: true }); } });
const proxyUrl = `http://127.0.0.1:${proxy.port}`;
const base = `http://127.0.0.1:${local.port}`;
let checks = 0;
const options = { signal: new AbortController().signal, timeoutMs: 1_000,
  assertCurrent() { if (mode === 'after-authority' && ++checks === 2) process.env.HTTP_PROXY = proxyUrl; },
  createClient(origin: 'https://slack.com', settings: Client.Options) { assert.equal(origin, 'https://slack.com'); return new Client(base, settings); },
};
let owner = createSlackInboxHttpOwner(options);
let controlProxyCalls = 0;
try {
  if (mode === 'configured') {
    process.env[name] = proxyUrl; process.env.NO_PROXY = '*'; process.env.no_proxy = '127.0.0.1';
    await assert.rejects(owner.http(url, request), { message: 'Slack HTTP direct route is unavailable' });
    assert.equal(localCalls, 0);
  } else if (mode === 'after-authority') {
    await assert.rejects(owner.http(url, request), { message: 'Slack HTTP direct route is unavailable' });
    assert.equal(localCalls, 0);
  } else if (mode === 'between-calls') {
    assert.deepEqual(await owner.http(url, request), { ok: true, body: { ok: true } });
    process.env.HTTPS_PROXY = proxyUrl;
    await assert.rejects(owner.http(url, request), { message: 'Slack HTTP direct route is unavailable' });
    assert.equal(localCalls, 1);
  } else if (mode === 'stale-before-owner' || mode === 'stale-between-calls') {
    if (mode === 'stale-between-calls') assert.deepEqual(await owner.http(url, request), { ok: true, body: { ok: true } });
    else await owner.close();
    process.env.HTTP_PROXY = proxyUrl; process.env.NO_PROXY = ''; process.env.no_proxy = '';
    // Positive counterexample: global fetch keeps reaching this owned proxy
    // after deletion. The secret-bearing owner below must bypass that cache.
    assert.deepEqual(await (await fetch(`${base}/public-control`)).json(), { syntheticProxy: true });
    delete process.env.HTTP_PROXY; delete process.env.NO_PROXY; delete process.env.no_proxy;
    assert.deepEqual(await (await fetch(`${base}/public-control`)).json(), { syntheticProxy: true });
    controlProxyCalls = proxyCalls; assert.equal(controlProxyCalls, 2);
    if (mode === 'stale-before-owner') owner = createSlackInboxHttpOwner(options);
    assert.deepEqual(await owner.http(url, request), { ok: true, body: { ok: true } });
    assert.equal(localCalls, mode === 'stale-before-owner' ? 1 : 2);
  } else throw new Error('Unknown isolated Slack route fixture mode');
  assert.equal(proxyCalls - controlProxyCalls, 0);
  console.log(JSON.stringify({ mode, passed: true, proxyCalls: proxyCalls - controlProxyCalls }));
} finally { await owner.close(); await local.stop(true); await proxy.stop(true); }
