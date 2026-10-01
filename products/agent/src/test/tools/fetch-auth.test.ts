// Deliberately per-repo test, byte-identical to the sibling product's copy by design: the module it exercises is this repo's own and has diverged from the sibling's, so the two copies prove different code and neither can stand in for the other.
/**
 * Tests for fetch tool auth integration (inline auth + service registry auth).
 * Kept in a separate file to avoid growing fetch.test.ts further.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createFetchTool } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ServiceRegistry } from '@goodvibes-jev/engine/sdk/platform/config';
import { SecretsManager } from '../../config/secrets.ts';
import { SubscriptionManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// ---------------------------------------------------------------------------
// Local test server, echoes headers so we can verify auth was applied
// ---------------------------------------------------------------------------

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === '/echo') {
        return Response.json({
          method: req.method,
          headers: Object.fromEntries(req.headers),
        });
      }
      return new Response('Not Found', { status: 404 });
    },
  });
  base = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop();
});

// ---------------------------------------------------------------------------
// Service registry auth
// ---------------------------------------------------------------------------

describe('fetch tool - service registry auth', () => {
  test('applies bearer auth from service registry via env var', async () => {
    const tempDir = makeProjectTempDir('gv-fetch-auth');
    try {
      writeFileSync(join(tempDir, 'services.json'), JSON.stringify({
        echo: { name: 'echo', authType: 'bearer', tokenKey: 'TEST_SERVICE_TOKEN' },
      }, null, 2), 'utf-8');

      const origToken = process.env['TEST_SERVICE_TOKEN'];
      process.env['TEST_SERVICE_TOKEN'] = 'registry-bearer-token';
      try {
        const registry = new ServiceRegistry(join(tempDir, 'services.json'), {
          secretsManager: new SecretsManager({ projectRoot: tempDir, globalHome: tempDir }),
          subscriptionManager: new SubscriptionManager(join(tempDir, 'subscriptions.json')),
        });
        const fetchTool = createFetchTool({ serviceRegistry: registry, isLocalhostAllowed: () => true });
        const result = await fetchTool.execute({
          urls: [{
            url: `${base}/echo`,
            extract: 'json',
            service: 'echo',
          }],
        });
        expect(result.success).toBe(true);
        const out = JSON.parse(result.output!);
        const echo = JSON.parse(out.results[0].content);
        expect(echo.headers['authorization']).toBe('Bearer registry-bearer-token');
      } finally {
        if (origToken === undefined) delete process.env['TEST_SERVICE_TOKEN'];
        else process.env['TEST_SERVICE_TOKEN'] = origToken;
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('inline auth takes precedence over service field (auth wins when both set)', async () => {
    const tempDir = makeProjectTempDir('gv-fetch-auth');
    writeFileSync(join(tempDir, 'services.json'), JSON.stringify({
      echo: { name: 'echo', authType: 'bearer', tokenKey: 'TEST_SERVICE_TOKEN' },
    }, null, 2), 'utf-8');
    try {
      const registry = new ServiceRegistry(join(tempDir, 'services.json'), {
        secretsManager: new SecretsManager({ projectRoot: tempDir, globalHome: tempDir }),
        subscriptionManager: new SubscriptionManager(join(tempDir, 'subscriptions.json')),
      });
      const fetchTool = createFetchTool({ serviceRegistry: registry, isLocalhostAllowed: () => true });
      const result = await fetchTool.execute({
        urls: [{
          url: `${base}/echo`,
          extract: 'json',
          auth: { type: 'bearer', token: 'inline-wins' },
          service: 'echo',
        }],
      });
      expect(result.success).toBe(true);
      const out = JSON.parse(result.output!);
      const echo = JSON.parse(out.results[0].content);
      // Inline auth should have been applied
      expect(echo.headers['authorization']).toBe('Bearer inline-wins');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
