#!/usr/bin/env bun
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { requiredTarballPaths, verifyPackageCliInstall } from '../src/cli/package-verification.ts';

const report = verifyPackageCliInstall(process.cwd());
const BUN_GLOBAL_INSTALL_TIMEOUT_MS = 420_000;
const CONNECTED_HOST_TOKEN_SENTINEL = 'goodvibes-agent-install-smoke-token-do-not-print-4c8f7f4d';

if (report.issues.length > 0) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

function redactSensitiveOutput(output: string): string {
  return output.replaceAll(CONNECTED_HOST_TOKEN_SENTINEL, '[redacted-connected-host-token]');
}

function assertNoSensitiveOutput(label: string, output: string): void {
  if (output.includes(CONNECTED_HOST_TOKEN_SENTINEL)) {
    throw new Error(`${label} printed the connected-host token sentinel`);
  }
}

function run(command: string, args: readonly string[], options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {}): string {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs,
  });
  if (result.error) {
    throw result.error;
  }
  assertNoSensitiveOutput(`${command} ${args.join(' ')} stdout`, result.stdout);
  assertNoSensitiveOutput(`${command} ${args.join(' ')} stderr`, result.stderr);
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(' ')} failed with exit ${result.status ?? 'signal'}`,
      redactSensitiveOutput(result.stdout.trim()),
      redactSensitiveOutput(result.stderr.trim()),
    ].filter(Boolean).join('\n'));
  }
  return result.stdout;
}

function runExpectingExit(
  command: string,
  args: readonly string[],
  expectedExitCode: number,
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv } = {},
): { readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  assertNoSensitiveOutput(`${command} ${args.join(' ')} stdout`, result.stdout);
  assertNoSensitiveOutput(`${command} ${args.join(' ')} stderr`, result.stderr);
  if (result.status !== expectedExitCode) {
    throw new Error([
      `${command} ${args.join(' ')} exited ${result.status ?? 'signal'}, expected ${expectedExitCode}`,
      redactSensitiveOutput(result.stdout.trim()),
      redactSensitiveOutput(result.stderr.trim()),
    ].filter(Boolean).join('\n'));
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function runAllowingExit(
  command: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly timeoutMs?: number } = {},
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs,
  });
  if (result.error) {
    throw result.error;
  }
  assertNoSensitiveOutput(`${command} ${args.join(' ')} stdout`, result.stdout);
  assertNoSensitiveOutput(`${command} ${args.join(' ')} stderr`, result.stderr);
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function hasExecutableBit(path: string): boolean {
  return (statSync(path).mode & 0o111) !== 0;
}

function extractPackTarballPath(packOutput: string, packDir: string): string {
  const lines = packOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const filename = lines[lines.length - 1];
  if (!filename) {
    throw new Error('bun pm pack did not return a tarball filename');
  }
  return isAbsolute(filename) ? filename : join(packDir, filename);
}

function installCheckTempParent(): string {
  const configured = process.env.GOODVIBES_AGENT_INSTALL_CHECK_TMPDIR ?? process.env.RUNNER_TEMP;
  const parent = configured && configured.trim().length > 0
    ? configured
    : join(homedir(), '.cache', 'goodvibes-agent', 'install-check');
  mkdirSync(parent, { recursive: true });
  return parent;
}

function assertInstalledTuiLaunches(env: NodeJS.ProcessEnv, tempRoot: string): void {
  const transcriptPath = join(tempRoot, 'tui-launch.typescript');
  const command = 'timeout -s INT -k 1s 2s goodvibes-agent --no-alt-screen';
  const result = runAllowingExit('script', ['-qfec', command, transcriptPath], {
    env,
    timeoutMs: 5_000,
  });
  const transcript = existsSync(transcriptPath) ? readFileSync(transcriptPath, 'utf-8') : '';
  assertNoSensitiveOutput('installed Agent TUI launch transcript', transcript);
  assertNoSensitiveOutput('installed Agent TUI launch stdout', result.stdout);
  assertNoSensitiveOutput('installed Agent TUI launch stderr', result.stderr);
  if (result.status !== 124 && result.status !== 137) {
    throw new Error([
      `installed Agent TUI launch exited ${result.status ?? 'without status'}, expected timeout after staying alive`,
      redactSensitiveOutput(result.stdout.trim()),
      redactSensitiveOutput(result.stderr.trim()),
      redactSensitiveOutput(transcript.trim()),
    ].filter(Boolean).join('\n'));
  }
  if (transcript.includes('goodvibes-agent failed to launch')) {
    throw new Error(`installed Agent TUI launch failed during startup:\n${redactSensitiveOutput(transcript)}`);
  }
  const plainTranscript = transcript
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '')
    .replace(/\s+/g, ' ');
  if (plainTranscript.includes('GoodVibes Agent') || plainTranscript.includes('Onboarding Wizard')) {
    return;
  }
  const transcriptOnlyHasScriptEnvelope = /Script started .*Script done/.test(plainTranscript)
    && !plainTranscript.includes('goodvibes-agent failed to launch')
    && !/\b(error|failed|exception)\b/i.test(plainTranscript.replace(/not executed on terminal/gi, ''));
  if (transcript.trim().length === 0 || transcriptOnlyHasScriptEnvelope) {
    console.warn('installed Agent TUI launch stayed alive, but the PTY transcript did not capture shell output; accepting timeout-based launch smoke');
    return;
  }
  throw new Error(`installed Agent TUI launch transcript did not contain the Agent shell:\n${redactSensitiveOutput(transcript)}`);
}

function assertInstalledRequiredPackagePaths(installedPackageRoot: string): void {
  for (const requiredPath of requiredTarballPaths(process.cwd())) {
    const installedPath = join(installedPackageRoot, requiredPath);
    if (!existsSync(installedPath)) {
      throw new Error(`installed package is missing required package path: ${installedPath}`);
    }
    const installedStat = statSync(installedPath);
    if (!installedStat.isFile()) {
      throw new Error(`installed required package path is not a file: ${installedPath}`);
    }
    if (installedStat.size <= 0) {
      throw new Error(`installed required package path is empty: ${installedPath}`);
    }
  }
}

function writeConnectedHostTokenSentinel(homeDirectory: string): void {
  const tokenDir = join(homeDirectory, '.goodvibes', 'daemon');
  mkdirSync(tokenDir, { recursive: true });
  writeFileSync(join(tokenDir, 'operator-tokens.json'), `${JSON.stringify({ token: CONNECTED_HOST_TOKEN_SENTINEL })}\n`, { mode: 0o600 });
}

const tempRoot = mkdtempSync(join(installCheckTempParent(), 'goodvibes-agent-install-check-'));
try {
  const packDir = join(tempRoot, 'pack');
  const bareBunInstallDir = join(tempRoot, 'bun-bare');
  const bareBunCacheDir = join(tempRoot, 'bun-bare-cache');
  const bareHomeDir = join(tempRoot, 'home-bare');
  const bareTempDir = join(tempRoot, 'tmp-bare');
  const bareWorkspaceDir = join(tempRoot, 'workspace-bare');
  mkdirSync(packDir, { recursive: true });
  mkdirSync(bareBunInstallDir, { recursive: true });
  mkdirSync(bareBunCacheDir, { recursive: true });
  mkdirSync(bareHomeDir, { recursive: true });
  mkdirSync(bareTempDir, { recursive: true });
  mkdirSync(bareWorkspaceDir, { recursive: true });
  writeConnectedHostTokenSentinel(bareHomeDir);

  const packOutput = run('bun', ['pm', 'pack', '--destination', packDir, '--quiet']);
  const tarballPath = extractPackTarballPath(packOutput, packDir);
  if (!existsSync(tarballPath)) {
    throw new Error(`bun pm pack did not create expected tarball: ${tarballPath}`);
  }

  const bareInstallEnv = {
    ...process.env,
    HOME: bareHomeDir,
    BUN_INSTALL: bareBunInstallDir,
    BUN_CACHE_DIR: bareBunCacheDir,
    TMPDIR: bareTempDir,
  };
  run('bun', ['add', '-g', tarballPath, '--registry', 'https://registry.npmjs.org'], {
    cwd: tempRoot,
    env: bareInstallEnv,
    timeoutMs: BUN_GLOBAL_INSTALL_TIMEOUT_MS,
  });
  const bareSmokeEnv = {
    ...process.env,
    HOME: bareHomeDir,
    BUN_INSTALL: bareBunInstallDir,
    BUN_CACHE_DIR: bareBunCacheDir,
    TMPDIR: bareTempDir,
    GOODVIBES_WORKING_DIR: bareWorkspaceDir,
    PATH: `${join(bareBunInstallDir, 'bin')}:${process.env.PATH ?? ''}`,
  };
  const bareHelp = run('goodvibes-agent', ['--help'], { env: bareSmokeEnv });
  assertNoSensitiveOutput('installed bare --help output', bareHelp);
  if (!bareHelp.includes('goodvibes-agent') || bareHelp.includes('tui|launch')) {
    throw new Error('Bun global install did not expose current Agent help');
  }

  const binPath = join(bareBunInstallDir, 'bin', 'goodvibes-agent');
  if (!existsSync(binPath)) {
    throw new Error(`installed bin is missing: ${binPath}`);
  }
  if (!hasExecutableBit(binPath)) {
    throw new Error(`installed bin is not executable: ${binPath}`);
  }

  const binStat = lstatSync(binPath);
  const resolvedBinPath = binStat.isSymbolicLink() ? realpathSync(binPath) : binPath;
  const binSource = readFileSync(resolvedBinPath, 'utf-8');
  if (!binSource.startsWith('#!/usr/bin/env bun')) {
    throw new Error(`installed bin does not use the Bun shebang: ${resolvedBinPath}`);
  }
  const installedPackageRoot = join(dirname(resolvedBinPath), '..');
  const installedRuntimeEntry = join(installedPackageRoot, 'dist', 'package', 'main.js');
  if (!existsSync(installedRuntimeEntry)) {
    throw new Error(`installed package is missing bundled runtime: ${installedRuntimeEntry}`);
  }
  if (statSync(installedRuntimeEntry).size <= 0) {
    throw new Error(`installed bundled runtime is empty: ${installedRuntimeEntry}`);
  }
  assertInstalledRequiredPackagePaths(installedPackageRoot);
  const installedRuntimeSource = readFileSync(installedRuntimeEntry, 'utf-8');
  const forbiddenRuntimeFragments = [
    'node_modules/jsdom/lib/jsdom/browser/default-stylesheet.css',
    '../../../browser/default-stylesheet.css',
    'require.resolve("./xhr-sync-worker.js")',
  ] as const;
  for (const fragment of forbiddenRuntimeFragments) {
    if (installedRuntimeSource.includes(fragment)) {
      throw new Error(`installed bundled runtime leaked a build-machine dependency path: ${fragment}`);
    }
  }

  const help = run('goodvibes-agent', ['--help'], { env: bareSmokeEnv });
  assertNoSensitiveOutput('installed --help output', help);
  if (!help.includes('goodvibes-agent')) {
    throw new Error('installed --help output did not identify goodvibes-agent');
  }

  const version = run('goodvibes-agent', ['--version'], { env: bareSmokeEnv }).trim();
  assertNoSensitiveOutput('installed --version output', version);
  if (!version.includes(report.version)) {
    throw new Error(`installed --version output did not include ${report.version}: ${version}`);
  }

  const status = run('goodvibes-agent', ['status', '--json'], { env: bareSmokeEnv });
  assertNoSensitiveOutput('installed status --json output', status);
  if (!status.includes('"title"') || !status.includes('GoodVibes Agent status')) {
    throw new Error('installed status --json did not report Agent surface state');
  }

  for (const command of ['serve', 'daemon', 'service', 'web', 'surfaces', 'remote'] as const) {
    const blocked = runExpectingExit('goodvibes-agent', [command], 2, { env: bareSmokeEnv });
    assertNoSensitiveOutput(`installed blocked ${command} stdout`, blocked.stdout);
    assertNoSensitiveOutput(`installed blocked ${command} stderr`, blocked.stderr);
    if (blocked.stdout.trim().length > 0) {
      throw new Error(`${command} lifecycle block should write guidance to stderr, not stdout`);
    }
    if (!blocked.stderr.includes(`Unsupported command: ${command}.`)) {
      throw new Error(`${command} lifecycle block did not explain the blocked command:\n${blocked.stderr}`);
    }
  }

  assertInstalledTuiLaunches(bareSmokeEnv, tempRoot);

  console.log(`package install check passed (${report.bins.length} bins, ${report.tarball.entryCount} packed files, Bun global command + Agent TUI launch smoke ok)`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
