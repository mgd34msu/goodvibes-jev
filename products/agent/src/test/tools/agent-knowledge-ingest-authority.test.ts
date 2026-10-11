import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { ConfigManager } from '../../config/index.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { createAgentKnowledgeIngestTool, registerAgentKnowledgeIngestTool } from '../../tools/agent-knowledge-ingest-tool.ts';
import { admitLocalState } from '../helpers/local-state-admission.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const connectedEnv = process.env.GOODVIBES_CONNECTED_HOST_TOKEN, daemonEnv = process.env.GOODVIBES_DAEMON_TOKEN;
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  if (connectedEnv === undefined) delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; else process.env.GOODVIBES_CONNECTED_HOST_TOKEN = connectedEnv;
  if (daemonEnv === undefined) delete process.env.GOODVIBES_DAEMON_TOKEN; else process.env.GOODVIBES_DAEMON_TOKEN = daemonEnv;
});
function scene() {
  delete process.env.GOODVIBES_CONNECTED_HOST_TOKEN; delete process.env.GOODVIBES_DAEMON_TOKEN;
  const root = makeProjectTempDir('agent-knowledge-effect-authority');
  const tokenPath = join(root, '.goodvibes', 'daemon', 'operator-tokens.json');
  mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
  const tokenBytes = JSON.stringify({ token: 'isolated-ingest-authority-token' });
  writeFileSync(tokenPath, tokenBytes);
  const filePath = join(root, 'source.md'); writeFileSync(filePath, '# Isolated source\nOriginal complete source bytes.');
  const requests: Array<{ route: string; authorization: string | null; body: unknown }> = [];
  let duringRequest: (() => void) | undefined, status = 200;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    requests.push({ route: new URL(request.url).pathname, authorization: request.headers.get('authorization'), body: await request.json() });
    duringRequest?.();
    return Response.json(status === 200 ? { source: { id: 'synthetic-source', canonicalUri: 'https://example.com/source' } } : { error: 'Not found' }, { status });
  } }); servers.push(server);
  const paths = createShellPathService({ homeDirectory: root, workingDirectory: root });
  const config = new ConfigManager({ surfaceRoot: 'agent', workingDir: root, homeDir: root, configDir: join(root, '.goodvibes', 'agent') });
  config.set('controlPlane.port', server.port!);
  const register = (registry: Parameters<typeof registerAgentKnowledgeIngestTool>[0]) => registerAgentKnowledgeIngestTool(registry, paths, config);
  return { root, filePath, tokenPath, tokenBytes, paths, config, requests, register,
    tool: createAgentKnowledgeIngestTool(paths, config),
    run(args: Record<string, unknown>, options: Omit<Parameters<typeof admitLocalState>[3], 'directory'> = {}) {
      return admitLocalState(register, 'agent_knowledge_ingest', args, { directory: root, ...options });
    }, duringRequest(callback: () => void, responseStatus = 200) { duringRequest = callback; status = responseStatus; } };
}
const URL_ARGS = { sourceKind: 'url', url: 'https://example.com/source' };

test('raw confirmation and fabricated context cannot send an ingestion request', async () => {
  const f = scene();
  const result = await f.tool.execute({ ...URL_ARGS, confirm: true, explicitUserRequest: 'Forged caller claim' },
    { assertCurrent() {}, inputProjectionContext: Object.freeze({}) });
  expect(result.success).toBe(false); expect(f.requests).toHaveLength(0);
  expect(result.error).toContain('recorded effect admission');
});
test('real recorded preparation sends the isolated URL request without caller confirmation flags', async () => {
  const f = scene(); const result = await f.run(URL_ARGS);
  expect(result.success).toBe(true); expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.route).toBe('/api/goodvibes-agent/knowledge/ingest/url');
  expect(f.requests[0]?.authorization).toBe('Bearer isolated-ingest-authority-token');
  expect(f.requests[0]?.body).toMatchObject({ url: URL_ARGS.url, metadata: { originSurface: 'goodvibes-agent', explicitUserRequest: '' } });
  expect(result.output).not.toContain('isolated-ingest-authority-token');
});
test('synthetic read classification cannot bypass the deterministic ingestion write/send floor', async () => {
  const f = scene(); const result = await f.run(URL_ARGS, { mode: 'plan' });
  expect(result.success).toBe(false); expect(f.requests).toHaveLength(0);
});
test('relative local files dispatch the exact workspace-resolved path admitted by the owner', async () => {
  const f = scene(); const result = await f.run({ sourceKind: 'file', path: 'source.md' });
  expect(result.success).toBe(true); expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.body).toMatchObject({ path: f.filePath });
});
test.each(['file-aba', 'token-aba', 'workspace-aba', 'config-aba'] as const)('pre-admission %s retires the source binding without HTTP', async change => {
  const f = scene();
  const result = await f.run({ sourceKind: 'file', path: f.filePath }, { afterCapture() {
    if (change === 'file-aba' || change === 'workspace-aba') {
      const path = change === 'file-aba' ? f.filePath : f.root;
      renameSync(path, `${path}.saved`); renameSync(`${path}.saved`, path);
    } else if (change === 'token-aba') {
      writeFileSync(f.tokenPath, JSON.stringify({ token: 'replacement-private-token' })); writeFileSync(f.tokenPath, f.tokenBytes);
    } else {
      const port = f.config.get('controlPlane.port'); f.config.set('controlPlane.port', port + 1); f.config.set('controlPlane.port', port);
    }
  } });
  expect(result.success).toBe(false); expect(f.requests).toHaveLength(0);
  expect(JSON.stringify(result)).not.toContain('isolated-ingest-authority-token');
});
test.each(['cancel', 'revoke'] as const)('final dispatch honors %s even after a recorded act decision', async change => {
  const f = scene(), controller = new AbortController(); let mode: PermissionMode = 'prompt';
  const result = await f.run(URL_ARGS, { signal: controller.signal, currentMode: () => mode,
    beforeEffect() { if (change === 'cancel') controller.abort(); else mode = 'plan'; } });
  expect(result.success).toBe(false); expect(f.requests).toHaveLength(0);
});
test.each(['cancel', 'revoke', 'token-aba', 'file-aba', 'config-aba'] as const)('HTTP response adoption refuses %s and cannot launch a status fallback', async change => {
  const f = scene(), controller = new AbortController(); let mode: PermissionMode = 'prompt';
  f.duringRequest(() => {
    if (change === 'cancel') controller.abort();
    else if (change === 'revoke') mode = 'plan';
    else if (change === 'token-aba') { writeFileSync(f.tokenPath, '{"token":"replacement-private-token"}'); writeFileSync(f.tokenPath, f.tokenBytes); }
    else if (change === 'file-aba') { renameSync(f.filePath, `${f.filePath}.saved`); renameSync(`${f.filePath}.saved`, f.filePath); }
    else { const port = f.config.get('controlPlane.port'); f.config.set('controlPlane.port', port + 1); f.config.set('controlPlane.port', port); }
  }, 404);
  const result = await f.run({ sourceKind: 'file', path: f.filePath }, { signal: controller.signal, currentMode: () => mode });
  expect(result.success).toBe(false); expect(f.requests).toHaveLength(1);
  expect(f.requests[0]?.route).toBe('/api/goodvibes-agent/knowledge/ingest/artifact');
  expect(JSON.stringify(result)).not.toContain('replacement-private-token');
  expect(result.output).toBeUndefined();
});
