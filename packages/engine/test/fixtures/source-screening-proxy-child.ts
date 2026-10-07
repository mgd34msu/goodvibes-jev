import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createScreeningTransport } from '../../sdk/src/platform/security/source-screening/transport.ts';
import { createProtectedSourceOwner } from '../../sdk/src/platform/security/source-screening/owner.ts';

// A fresh owned process, never the shared test process. Bun's native proxy
// routing can outlive set/delete of process.env, so finally restoration alone
// cannot isolate these scenarios. All endpoints and payloads are synthetic.
const mode = process.argv[2];
const name = process.argv[3];
assert.ok(name && ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'HtTp_PrOxY', 'HtTpS_PrOxY', 'AlL_PrOxY'].includes(name));
if (mode === 'tls-reject') {
  const root = process.env.HOME;
  assert.ok(root);
  const key = join(root, 'synthetic-localhost.key');
  const cert = join(root, 'synthetic-localhost.crt');
  const generated = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-subj', '/CN=127.0.0.1', '-days', '1'], { timeout: 5_000, stdio: 'ignore' });
  assert.equal(generated.status, 0, 'owned synthetic TLS certificate generation');
  let calls = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
    tls: { key: readFileSync(key), cert: readFileSync(cert) },
    fetch() { calls++; return Response.json({ synthetic: true }); },
  });
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const url = `https://127.0.0.1:${server.port}/v1/systemone`;
  const transport = createScreeningTransport({ endpoints: [url], signal: new AbortController().signal,
    assertCurrent() {}, timeoutMs: 1_000 });
  try {
    await assert.rejects(transport.fetch(url, { method: 'POST', body: '{"synthetic":"source"}' }));
    assert.equal(calls, 0);
    console.log(JSON.stringify({ mode, proxyCalls: 0, passed: true }));
  } finally {
    await transport.close();
    await server.stop(true);
    rmSync(key, { force: true });
    rmSync(cert, { force: true });
  }
  process.exit(0);
}
let proxyCalls = 0;
let localCalls = 0;
const proxy = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { proxyCalls++; return Response.json({ proxy: true }); } });
const local = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
  localCalls++;
  if (mode === 'judgment-retry' && new URL(request.url).pathname === '/v1/chat/completions') {
    const body = await request.json() as { messages: { content: string }[] };
    const source = JSON.parse(body.messages[1]!.content) as { revision: string };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision, spans: [] }) } }] });
  }
  return new Response('{}', { status: 503 });
} });
const proxyUrl = `http://127.0.0.1:${proxy.port}`;
const base = `http://127.0.0.1:${local.port}`;
const url = `${base}/v1/systemone`;
let current = true;
let checks = 0;
const transportOptions = { endpoints: [url], signal: new AbortController().signal, timeoutMs: 1_000,
  assertCurrent() {
    if (!current) throw new Error('synthetic-private-authority');
    if (mode === 'after-authority' && ++checks === 3) process.env.HTTP_PROXY = proxyUrl;
  },
};
let transport = createScreeningTransport(transportOptions);
const post = { method: 'POST', body: '{"synthetic":"local-source"}' };
let controlProxyCalls = 0;
try {
  if (mode === 'configured') {
    process.env[name] = proxyUrl;
    process.env.NO_PROXY = '*';
    process.env.no_proxy = '127.0.0.1';
    await assert.rejects(transport.fetch(url, post), { message: 'source-screening local route is unavailable' });
    assert.equal(localCalls, 0);
  } else if (mode === 'after-authority') {
    await assert.rejects(transport.fetch(url, post), { message: 'source-screening local route is unavailable' });
    assert.equal(localCalls, 0);
  } else if (mode === 'assert-usable') {
    transport.assertUsable();
    process.env.HTTP_PROXY = proxyUrl;
    assert.throws(() => transport.assertUsable(), { message: 'source-screening local route is unavailable' });
    delete process.env.HTTP_PROXY;
    current = false;
    assert.throws(() => transport.assertUsable(), { message: 'source-screening transport authority is no longer current' });
    current = true;
    await transport.close();
    assert.throws(() => transport.assertUsable(), { message: 'source-screening transport was cancelled' });
    assert.equal(localCalls, 0);
  } else if (mode === 'next-dispatch') {
    assert.equal((await transport.fetch(url, post)).status, 503);
    process.env.HTTPS_PROXY = proxyUrl;
    await assert.rejects(transport.fetch(url, post), { message: 'source-screening local route is unavailable' });
    assert.equal(localCalls, 1);
  } else if (mode === 'stale-before-owner' || mode === 'stale-between-dispatches') {
    if (mode === 'stale-between-dispatches') assert.equal((await transport.fetch(url, post)).status, 503);
    else await transport.close();
    process.env.HTTP_PROXY = proxyUrl;
    process.env.NO_PROXY = '';
    process.env.no_proxy = '';
    assert.deepEqual(await (await fetch(url, { method: 'POST', body: '{"synthetic":"public-control"}' })).json(), { proxy: true });
    delete process.env.HTTP_PROXY;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    // Positive counterexample: the runtime's fetch STILL reaches the proxy.
    assert.deepEqual(await (await fetch(url, { method: 'POST', body: '{"synthetic":"public-control"}' })).json(), { proxy: true });
    controlProxyCalls = proxyCalls;
    assert.equal(controlProxyCalls, 2);
    if (mode === 'stale-before-owner') transport = createScreeningTransport(transportOptions);
    assert.equal((await transport.fetch(url, post)).status, 503);
    assert.equal(localCalls, mode === 'stale-before-owner' ? 1 : 2);
  } else if (mode === 'judgment-retry') {
    let retries = 0;
    const owner = createProtectedSourceOwner({
      authority: { ownerId: 'synthetic-proxy-retry', revision: '1', retention: 'ephemeral-no-log', signal: new AbortController().signal, assertCurrent() {} },
      proposal: { endpoint: base, model: 'local-fixture' }, judgment: { endpoint: base, model: 'jev-1.13.0' },
      onRetry() { retries++; process.env.HTTP_PROXY = proxyUrl; },
    });
    try {
      const result = await owner.screen(owner.capture(['Ordinary synthetic source.']));
      assert.deepEqual(result, { status: 'held', reason: 'route-unavailable' });
      assert.equal(retries, 1);
      assert.equal(localCalls, 2);
    } finally { await owner.close(); }
  } else {
    throw new Error('Unknown isolated proxy fixture mode');
  }
  assert.equal(proxyCalls - controlProxyCalls, 0);
  console.log(JSON.stringify({ mode, proxyCalls: proxyCalls - controlProxyCalls, passed: true }));
} finally {
  await transport.close();
  await local.stop(true);
  await proxy.stop(true);
}
