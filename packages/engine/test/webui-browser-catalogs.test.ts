import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'bun:test';
import { withTestTimeout } from './_helpers/test-timeout.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const ENGINE = resolve(import.meta.dir, '..');
const PUBLIC_ENTRY = '@goodvibes-jev/engine/sdk/platform/judgment-browser/catalogs';
interface Graph {
  inputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
  outputs: Record<string, { imports: { path: string; external?: boolean }[] }>;
}

test('public catalogs and the real palette caller exclude server provider, logging and SQLite graphs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gv-webui-browser-catalogs-'));
  try {
    const scope = join(dir, 'node_modules', '@goodvibes-jev');
    mkdirSync(scope, { recursive: true }); symlinkSync(ENGINE, join(scope, 'engine'), 'dir');
    for (const source of [true, false]) for (const caller of [false, true]) {
      const name = `${source ? 'source' : 'published'}-${caller ? 'caller' : 'catalogs'}`;
      const entry = join(dir, `${name}.ts`);
      // A real package lookup, without aliases, externals or host shims.
      writeFileSync(entry, caller
        ? `import * as caller from ${JSON.stringify(join(ROOT, 'products/webui/src/lib/command-judgment.ts'))}; globalThis.testCaller = caller;`
        : `import * as catalogs from ${JSON.stringify(PUBLIC_ENTRY)}; globalThis.testCatalogs = catalogs;`);
      const outfile = join(dir, `${name}.js`);
      const metafile = join(dir, `${name}-meta.json`);
      const child = Bun.spawn([process.execPath, 'build', entry, '--target=browser', '--format=iife', ...(source ? ['--conditions=bun'] : []), `--outfile=${outfile}`, `--metafile=${metafile}`],
        { cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
      const out = new Response(child.stdout).text(); const err = new Response(child.stderr).text();
      try {
        expect(await withTestTimeout(child.exited, 30_000, 'WebUI browser graph timed out'), `${await out}\n${await err}`).toBe(0);
      } finally { try { child.kill('SIGKILL'); } catch { /* exited */ } await child.exited; }
      const graph = JSON.parse(readFileSync(metafile, 'utf8')) as Graph;
      const paths = Object.keys(graph.inputs).map((path) => path.replaceAll('\\', '/'));
      const edges = Object.values(graph.inputs).flatMap((input) => input.imports);
      const forbidden = /(?:^|\/)(?:node:|bun:)|sqlite|AsyncLocalStorage|judgment\/(?:src|dist)\/(?:index\.|log\/|port\/(?:client|transport|failover))|sdk\/(?:src|dist)\/platform\/(?:logging|providers)\//;
      expect([...paths, ...edges.map((edge) => edge.path)].filter((path) => forbidden.test(path))).toEqual([]);
      // Bun records unused re-export edges as external in its input metadata.
      // The emitted IIFE must be self-contained, with no remaining import edges.
      expect(Object.values(graph.outputs).flatMap((output) => output.imports)).toEqual([]);
      expect(paths.some((path) => path.endsWith(`/judgment-browser/batteries/catalogs.${source ? 'ts' : 'js'}`))).toBe(true);
      if (caller) expect(paths.some((path) => path.endsWith('/webui/src/lib/command-judgment.ts'))).toBe(true);
      else {
        const catalogs = runInNewContext(`${readFileSync(outfile, 'utf8')}\ntestCatalogs`, Object.create(null), { timeout: 5_000 }) as typeof import('../sdk/src/platform/judgment-browser/batteries/catalogs.ts');
        expect(catalogs.WEBUI_BUILTIN_COMMANDS).toHaveLength(27);
        expect(catalogs.readWebuiStatusCatalog('knowledge-job.running', 'library-dot')).toEqual({ vocabulary: 'library-dot', tone: 'info' });
        expect(catalogs.readWebuiStatusCatalog('account-auth.expiring', 'badge')).toEqual({ vocabulary: 'badge', tone: 'warning' });
        expect(catalogs.readWebuiStatusCatalog('knowledge-refinement.needs_review', 'library-dot')).toEqual({ vocabulary: 'library-dot', tone: 'warn' });
        expect(catalogs.readWebuiStatusCatalog('account-auth.future', 'badge')).toBeUndefined();
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}, 70_000);
