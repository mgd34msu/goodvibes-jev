/**
 * Build with the production compatibility driver, then execute the actual Tui
 * keyboard command registry in fresh compiled processes. The loopback
 * response fixture is intentionally synthetic; host-side Jev admission has
 * its own integration coverage. This is command-graph proof, not a renderer test.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLegacyImportHostFixture, IMPORT_FIXTURE_TOKEN, IMPORT_ROUTES, type LegacyImportHostFixture } from '../helpers/legacy-import-host-fixture.ts';
import { pairImportProofHost } from '../helpers/legacy-import-product-proof.ts';
const productRoot = resolve(import.meta.dir, '../../..');
let buildRoot = ''; let binary = '';
beforeAll(async () => {
  buildRoot = mkdtempSync(join(tmpdir(), 'compiled-import-command-')); binary = join(buildRoot, 'import-command-proof');
  const child = Bun.spawn([process.execPath, 'scripts/compile.ts', 'src/test/e2e/legacy-import-command-proof-entry.ts', '--compile', `--target=bun-${process.platform}-${process.arch}`, '--outfile', binary], { cwd: productRoot, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error(`Compiled import command proof failed (${code}): ${out}\n${error}`);
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await child.exited; } }
}, 190_000);
afterAll(() => { if (buildRoot) rmSync(buildRoot, { recursive: true, force: true }); });
async function run(product: 'tui', fixture: LegacyImportHostFixture, args: string[]) {
  const child = Bun.spawn([binary, product, fixture.home, fixture.workspace, fixture.baseUrl, ...args], {
    cwd: fixture.workspace, env: { HOME: fixture.home, GOODVIBES_HOME: fixture.home, PATH: '/usr/bin:/bin', TMPDIR: fixture.root, TERM: 'dumb', LANG: 'C.UTF-8' }, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try {
    const [out, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(0); expect(error).toBe(''); expect(out).not.toContain(IMPORT_FIXTURE_TOKEN);
    const result = JSON.parse(out) as { product: string; output: string }; expect(result.product).toBe(product); return result.output;
  } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await child.exited; } }
}
const product = 'tui';
test(`compiled ${product} command survives lost acknowledgement and exact recovery across processes`, async () => {
  const fixture = createLegacyImportHostFixture();
  try {
    await pairImportProofHost(fixture);
    fixture.setReply('lost-ack');
    expect(await run(product, fixture, ['submit', fixture.projectId])).toContain('Legacy import operation unavailable');
    const saved = fixture.read()!; expect(saved.state).toBe('unknown'); expect(saved.attempts).toBe(1);
    expect(await run(product, fixture, ['status', fixture.projectId])).toContain('Legacy import status: unknown');
    expect(await run(product, fixture, ['submit', fixture.projectId])).toContain('Legacy import status: unknown');
    expect(await run(product, fixture, ['recover', fixture.projectId, 'wrong-request'])).toContain('does not match the saved command');
    expect(fixture.commands).toHaveLength(1);
    fixture.setReply('accepted');
    expect(await run(product, fixture, ['recover', fixture.projectId, saved.command.requestId])).toContain('Legacy import status: accepted');
    expect(fixture.commands).toHaveLength(2); expect(fixture.commandBytes[1]).toBe(fixture.commandBytes[0]);
    expect(await run(product, fixture, ['status', fixture.projectId])).toContain('Legacy import status: accepted');
    expect(await run(product, fixture, ['submit', fixture.projectId])).toContain('Legacy import status: accepted');
    expect(fixture.commands).toHaveLength(2);
    expect(fixture.requests.filter(request => request.path === IMPORT_ROUTES.prepare)).toHaveLength(1);
    expect(fixture.read()).toMatchObject({ state: 'accepted', attempts: 2, result: { replayed: true } }); fixture.assertPreserved();
  } finally { await fixture.stop(); }
}, 60_000);
