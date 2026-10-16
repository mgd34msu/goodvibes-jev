import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RateLimiter } from '../sdk/src/platform/daemon/http/rate-limiter.ts';
import { serveWebuiBundle, type WebuiServingPosture } from '../sdk/src/platform/daemon/http/webui-serving.ts';
import { evaluatePathScopeRule, extractPathArgs } from '../sdk/src/platform/runtime/permissions/rules/path-scope.ts';
import { findSessionCandidates } from '../sdk/src/platform/sessions/manager.ts';

test('rejected traffic does not accumulate timestamps inside the rate limiter', () => {
  const limiter = new RateLimiter(2);
  try {
    expect(limiter.check('a')).toBe(true); expect(limiter.check('a')).toBe(true);
    for (let i = 0; i < 10000; i++) expect(limiter.check('a')).toBe(false);
    expect((limiter as unknown as { counts: Map<string, number[]> }).counts.get('a')).toHaveLength(2);
    expect(limiter.check('b')).toBe(true);
  } finally { limiter.stop(); }
});

test('bundle files, directory symlinks and the fallback shell stay within the bundle root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bundle-containment-'));
  const bundle = join(root, 'public'); mkdirSync(bundle);
  const posture: WebuiServingPosture = { serveBundle: true, bundleDir: bundle, bundleDirSource: 'controlPlane.webui.bundleDir',
    cors: { enabled: false, allowedOrigins: [] }, openaiPathPrefix: '/v1', reservedApiPaths: ['/api'] };
  try {
    writeFileSync(join(root, 'private.txt'), 'private'); writeFileSync(join(bundle, 'ok.txt'), 'public');
    symlinkSync(join(root, 'private.txt'), join(bundle, 'leak.txt'));
    symlinkSync(root, join(bundle, 'outside'));
    symlinkSync(join(root, 'private.txt'), join(bundle, 'index.html'));
    for (const path of ['/leak.txt', '/outside/private.txt', '/', '/navigation']) {
      expect((await serveWebuiBundle(new Request('http://test'+path, { headers: { accept: 'text/html' } }), posture))?.status).toBe(403);
    }
    expect(await (await serveWebuiBundle(new Request('http://test/ok.txt'), posture))?.text()).toBe('public');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('write batch path rules deny any protected file and allow only an entirely scoped batch', () => {
  const args = { files: [{ path: 'allowed/a', content: '' }, { path: 'protected/b', content: '' }] };
  expect(extractPathArgs(args)).toEqual(['allowed/a', 'protected/b']);
  const rule = { id: 'paths', origin: 'user' as const, type: 'path-scope' as const, effect: 'deny' as const, toolPattern: 'write', pathPatterns: ['protected/**'] };
  expect(evaluatePathScopeRule(rule, 'write', args, '/project').matched).toBe(true);
  expect(evaluatePathScopeRule({ ...rule, effect: 'allow', pathPatterns: ['allowed/**'] }, 'write', args, '/project').matched).toBe(false);
});

test('session exact ids win and ambiguous prefixes remain explicit candidates', () => {
  const sessions = [{ name: 'user-123-extra', title: 'Other' }, { name: 'user-123', title: 'Review' }];
  expect(findSessionCandidates(sessions, 'user-123')).toEqual([sessions[1]!]);
  expect(findSessionCandidates(sessions, 'user-12')).toHaveLength(2);
  expect(findSessionCandidates(sessions, 'review')).toEqual([sessions[1]!]);
});

test('path approval keys distinguish file batches from delimiter-containing filenames', async () => {
  const { PermissionManager } = await import('../sdk/src/platform/permissions/manager.ts');
  const key = (PermissionManager.prototype as unknown as { getApprovalKey(name: string, args: Record<string, unknown>): string }).getApprovalKey;
  expect(key('write', { files: [{ path: 'a|b' }] })).not.toBe(key('write', { files: [{ path: 'a' }, { path: 'b' }] }));
  expect(key('write', { files: [{ path: 'a' }] })).not.toBe(key('write', { files: [{ path: 'b' }] }));
});

test('HTTP listener takes rate-limit identity from the socket and cannot spoof a Cloudflare peer', async () => {
  const { HttpListener } = await import('../sdk/src/platform/daemon/http-listener.ts');
  const { ConfigManager } = await import('../sdk/src/platform/config/manager.ts');
  const { UserAuthManager } = await import('../sdk/src/platform/security/user-auth.ts');
  const root = mkdtempSync(join(tmpdir(), 'listener-peer-'));
  try {
    for (const trustProxy of [false, true]) {
      let port = 0;
      const listener = new HttpListener({ configManager: new ConfigManager({ configDir: root }),
        userAuth: new UserAuthManager({ bootstrapFilePath: join(root, 'auth.json'), bootstrapCredentialPath: join(root, 'bootstrap.txt') }),
        port: 0, host: '127.0.0.1', trustProxy, trustCloudflare: true,
        serveFactory: ((options: Parameters<typeof Bun.serve>[0]) => { const server = Bun.serve(options); port = server.port!; return server; }) as typeof Bun.serve });
      const identities: string[] = [];
      (listener as unknown as { _handleRequestInner(req: Request, url: URL, ip: string): Promise<Response> })._handleRequestInner = async (_req, _url, ip) => {
        identities.push(ip); return new Response('ok');
      };
      listener.enable({ httpListener: true }, 'synthetic-token');
      try {
        await listener.start();
        await fetch(`http://127.0.0.1:${port}/health`, { headers: { 'x-forwarded-for': '173.245.48.1', 'cf-connecting-ip': '198.51.100.123' } });
        expect(identities).toEqual(['127.0.0.1']);
      } finally { await listener.stop(); }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
