/**
 * Origin enforcement is opt-in via the enforceCors config flag.
 *
 * Default behavior (home / single-user / local deployments): permissive.
 * No constructor guard, no request-time Origin check.
 *
 * Opt-in (enforceCors: true, enterprise / multi-user / internet-exposed):
 *   Startup guard, hostMode=network + enforceCors=true + allowedOrigins=[] throws SECURITY_UNSAFE_ORIGIN_CONFIG
 *   Startup guard, hostMode=network + enforceCors=true + allowedOrigins non-empty constructs OK
 *   Request-time, enforceCors=true + loopback + empty allowedOrigins + no Origin header → 200/pass
 *   Request-time, enforceCors=true + loopback + empty allowedOrigins + Origin header → 403 CORS_NOT_CONFIGURED
 *   Request-time, enforceCors=true + network + allowedOrigins set + wrong Origin → 403 ORIGIN_NOT_ALLOWED
 *   Request-time, enforceCors=true + network + allowedOrigins set + correct Origin → 200/pass
 *
 * Permissive default (enforceCors unset / false):
 *   Default config + network mode + empty allowedOrigins constructs OK (no startup guard)
 *   Default config + evil Origin header passes through (no request-time check)
 *   enforceCors=false explicit + network + empty allowedOrigins constructs OK
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { UserAuthManager } from '../sdk/src/platform/security/user-auth.js';
import { HttpListener } from '../sdk/src/platform/daemon/http-listener.js';
import { trackDisposables } from './_helpers/disposables.ts';
import { stopListenerTimers } from './_helpers/listener-teardown.ts';

// Every HttpListener built here starts two rate-limiter sweep intervals in its
// constructor and is never start()ed, so `stop()` would early-return and leave
// them running for the rest of the shared test process.
const disposables = trackDisposables();
import { ConfigManager } from '../sdk/src/platform/config/manager.js';

function tempDir(suffix: string): string {
  const d = join(tmpdir(), `gv-origin-${suffix}-${Date.now()}`);
  mkdirSync(d, { recursive: true });
  return d;
}

function cleanup(...dirs: string[]): void {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function makeConfigManager(dir: string, hostMode?: string): ConfigManager {
  const cm = new ConfigManager({ configDir: dir });
  if (hostMode !== undefined) {
    cm.set('httpListener.hostMode', hostMode as 'local' | 'network' | 'custom');
  }
  cm.set('httpListener.port', 59700);
  return cm;
}

function makeUserAuth(dir: string): UserAuthManager {
  return new UserAuthManager({
    users: [],
    bootstrapFilePath: join(dir, 'auth-users.json'),
    bootstrapCredentialPath: join(dir, 'auth-bootstrap.txt'),
  });
}

function makeListener(opts: {
  configManager: ConfigManager;
  userAuth: UserAuthManager;
  allowedOrigins?: string[];
  enforceCors?: boolean;
}): { listener: HttpListener; dispatch: (req: Request) => Promise<Response> } {
  let capturedFetch: ((req: Request, server: { requestIP(req: Request): { address: string } }) => Promise<Response>) | null = null;
  const mockServe = (options: { fetch: (req: Request, server: { requestIP(req: Request): { address: string } }) => Promise<Response> }) => {
    capturedFetch = options.fetch;
    return { stop: () => {} } as ReturnType<typeof Bun.serve>;
  };

  const listener = disposables.add(
    new HttpListener({
      configManager: opts.configManager,
      userAuth: opts.userAuth,
      allowedOrigins: opts.allowedOrigins ?? [],
      enforceCors: opts.enforceCors,
      serveFactory: mockServe as unknown as typeof Bun.serve,
    }),
    stopListenerTimers,
  );

  listener.enable({ httpListener: true }, 'test-token');

  return {
    listener,
    dispatch: (req) => {
      if (!capturedFetch) throw new Error('listener not started');
      return capturedFetch(req, { requestIP: () => ({ address: '127.0.0.1' }) });
    },
  };
}

describe('startup guard (opt-in via enforceCors)', () => {
  test('enforceCors=true + hostMode=network + allowedOrigins=[] throws SECURITY_UNSAFE_ORIGIN_CONFIG', () => {
    const dir = tempDir('sg1');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      expect(() => {
        new HttpListener({
          configManager,
          userAuth,
          allowedOrigins: [],
          enforceCors: true,
          serveFactory: (() => ({ stop: () => {} })) as unknown as typeof Bun.serve,
        });
      }).toThrow('SECURITY_UNSAFE_ORIGIN_CONFIG');
    } finally {
      cleanup(dir);
    }
  });

  test('enforceCors=true + hostMode=network + allowedOrigins non-empty constructs OK', () => {
    const dir = tempDir('sg2');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      expect(() => {
        disposables.add(
          new HttpListener({
            configManager,
            userAuth,
            allowedOrigins: ['https://good.example'],
            enforceCors: true,
            serveFactory: (() => ({ stop: () => {} })) as unknown as typeof Bun.serve,
          }),
          stopListenerTimers,
        );
      }).not.toThrow();
    } finally {
      cleanup(dir);
    }
  });
});

describe('request-time origin enforcement (enforceCors=true)', () => {
  test('loopback + empty allowedOrigins + no Origin header → request passes', async () => {
    const dir = tempDir('rt1');
    try {
      const configManager = makeConfigManager(dir, 'local');
      const userAuth = makeUserAuth(dir);
      const { listener, dispatch } = makeListener({ configManager, userAuth, allowedOrigins: [], enforceCors: true });
      await listener.start();
      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: { Authorization: 'Bearer test-token' },
      }));
      expect(res.status).toBe(200);
      listener.stop();
    } finally {
      cleanup(dir);
    }
  });

  test('loopback + empty allowedOrigins + Origin header → 403 CORS_NOT_CONFIGURED', async () => {
    const dir = tempDir('rt2');
    try {
      const configManager = makeConfigManager(dir, 'local');
      const userAuth = makeUserAuth(dir);
      const { listener, dispatch } = makeListener({ configManager, userAuth, allowedOrigins: [], enforceCors: true });
      await listener.start();
      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: { Authorization: 'Bearer test-token', Origin: 'http://evil.example' },
      }));
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('CORS_NOT_CONFIGURED');
      listener.stop();
    } finally {
      cleanup(dir);
    }
  });

  test('network + allowedOrigins set + wrong Origin → 403 ORIGIN_NOT_ALLOWED', async () => {
    const dir = tempDir('rt3');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      const { listener, dispatch } = makeListener({
        configManager, userAuth, allowedOrigins: ['https://good.example'], enforceCors: true,
      });
      await listener.start();
      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: { Authorization: 'Bearer test-token', Origin: 'http://evil.example' },
      }));
      expect(res.status).toBe(403);
      const body = await res.json() as { error: string };
      expect(body.error).toContain('ORIGIN_NOT_ALLOWED');
      listener.stop();
    } finally {
      cleanup(dir);
    }
  });

  test('network + allowedOrigins set + correct Origin → request passes', async () => {
    const dir = tempDir('rt4');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      const { listener, dispatch } = makeListener({
        configManager, userAuth, allowedOrigins: ['https://good.example'], enforceCors: true,
      });
      await listener.start();
      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: { Authorization: 'Bearer test-token', Origin: 'https://good.example' },
      }));
      expect(res.status).toBe(200);
      listener.stop();
    } finally {
      cleanup(dir);
    }
  });
});

describe('permissive default (enforceCors unset)', () => {
  test('default config + hostMode=network + allowedOrigins=[] constructs without throwing', () => {
    const dir = tempDir('pd1');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      expect(() => {
        disposables.add(
          new HttpListener({
            configManager, userAuth, allowedOrigins: [],
            serveFactory: (() => ({ stop: () => {} })) as unknown as typeof Bun.serve,
          }),
          stopListenerTimers,
        );
      }).not.toThrow();
    } finally {
      cleanup(dir);
    }
  });

  test('default config + evil Origin header passes through (no request-time check)', async () => {
    const dir = tempDir('pd2');
    try {
      const configManager = makeConfigManager(dir, 'local');
      const userAuth = makeUserAuth(dir);
      const { listener, dispatch } = makeListener({ configManager, userAuth, allowedOrigins: [] });
      await listener.start();
      const res = await dispatch(new Request('http://127.0.0.1/health', {
        headers: { Authorization: 'Bearer test-token', Origin: 'http://evil.example' },
      }));
      expect(res.status).toBe(200);
      listener.stop();
    } finally {
      cleanup(dir);
    }
  });

  test('enforceCors=false explicit + hostMode=network + allowedOrigins=[] constructs without throwing', () => {
    const dir = tempDir('pd3');
    try {
      const configManager = makeConfigManager(dir, 'network');
      const userAuth = makeUserAuth(dir);
      expect(() => {
        disposables.add(
          new HttpListener({
            configManager, userAuth, allowedOrigins: [], enforceCors: false,
            serveFactory: (() => ({ stop: () => {} })) as unknown as typeof Bun.serve,
          }),
          stopListenerTimers,
        );
      }).not.toThrow();
    } finally {
      cleanup(dir);
    }
  });
});
