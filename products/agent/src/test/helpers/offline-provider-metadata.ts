import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Exact synthetic metadata fixtures for the support-bundle containment test.
 * Unknown destinations/methods and connection prewarms fail closed. This does
 * not replace the ordinary runner's network guard or authorize live requests.
 */
export async function withOfflineProviderMetadata<T>(run: () => Promise<T>): Promise<{ result: T; requests: readonly string[] }> {
  const archiveRoot = mkdtempSync(join(tmpdir(), 'agent-offline-catalog-'));
  let repositoryArchive: ArrayBuffer;
  try {
    const providerPath = 'models-dev-fixture/providers/offline/provider.toml';
    mkdirSync(join(archiveRoot, 'models-dev-fixture/providers/offline'), { recursive: true });
    writeFileSync(join(archiveRoot, providerPath), 'name="Offline fixture"\nenv=[]\n');
    const archive = execFileSync('tar', ['-czf', '-', '-C', archiveRoot, providerPath], { timeout: 30_000, maxBuffer: 256 * 1024 });
    repositoryArchive = Uint8Array.from(archive).buffer;
  } finally { rmSync(archiveRoot, { recursive: true, force: true }); }
  const repositoryUrl = 'https://codeload.github.com/anomalyco/models.dev/tar.gz/refs/heads/dev';
  const fixtures = new Map<string, unknown>([
    ['https://openrouter.ai/api/v1/models', { data: [] }],
    ['https://api.zeroeval.com/leaderboard/models/full?justCanonicals=true', []],
    [repositoryUrl, repositoryArchive],
    ['https://aihubmix.com/api/v1/models', { data: [] }],
    ['https://ai-gateway.vercel.sh/v1/models', { data: [] }],
  ]);
  // These anonymous local discovery endpoints are explicitly unavailable in
  // the isolated fixture, rather than borrowing any service on the host.
  const unavailable = new Set([
    'http://127.0.0.1:30000/v1/models',
    'http://localhost:4000/v1/models',
    'http://localhost:3000/v1/models',
  ]);
  const previous = globalThis.fetch;
  const requests: string[] = [];
  const rejected: string[] = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    let request: Request;
    try { request = new Request(input, init); } catch {
      rejected.push('invalid-request');
      throw new Error('Invalid request in offline provider metadata fixture');
    }
    if (request.method !== 'GET' || request.body !== null || (!fixtures.has(request.url) && !unavailable.has(request.url))) {
      rejected.push(`${request.method} ${new URL(request.url).origin}${new URL(request.url).pathname}`);
      throw new Error('Unexpected request in offline provider metadata fixture');
    }
    requests.push(request.url);
    if (unavailable.has(request.url)) return new Response('Synthetic local provider unavailable', { status: 503 });
    if (request.url === repositoryUrl) return new Response(repositoryArchive, { headers: { 'content-type': 'application/gzip' } });
    return Response.json(fixtures.get(request.url));
  }, { preconnect: (..._args: Parameters<typeof fetch.preconnect>) => {
    rejected.push('preconnect');
    throw new Error('Unexpected preconnect in offline provider metadata fixture');
  } });
  try {
    const result = await run();
    if (rejected.length !== 0) throw new Error(`Offline metadata fixture refused ${rejected.length} unexpected request(s): ${rejected.join(", ")}`);
    return { result, requests };
  } finally { globalThis.fetch = previous; }
}
