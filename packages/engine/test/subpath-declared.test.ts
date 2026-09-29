/**
 * subpath-declared.test.ts, a capability nobody can import does not ship.
 *
 * The gap: `check-subpath-api-surface` enumerates its entry points FROM the
 * exports map, so it is a drift detector over what is already declared. A
 * top-level capability with no exports entry has no entry point to enumerate,
 * it is absent from the snapshot, absent from the diff, and absent from every
 * green run, while `import '@goodvibes-jev/engine/sdk/platform/<thing>'` fails
 * resolution for every consumer of the published package.
 *
 * That gap survives local development because consumers build against overlay
 * tarballs and workspace links, which resolve through paths a published install
 * does not have. Source-tree resolution proves nothing about the artifact that
 * actually ships.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dir, '..');
const PACKAGE_DIR = join(REPO_ROOT, 'sdk');
const PLATFORM_DIR = join(PACKAGE_DIR, 'src', 'platform');

/**
 * The sdk's subpaths, keyed as the old sdk package declared them (./platform/x):
 * they are the engine manifest's ./sdk/* exports, each naming its source module
 * under the workspace source condition.
 */
function exportsMap(): Record<string, unknown> {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    exports?: Record<string, unknown>;
  };
  return Object.fromEntries(
    Object.entries(manifest.exports ?? {})
      .filter(([key]) => key.startsWith('./sdk/'))
      .map(([key, value]) => [`.${key.slice('./sdk'.length)}`, value]),
  );
}

describe('every shipped capability is importable from the published package', () => {
  test('the check passes: no NEW undeclared top-level capability', () => {
    const result = spawnSync('bun', [join(REPO_ROOT, 'scripts', 'check-subpath-declared.ts')], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      console.error(`[subpath-declared]\n${result.stdout ?? ''}${result.stderr ?? ''}`);
    }
    expect(result.status).toBe(0);
  });

  test('this capability is declared, and points at a real entry', () => {
    const entry = exportsMap()['./platform/payments'];
    expect(entry).toBeDefined();
    // Not just present, pointing somewhere that exists. A subpath declared
    // against a path that is not there fails at import time rather than
    // here, which is the worst place to find out.
    const source = (entry as Record<string, string>)['bun'];
    expect(source).toBe('./sdk/src/platform/payments/index.ts');
    expect(existsSync(join(REPO_ROOT, source!))).toBe(true);
  });

  test('the payments source module the entry names actually exists', () => {
    expect(existsSync(join(PLATFORM_DIR, 'payments', 'index.ts'))).toBe(true);
  });

  test('every declared platform subpath names an existing sdk source module', () => {
    // The workspace consumes the engine from source through the exports map's
    // source condition, so every ./sdk/platform entry must name a module under
    // sdk/src that exists; one pointing anywhere else, or at nothing, fails
    // every importer.
    const offenders: string[] = [];
    for (const [subpath, entry] of Object.entries(exportsMap())) {
      if (!subpath.startsWith('./platform/')) continue;
      const target = entry && typeof entry === 'object' ? (entry as Record<string, unknown>)['bun'] : undefined;
      if (typeof target !== 'string' || !target.startsWith('./sdk/src/') || !existsSync(join(REPO_ROOT, target))) {
        offenders.push(`${subpath} -> ${String(target)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the known-undeclared list is honest about what it covers', () => {
    // The list exists so the gate can ship without blocking lanes that did not
    // introduce the defect. It must stay a list of REAL top-level capability
    // directories, an entry naming something that does not exist would be a
    // silent widening of the exemption.
    const source = readFileSync(join(REPO_ROOT, 'scripts', 'check-subpath-declared.ts'), 'utf8');
    const block = /const KNOWN_UNDECLARED: readonly string\[\] = \[([\s\S]*?)\];/.exec(source)?.[1] ?? '';
    const listed = [...block.matchAll(/'\.\/platform\/([^']+)'/g)].map((match) => match[1] ?? '');
    expect(listed.length).toBeGreaterThan(0);
    for (const name of listed) {
      expect(existsSync(join(PLATFORM_DIR, name, 'index.ts'))).toBe(true);
    }
  });

  test('the rule is top-level only, so internal submodules are not flagged', () => {
    // ./platform/tools/read is reached through ./platform/tools. A rule that
    // demanded an entry for every barrel file would fire on ~97 modules here
    // and be switched off within a day.
    const declared = new Set(Object.keys(exportsMap()));
    expect(existsSync(join(PLATFORM_DIR, 'tools', 'read', 'index.ts'))).toBe(true);
    expect(declared.has('./platform/tools/read')).toBe(false);
    expect(declared.has('./platform/tools')).toBe(true);
  });
});

describe('the surface a consumer needs to construct the capability', () => {
  test('the daemon-side service is exported, not merely present in source', async () => {
    // Reachable from source and absent from the published surface is exactly
    // the shape of gap the subpath check cannot see, because the SUBPATH was
    // declared correctly, only the symbol was missing.
    const surface = await import('../sdk/src/platform/payments/index.js');
    expect(typeof surface.PaymentsGatewayServiceImpl).toBe('function');
    // And the pieces a daemon has to build to use it.
    expect(typeof surface.readPaymentsServiceConfig).toBe('function');
    expect(typeof surface.createJevMerchantJudge).toBe('function');
    expect(typeof surface.runCheckout).toBe('function');
    expect(typeof surface.createChannelPaymentNotifier).toBe('function');
  });
});
