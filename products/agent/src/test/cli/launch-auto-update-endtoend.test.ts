import { afterAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CHECKSUM_MANIFEST_NAME,
  resolveAgentBinaryAssetName,
  resolveSqliteVecArchive,
} from '@/runtime/release-artifacts.ts';
import { rollbackUpdate, PREVIOUS_FILE_SUFFIX } from '@/input/commands/update-runtime.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

// End-to-end proof of the launch auto-update loop with REAL processes, REAL
// files, and a REAL local HTTP server standing in for GitHub releases:
//
//   - the "old binary" is an executable (bun-shebang script) at
//     <scratch>/goodvibes-agent, pinned to fixture version 1.0.0 (never the
//     live build VERSION), that invokes the actual selfUpdateAtLaunch
//     machinery (runLaunchAutoUpdate + restartOntoUpdatedBinary) exactly as
//     main() does;
//   - the release payload served for download is ITSELF an executable that
//     prints its own version and argv, so the respawn assertion observes what
//     actually ran, not what was supposed to run;
//   - the sqlite-vec addon travels exactly as this repo releases it: a
//     tar.gz archive (built with the real system tar) whose inner
//     lib/sqlite-vec-<platform>-<arch>/vec0.<suffix> file is verified,
//     extracted, and swapped in lockstep with the binary;
//   - the only seam used is UpdateFetchLike, and only to rewrite the GitHub
//     host to the local server, the redirect-tag resolution, checksum
//     manifest parsing, sha256 verification, archive extraction, atomic swap,
//     keep-previous, and respawn are all the production code paths operating
//     on real bytes.

const OLD_VERSION = '1.0.0';
const NEW_VERSION = '1.1.0';
const NEW_TAG = `v${NEW_VERSION}`;
const GITHUB_BASE = 'https://github.com/mgd34msu/goodvibes-agent';
const LAUNCH_MODULE = join(import.meta.dir, '..', '..', 'cli', 'launch-auto-update.ts');

const appAsset = resolveAgentBinaryAssetName(process.platform, process.arch);
const addonAsset = resolveSqliteVecArchive(process.platform, process.arch);

const created: string[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];

afterAll(() => {
  for (const server of servers) {
    try {
      server.stop(true);
    } catch {
      /* ignore */
    }
  }
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function scratch(prefix: string): string {
  const dir = makeProjectTempDir(`${prefix}`);
  created.push(dir);
  return dir;
}

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** The executable installed as the OLD version: runs the real launch-update flow, then reports what it is. */
function oldBinarySource(): string {
  return [
    '#!/usr/bin/env bun',
    `import { runLaunchAutoUpdate, restartOntoUpdatedBinary } from ${JSON.stringify(LAUNCH_MODULE)};`,
    `const CURRENT_VERSION = ${JSON.stringify(OLD_VERSION)};`,
    "const base = process.env['GV_TEST_RELEASES_BASE'] ?? '';",
    '// The one seam: point the hardcoded GitHub release URLs at the local server.',
    `const fetchImpl = (url, init) => fetch(url.replace(${JSON.stringify(GITHUB_BASE)}, base), init);`,
    "const settings = process.env['GV_TEST_DISABLE'] === '1' ? { autoUpdateAtLaunch: false } : { launchCheckTimeoutMs: 5000 };",
    'const outcome = await runLaunchAutoUpdate({',
    '  fetchImpl,',
    '  execPath: process.argv[1],',
    '  platform: process.platform,',
    '  arch: process.arch,',
    '  currentVersion: CURRENT_VERSION,',
    '  settings,',
    '  env: process.env,',
    '  print: (line) => console.log(line),',
    '});',
    "if (outcome.action === 'restart') {",
    '  process.exit(restartOntoUpdatedBinary({',
    '    execPath: process.argv[1],',
    '    argv: process.argv.slice(2),',
    '    env: process.env,',
    '    fromVersion: CURRENT_VERSION,',
    '  }));',
    '}',
    'console.log(`RUNNING v${CURRENT_VERSION} argv=${JSON.stringify(process.argv.slice(2))} outcome=${outcome.action}:${outcome.reason}`);',
    '',
  ].join('\n');
}

/** The executable served as the NEW release artifact: proves the respawn ran IT, with the original argv. */
function newBinarySource(): string {
  return [
    '#!/usr/bin/env bun',
    `import { runLaunchAutoUpdate } from ${JSON.stringify(LAUNCH_MODULE)};`,
    `const CURRENT_VERSION = ${JSON.stringify(NEW_VERSION)};`,
    '// The restarted process must not check again (env marker short-circuit);',
    '// any fetch from here is a bug the test asserts against.',
    "const fetchImpl = () => { console.log('UNEXPECTED-FETCH'); throw new Error('unexpected fetch'); };",
    'const outcome = await runLaunchAutoUpdate({',
    '  fetchImpl,',
    '  execPath: process.argv[1],',
    '  platform: process.platform,',
    '  arch: process.arch,',
    '  currentVersion: CURRENT_VERSION,',
    '  settings: {},',
    '  env: process.env,',
    '  print: (line) => console.log(line),',
    '});',
    'console.log(`RUNNING v${CURRENT_VERSION} argv=${JSON.stringify(process.argv.slice(2))} outcome=${outcome.action}:${outcome.reason}`);',
    '',
  ].join('\n');
}

const OLD_ADDON_BYTES = 'old-addon-bytes\n';
const NEW_ADDON_BYTES = 'new-addon-payload-bytes\n';

interface Install {
  readonly dir: string;
  readonly appPath: string;
  readonly addonPath: string;
  readonly oldAppBytes: Buffer;
}

function installOldVersion(prefix: string): Install {
  if (!addonAsset) throw new Error('unsupported test platform');
  const dir = scratch(prefix);
  const appPath = join(dir, 'goodvibes-agent');
  writeFileSync(appPath, oldBinarySource());
  chmodSync(appPath, 0o755);
  // A pre-existing addon from the old install, exactly where the loader
  // resolves it, the update must swap it in lockstep with the binary.
  const addonPath = join(dir, 'lib', addonAsset.dirName, addonAsset.fileName);
  mkdirSync(join(addonPath, '..'), { recursive: true });
  writeFileSync(addonPath, OLD_ADDON_BYTES);
  return { dir, appPath, addonPath, oldAppBytes: readFileSync(appPath) };
}

/** Build the addon release archive exactly as the Release workflow does: real tar, release layout. */
function buildAddonArchive(): Buffer {
  if (!addonAsset) throw new Error('unsupported test platform');
  const dir = scratch('gv-agent-e2e-addon-src');
  const inner = join(dir, addonAsset.entryPath);
  mkdirSync(join(inner, '..'), { recursive: true });
  writeFileSync(inner, NEW_ADDON_BYTES);
  const tgz = join(dir, addonAsset.assetName);
  execFileSync('tar', ['-czf', tgz, '-C', dir, addonAsset.entryPath], { stdio: 'ignore' });
  return readFileSync(tgz);
}

/** A real local HTTP server speaking the exact GitHub releases shapes the updater consumes. */
function serveRelease(options: { appBytes: string; corruptAppChecksum?: boolean; corruptAddonChecksum?: boolean }): string {
  if (!appAsset || !addonAsset) throw new Error('unsupported test platform');
  const addonArchive = buildAddonArchive();
  const appHash = options.corruptAppChecksum ? sha256Hex('not-the-real-app-bytes') : sha256Hex(options.appBytes);
  const addonHash = options.corruptAddonChecksum ? sha256Hex('not-the-real-addon-bytes') : sha256Hex(addonArchive);
  const manifest = [`${appHash}  ${appAsset}`, `${addonHash}  ${addonAsset.assetName}`, ''].join('\n');
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/releases/latest') {
        return new Response(null, {
          status: 302,
          headers: { Location: `${GITHUB_BASE}/releases/tag/${NEW_TAG}` },
        });
      }
      if (path === `/releases/download/${NEW_TAG}/${CHECKSUM_MANIFEST_NAME}`) {
        return new Response(manifest);
      }
      if (path === `/releases/download/${NEW_TAG}/${appAsset}`) {
        return new Response(options.appBytes);
      }
      if (path === `/releases/download/${NEW_TAG}/${addonAsset.assetName}`) {
        return new Response(new Uint8Array(addonArchive));
      }
      return new Response('not found', { status: 404 });
    },
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

// Async spawn, deliberately: the release server (Bun.serve) runs on THIS
// process's event loop, so a blocking spawnSync here would deadlock the child
// against a server that can never answer while the loop is held.
async function runInstalledBinary(
  install: Install,
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn([install.appPath, ...args], {
    env: { ...process.env, ...env },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout: out + err, exitCode };
}

describe.if(appAsset !== null && addonAsset !== null)('launch auto-update: end to end with real processes and a real release server', () => {
  test('a stale binary launches, updates through the real verify path (binary AND addon), and the respawn runs the NEW binary with the original argv', async () => {
    const install = installOldVersion('gv-agent-e2e-update');
    const newAppBytes = newBinarySource();
    const base = serveRelease({ appBytes: newAppBytes });

    const run = await runInstalledBinary(install, ['--session', 'alpha', '--flag'], { GV_TEST_RELEASES_BASE: base });

    // The parent (old) process reported the update honestly before restarting.
    expect(run.stdout).toContain(`Update available: ${NEW_TAG} (running v${OLD_VERSION}). Downloading and verifying...`);
    expect(run.stdout).toContain(`Updated to ${NEW_TAG}.`);
    expect(run.stdout).toContain(`auto-update: ${NEW_TAG} installed, restarting onto the new version`);

    // The respawned process IS the downloaded payload: it prints the receipt
    // naming both versions, the NEW version banner, and the ORIGINAL argv.
    expect(run.stdout).toContain(`auto-update: updated from v${OLD_VERSION} to v${NEW_VERSION} at launch`);
    expect(run.stdout).toContain(`RUNNING v${NEW_VERSION} argv=["--session","alpha","--flag"] outcome=continue:just-updated`);
    expect(run.stdout).not.toContain('UNEXPECTED-FETCH');
    expect(run.exitCode).toBe(0);

    // The swap happened on disk: live files hold the served payload bytes
    // (binary AND the addon extracted from the verified archive)...
    expect(readFileSync(install.appPath, 'utf-8')).toBe(newAppBytes);
    expect(readFileSync(install.addonPath, 'utf-8')).toBe(NEW_ADDON_BYTES);
    // ...and the outgoing versions are kept byte-identical at .previous.
    expect(readFileSync(`${install.appPath}${PREVIOUS_FILE_SUFFIX}`).equals(install.oldAppBytes)).toBe(true);
    expect(readFileSync(`${install.addonPath}${PREVIOUS_FILE_SUFFIX}`, 'utf-8')).toBe(OLD_ADDON_BYTES);

    // ── rollback, for real, from the swapped state ──────────────────────────
    // rollbackUpdate is exactly what `/update rollback` invokes; only print is
    // captured, the renames are the real filesystem operations.
    const printed: string[] = [];
    rollbackUpdate({
      execPath: install.appPath,
      platform: process.platform,
      arch: process.arch,
      print: (line) => printed.push(line),
    });
    expect(printed.join('\n')).toContain('Rolled back to the previously installed version.');
    expect(readFileSync(install.appPath).equals(install.oldAppBytes)).toBe(true);
    expect(readFileSync(install.addonPath, 'utf-8')).toBe(OLD_ADDON_BYTES);
    // The exchange keeps the rolled-back-from version for one command forward.
    expect(readFileSync(`${install.appPath}${PREVIOUS_FILE_SUFFIX}`, 'utf-8')).toBe(newAppBytes);
    expect(readFileSync(`${install.addonPath}${PREVIOUS_FILE_SUFFIX}`, 'utf-8')).toBe(NEW_ADDON_BYTES);

    // The restored binary RUNS (auto-update disabled for this launch so the
    // still-serving release does not immediately re-update it, which also
    // proves the off switch in a real process).
    const restored = await runInstalledBinary(install, ['--after-rollback'], {
      GV_TEST_RELEASES_BASE: base,
      GV_TEST_DISABLE: '1',
    });
    expect(restored.exitCode).toBe(0);
    expect(restored.stdout).toContain(`RUNNING v${OLD_VERSION} argv=["--after-rollback"] outcome=continue:disabled`);
  }, 30_000);

  test('a corrupted binary checksum swaps NOTHING: not even the already-verified addon: the failure is stated and the current version starts', async () => {
    const install = installOldVersion('gv-agent-e2e-corrupt-bin');
    const base = serveRelease({ appBytes: newBinarySource(), corruptAppChecksum: true });

    const run = await runInstalledBinary(install, ['--work'], { GV_TEST_RELEASES_BASE: base });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('auto-update failed: checksum mismatch for');
    expect(run.stdout).toContain(`starting the current version v${OLD_VERSION}`);
    expect(run.stdout).toContain(`RUNNING v${OLD_VERSION} argv=["--work"] outcome=continue:update-failed`);
    // No swap, no partial state: live bytes untouched, nothing parked.
    expect(readFileSync(install.appPath).equals(install.oldAppBytes)).toBe(true);
    expect(readFileSync(install.addonPath, 'utf-8')).toBe(OLD_ADDON_BYTES);
    expect(() => readFileSync(`${install.appPath}${PREVIOUS_FILE_SUFFIX}`)).toThrow();
    expect(() => readFileSync(`${install.addonPath}${PREVIOUS_FILE_SUFFIX}`)).toThrow();
  }, 30_000);

  test('a corrupted addon-archive checksum also swaps NOTHING: the addon verifies BEFORE the binary swap begins', async () => {
    const install = installOldVersion('gv-agent-e2e-corrupt-addon');
    const base = serveRelease({ appBytes: newBinarySource(), corruptAddonChecksum: true });

    const run = await runInstalledBinary(install, ['--work'], { GV_TEST_RELEASES_BASE: base });

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('auto-update failed: checksum mismatch for');
    expect(run.stdout).toContain(`RUNNING v${OLD_VERSION} argv=["--work"] outcome=continue:update-failed`);
    // The binary was never swapped even though ITS checksum was valid: the
    // strict ordering (addon verified first) protects the binary/addon pair.
    expect(readFileSync(install.appPath).equals(install.oldAppBytes)).toBe(true);
    expect(readFileSync(install.addonPath, 'utf-8')).toBe(OLD_ADDON_BYTES);
    expect(() => readFileSync(`${install.appPath}${PREVIOUS_FILE_SUFFIX}`)).toThrow();
  }, 30_000);

  test('a dead release server yields exactly one offline line and the current version proceeds untouched', async () => {
    const install = installOldVersion('gv-agent-e2e-offline');
    // A server that once existed and is gone: connection refused, instantly.
    const dead = Bun.serve({ port: 0, fetch: () => new Response('') });
    const deadBase = `http://127.0.0.1:${dead.port}`;
    dead.stop(true);

    const run = await runInstalledBinary(install, ['--offline-work'], { GV_TEST_RELEASES_BASE: deadBase });

    expect(run.exitCode).toBe(0);
    const offlineLines = run.stdout.split('\n').filter((line) => line === 'update check skipped: offline');
    expect(offlineLines).toHaveLength(1);
    expect(run.stdout).toContain(`RUNNING v${OLD_VERSION} argv=["--offline-work"] outcome=continue:check-skipped`);
    expect(readFileSync(install.appPath).equals(install.oldAppBytes)).toBe(true);
    expect(() => readFileSync(`${install.appPath}${PREVIOUS_FILE_SUFFIX}`)).toThrow();
  }, 30_000);
});
