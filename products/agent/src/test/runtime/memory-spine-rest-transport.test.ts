/**
 * The memory-spine REST transport (memory-spine-rest-transport.ts) against a REAL
 * daemon, a live DaemonServer bound to a reserved ephemeral port (port 0), never
 * a fixed port and never the developer's real ~/.goodvibes. Proves the wire
 * actually round-trips through the daemon's own memoryRegistry (not a mock), that
 * the honest-search envelope survives the wire faithfully (recall honesty
 * passthrough), that 404 folds to null instead of throwing, and that a stopped
 * daemon makes every op reject (the honest-failure contract, never a silent
 * local fallback from inside the transport itself).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/sdk/platform/config';
import { DaemonServer } from '@goodvibes-jev/engine/sdk/platform/daemon';
import { UserAuthManager } from '@goodvibes-jev/engine/sdk/platform/security';
import { RuntimeEventBus } from '@/runtime/index.ts';
import { createFeatureFlagManager } from '@/runtime/index.ts';
import type { MemoryAccess } from '@goodvibes-jev/engine/sdk/platform/runtime/memory-spine';
import { createRuntimeServices, type RuntimeServices } from '../../runtime/services.ts';
import { createRuntimeStore } from '../../runtime/store/index.ts';
import { createMemorySpineRestTransport, type MemorySpineRestTransportOptions } from '../../runtime/memory-spine-rest-transport.ts';
import type { SessionRegistrationConnection } from '../../runtime/session-spine-rest-transport.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

/**
 * `createMemorySpineRestTransport` returns `MemoryTransport`, whose EXTENDED verbs
 * (list/update/link/linksFor/searchSemantic/exportBundle/importBundle) are typed
 * optional so an older transport still satisfies the type (see the SDK's version-
 * tolerance ruling). This concrete transport implements every one of them, so
 * these tests, which exercise the raw transport directly rather than routing
 * through a MemorySpineClient, assert that structurally instead of null-checking
 * each call.
 */
function createFullMemoryAccess(options: MemorySpineRestTransportOptions): MemoryAccess {
  return createMemorySpineRestTransport(options) as MemoryAccess;
}

const TEST_TOKEN = 'memory-spine-transport-token-xyz789';

async function reservePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Unable to reserve test port')));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

function createUserAuth(homeDir: string): UserAuthManager {
  return new UserAuthManager({
    bootstrapFilePath: join(homeDir, 'auth-users.json'),
    bootstrapCredentialPath: join(homeDir, 'auth-bootstrap.txt'),
    users: [{
      username: 'admin',
      passwordHash: UserAuthManager.hashPassword('admin'),
      roles: ['admin'],
    }],
  });
}

describe('memory-spine REST transport against a real daemon', () => {
  let daemon: DaemonServer;
  let daemonServices: RuntimeServices;
  let tempRoot: string;
  let port: number;
  let connection: SessionRegistrationConnection;

  beforeEach(async () => {
    tempRoot = makeProjectTempDir('gv-memory-spine-transport');
    const workingDir = join(tempRoot, 'workspace');
    const homeDir = join(tempRoot, 'home');
    mkdirSync(workingDir, { recursive: true });
    mkdirSync(homeDir, { recursive: true });
    port = await reservePort();
    daemonServices = createRuntimeServices({
      // Opt out: this process does not outlive the unawaited sweep.
      modelDiscovery: 'skip',
      runtimeStore: createRuntimeStore(),
      runtimeBus: new RuntimeEventBus(),
      configManager: new ConfigManager({ surfaceRoot: 'tui', configDir: join(homeDir, '.goodvibes', 'tui'), workingDir, homeDir }),
      workingDir,
      homeDirectory: homeDir,
      featureFlags: createFeatureFlagManager(),
      getConversationTitle: () => 'memory-spine-transport-test',
    });
    daemon = new DaemonServer({ port, host: '127.0.0.1', runtimeServices: daemonServices.asDaemonGradeView(), userAuth: createUserAuth(homeDir) });
    daemon.enable({ daemon: true }, TEST_TOKEN);
    await daemon.start();
    connection = { baseUrl: `http://127.0.0.1:${port}`, token: TEST_TOKEN };
  });

  afterEach(async () => {
    await daemon?.stop();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  test('add() round-trips through the wire into the DAEMON-owned store', async () => {
    const transport = createMemorySpineRestTransport({ resolveConnection: () => connection });
    const record = await transport.add({ cls: 'fact', scope: 'project', summary: 'wire-added fact' });
    expect(record.summary).toBe('wire-added fact');
    expect(record.confidence).toBe(60); // the store's own baseline, per MemoryStore.add()

    // Proves this genuinely reached the daemon's own store, not a client-side echo.
    const direct = daemonServices.memoryRegistry.get(record.id);
    expect(direct?.summary).toBe('wire-added fact');
  });

  test('get() folds an unknown id to null instead of throwing (honest 404, not a transport failure)', async () => {
    const transport = createMemorySpineRestTransport({ resolveConnection: () => connection });
    await expect(transport.get('mem_does_not_exist')).resolves.toBeNull();
  });

  test('get() returns the real record for a known id', async () => {
    const transport = createMemorySpineRestTransport({ resolveConnection: () => connection });
    const added = await transport.add({ cls: 'fact', scope: 'project', summary: 'fetch me back' });
    const fetched = await transport.get(added.id);
    expect(fetched?.id).toBe(added.id);
    expect(fetched?.summary).toBe('fetch me back');
  });

  test('updateReview() round-trips a review patch and returns null for an unknown id', async () => {
    const transport = createMemorySpineRestTransport({ resolveConnection: () => connection });
    const added = await transport.add({ cls: 'fact', scope: 'project', summary: 'needs review' });
    const reviewed = await transport.updateReview(added.id, { state: 'reviewed', confidence: 92, reviewedBy: 'wire-test' });
    expect(reviewed?.reviewState).toBe('reviewed');
    expect(reviewed?.confidence).toBe(92);
    expect(daemonServices.memoryRegistry.get(added.id)?.reviewState).toBe('reviewed');

    await expect(transport.updateReview('mem_missing', { state: 'stale' })).resolves.toBeNull();
  });

  test('delete() removes the record from the daemon store and returns an honest boolean', async () => {
    const transport = createMemorySpineRestTransport({ resolveConnection: () => connection });
    const added = await transport.add({ cls: 'fact', scope: 'project', summary: 'delete me' });
    await expect(transport.delete(added.id)).resolves.toBe(true);
    expect(daemonServices.memoryRegistry.get(added.id)).toBeNull();
    // A second delete of the same (now-gone) id is honestly false, never a phantom success.
    await expect(transport.delete(added.id)).resolves.toBe(false);
  });

  test('honestSearch() recall-filters flagged and sub-floor records and reports exact exclusion counts: the honesty envelope survives the wire', async () => {
    const transport = createMemorySpineRestTransport({ resolveConnection: () => connection });
    const clean = await transport.add({ cls: 'fact', scope: 'project', summary: 'clean eligible fact', review: { confidence: 80 } });
    const belowFloor = await transport.add({ cls: 'fact', scope: 'project', summary: 'below floor fact', review: { confidence: 40 } });
    const stale = await transport.add({ cls: 'fact', scope: 'project', summary: 'stale fact', review: { confidence: 95 } });
    await transport.updateReview(stale.id, { state: 'stale', staleReason: 'superseded' });

    const result = await transport.honestSearch({}, { recall: true });
    expect(result.recallFiltered).toBe(true);
    expect(result.totalBeforeRecallFilter).toBe(3);
    expect(result.excludedBelowFloorCount).toBe(1);
    expect(result.excludedFlaggedCount).toBe(1);
    expect(result.records.map((r) => r.id)).toEqual([clean.id]);
    expect(result.records.map((r) => r.id)).not.toContain(belowFloor.id);
    expect(result.records.map((r) => r.id)).not.toContain(stale.id);
    // Literal mode (no semantic requested), matches runHonestMemorySearch's contract exactly.
    expect(result.mode).toBe('literal');
    expect(result.requestedSemantic).toBe(false);
    expect(result.indexUnavailableReason).toBeNull();

    // Without recall, nothing is filtered, a review/browse caller sees everything.
    const browse = await transport.honestSearch({});
    expect(browse.recallFiltered).toBe(false);
    expect(browse.records).toHaveLength(3);
  });

  test('a missing operator token rejects rather than silently degrading', async () => {
    const transport = createMemorySpineRestTransport({ resolveConnection: () => ({ baseUrl: connection.baseUrl, token: null }) });
    await expect(transport.add({ cls: 'fact', summary: 'no token' })).rejects.toThrow(/operator token/);
  });

  test('every op rejects once the daemon has stopped: the honest-failure contract (no silent local fallback inside the transport)', async () => {
    const transport = createMemorySpineRestTransport({ resolveConnection: () => connection, timeoutMs: 500 });
    await daemon.stop();
    await expect(transport.add({ cls: 'fact', summary: 'daemon is down' })).rejects.toThrow();
    await expect(transport.get('any-id')).rejects.toThrow();
    await expect(transport.honestSearch({})).rejects.toThrow();
  });

  // ── Extended verbs (1.2.0 full-detach catalog), same real-daemon proof ────

  test('list() returns every record from the DAEMON store: an empty filter is getAll semantics', async () => {
    const transport = createFullMemoryAccess({ resolveConnection: () => connection });
    const first = await transport.add({ cls: 'fact', scope: 'project', summary: 'list me one' });
    const second = await transport.add({ cls: 'fact', scope: 'team', summary: 'list me two' });
    const listed = await transport.list();
    expect(listed.map((record) => record.id).sort()).toEqual([first.id, second.id].sort());
  });

  test('update() edits a record\'s content fields on the DAEMON store and returns null for an unknown id', async () => {
    const transport = createFullMemoryAccess({ resolveConnection: () => connection });
    const added = await transport.add({ cls: 'fact', scope: 'project', summary: 'before promotion' });
    const updated = await transport.update(added.id, { scope: 'team', summary: 'after promotion' });
    expect(updated?.scope).toBe('team');
    expect(updated?.summary).toBe('after promotion');
    // Proves this genuinely reached the daemon's own store, not a client-side echo.
    expect(daemonServices.memoryRegistry.get(added.id)?.scope).toBe('team');

    await expect(transport.update('mem_missing', { scope: 'team' })).resolves.toBeNull();
  });

  test('link() creates a directed relation on the DAEMON store; linksFor() reads it back; an unknown endpoint folds to null', async () => {
    const transport = createFullMemoryAccess({ resolveConnection: () => connection });
    const from = await transport.add({ cls: 'decision', scope: 'project', summary: 'the decision' });
    const to = await transport.add({ cls: 'constraint', scope: 'project', summary: 'the constraint' });
    const link = await transport.link(from.id, to.id, 'supersedes');
    expect(link?.fromId).toBe(from.id);
    expect(link?.toId).toBe(to.id);
    expect(link?.relation).toBe('supersedes');

    const links = await transport.linksFor(from.id);
    expect(links.map((entry) => `${entry.fromId}->${entry.toId}:${entry.relation}`)).toContain(`${from.id}->${to.id}:supersedes`);

    await expect(transport.link(from.id, 'mem_missing', 'supersedes')).resolves.toBeNull();
  });

  test('searchSemantic() ranks by relevance against the DAEMON\'s index and returns the honest scored envelope', async () => {
    const transport = createFullMemoryAccess({ resolveConnection: () => connection });
    const added = await transport.add({ cls: 'fact', scope: 'project', summary: 'a very distinctive searchable phrase about llamas' });
    const results = await transport.searchSemantic({ query: 'distinctive searchable phrase about llamas', limit: 10 });
    expect(Array.isArray(results)).toBe(true);
    const match = results.find((entry) => entry.record.id === added.id);
    expect(match).toBeDefined();
    expect(typeof match?.similarity).toBe('number');
    expect(typeof match?.score).toBe('number');
  });

  test('exportBundle()/importBundle() round-trip through the DAEMON store as a no-loss, idempotent bundle', async () => {
    const transport = createFullMemoryAccess({ resolveConnection: () => connection });
    const added = await transport.add({ cls: 'fact', scope: 'project', summary: 'export me' });
    const bundle = await transport.exportBundle({});
    expect(bundle.recordCount).toBe(1);
    expect(bundle.records.map((record) => record.id)).toContain(added.id);

    // Re-importing the exact same bundle is an idempotent union: the id already
    // exists on the daemon's store, so it is skipped, never duplicated or overwritten.
    const result = await transport.importBundle(bundle);
    expect(result.importedRecords).toBe(0);
    expect(result.skippedRecords).toBe(1);
    expect(daemonServices.memoryRegistry.getAll()).toHaveLength(1);
  });
});

/**
 * Version-skew wire honesty: a 404 is disambiguated by its RESPONSE CODE, not the
 * bare status. A record-missing 404 (MEMORY_RECORD_NOT_FOUND) folds to null on a
 * nullable verb; a route-not-found 404 from an older daemon that never registered
 * the route rejects honestly on EVERY verb, never a silent null. Driven by a tiny
 * canned-response server since the transport calls the global fetch.
 */
describe('memory-spine version-skew wire honesty (route-not-found vs record-missing 404)', () => {
  async function startCannedServer(status: number, body: object): Promise<{ url: string; close: () => Promise<void> }> {
    const server = createHttpServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    const port = address && typeof address === 'object' ? address.port : 0;
    return {
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  const routeNotFound = { error: 'Route not found', code: 'NOT_FOUND', category: 'not_found', status: 404 };
  const recordMissing = { error: 'Unknown memory record', code: 'MEMORY_RECORD_NOT_FOUND', category: 'not_found', status: 404 };

  async function withCanned(status: number, body: object, run: (transport: MemoryAccess) => Promise<void>): Promise<void> {
    const server = await startCannedServer(status, body);
    try {
      await run(createFullMemoryAccess({ resolveConnection: () => ({ baseUrl: server.url, token: 'tok' }) }));
    } finally {
      await server.close();
    }
  }

  test('a NULLABLE verb (update) against an older daemon (route-not-found 404) REJECTS honestly, never nulls', async () => {
    await withCanned(404, routeNotFound, async (transport) => {
      await expect(transport.update('mem_x', { summary: 's' })).rejects.toThrow(/does not support the 'update' memory verb/);
    });
  });

  test('a NULLABLE verb (update) against a current daemon with a missing record (record-missing 404) resolves null', async () => {
    await withCanned(404, recordMissing, async (transport) => {
      await expect(transport.update('mem_x', { summary: 's' })).resolves.toBeNull();
    });
  });

  test('a NON-NULLABLE verb (list) against an older daemon (route-not-found 404) REJECTS honestly instead of a raw 404', async () => {
    await withCanned(404, routeNotFound, async (transport) => {
      await expect(transport.list({})).rejects.toThrow(/does not support the 'list' memory verb/);
    });
  });

  test('a bare legacy 404 with no code is treated as method-unavailable, never a silent null', async () => {
    await withCanned(404, { error: 'Not found' }, async (transport) => {
      await expect(transport.update('mem_x', { summary: 's' })).rejects.toThrow(/does not support the 'update' memory verb/);
    });
  });
});
