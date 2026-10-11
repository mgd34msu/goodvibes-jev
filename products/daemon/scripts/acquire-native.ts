#!/usr/bin/env bun
/** Acquire only the current private monorepo's explicitly selected qualified CI cohort. */
import { execFileSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readTarGzEntries } from '@goodvibes-jev/engine/sdk/platform/browser';
import { UpdateTransactionError } from '@goodvibes-jev/engine/sdk/platform/runtime/self-update';
import { daemonCiPayloads, type DaemonNativeTarget } from '../src/cli/native-artifact.ts';
import { assertNativeInstallHost, installDaemonNative, parseNativeInstallArgs, readDaemonInstallOwner, type DaemonInstallOwner } from './install-native.ts';

export const DAEMON_CI_REPOSITORY = 'mgd34msu/goodvibes-jev';
const ARTIFACT = 'daemon-native-linux-x64';
const ARCHIVE = `${ARTIFACT}.tgz`;
export type RunGitHub = (args: readonly string[]) => string;
const runGitHub: RunGitHub = args => {
  try {
    return execFileSync('gh', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GH_HOST: 'github.com', GH_PROMPT_DISABLED: '1' } });
  } catch { throw new Error('GitHub CLI acquisition failed; check existing github.com access and the exact CI run. No fallback source is used.'); }
};
interface RunIdentity { id: number; run_attempt: number; head_sha: string; path: string; status: string; conclusion: string; repository: { full_name: string }; }
function api(gh: RunGitHub, endpoint: string): unknown {
  return JSON.parse(gh(['api', '--hostname', 'github.com', endpoint]));
}
function admitRun(value: unknown, runId: string, owner: DaemonInstallOwner): RunIdentity {
  const run = value as RunIdentity;
  if (!run || String(run.id) !== runId || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
    || run.repository?.full_name !== DAEMON_CI_REPOSITORY || run.path !== '.github/workflows/ci.yml'
    || run.head_sha !== owner.headCommit || run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Error('Expected the successful current-repository CI workflow at the exact requested run/head');
  }
  return run;
}
function admitJobs(gh: RunGitHub, base: string, attempt: number): void {
  const pages = JSON.parse(gh(['api', '--hostname', 'github.com', '--paginate', '--slurp', `${base}/attempts/${attempt}/jobs?per_page=100`])) as Array<{ jobs: Array<{ name: string; conclusion: string; status: string; run_attempt: number }> }>;
  if (!Array.isArray(pages)) throw new Error('Missing CI job evidence');
  const jobs = pages.flatMap(page => page.jobs);
  for (const name of ['Product tests (daemon)', 'Daemon native artifact (isolated Linux)']) {
    const matching = jobs.filter(job => job.name === name);
    if (matching.length !== 1 || matching[0]?.run_attempt !== attempt || matching[0].status !== 'completed' || matching[0].conclusion !== 'success') throw new Error(`CI qualification is missing or unsuccessful: ${name}`);
  }
}
function artifactIdentity(gh: RunGitHub, base: string, owner: DaemonInstallOwner): number {
  const pages = JSON.parse(gh(['api', '--hostname', 'github.com', '--paginate', '--slurp', `${base}/artifacts?per_page=100`])) as Array<{ artifacts: Array<{ id: number; name: string; expired: boolean; workflow_run: { head_sha: string } }> }>;
  if (!Array.isArray(pages)) throw new Error('Missing CI artifact evidence');
  const artifacts = pages.flatMap(page => page.artifacts).filter(item => item.name === ARTIFACT);
  const item = artifacts[0];
  if (artifacts.length !== 1 || !item || !Number.isSafeInteger(item.id) || item.id < 1 || item.expired !== false || item.workflow_run?.head_sha !== owner.headCommit) throw new Error('Expected one unexpired matching daemon native CI artifact');
  return item.id;
}

/** Admit all archive paths/types/modes before writing; never extract arbitrary archive paths. */
export function stageDaemonCiArchive(archive: Uint8Array, root: string, target: DaemonNativeTarget = 'linux-x64'): string {
  const members = [...daemonCiPayloads(target), 'ci-artifact.json'].map(path => `products/daemon/native/${path}`);
  if (archive.length > 256 * 1024 * 1024) throw new Error('CI archive exceeds the compressed size limit');
  const entries = [...readTarGzEntries(archive, { strict: true, maxOutputLength: 512 * 1024 * 1024 })];
  if (entries.length !== members.length || new Set(entries.map(entry => entry.path)).size !== members.length) throw new Error('Expected the exact daemon native archive cohort');
  for (const entry of entries) {
    const index = members.indexOf(entry.path);
    if (index < 0 || entry.kind !== 'file' || entry.mode !== (index < 2 ? 0o755 : 0o644)) throw new Error('Unexpected archive path, type or mode');
  }
  mkdirSync(root, { mode: 0o700 });
  for (const entry of entries) {
    const target = join(root, entry.path); mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data, { flag: 'wx', mode: entry.mode }); chmodSync(target, entry.mode);
  }
  return join(root, 'products/daemon');
}

// Keep acquisition closed until CI has a real same-artifact ARM64 consumer gate.
export function assertQualifiedDaemonAcquisitionTarget(target: DaemonNativeTarget): void {
  daemonCiPayloads(target);
  if (target !== 'linux-x64') throw new Error('ARM64 CI acquisition is disabled pending same-artifact ARM64 qualification');
}

export async function acquireDaemonNative(options: { readonly runId: string; readonly prefix: string; readonly owner: DaemonInstallOwner; readonly gh?: RunGitHub; readonly signal?: AbortSignal }): Promise<void> {
  const { runId, prefix, signal } = options; const owner = { ...options.owner }; const gh = options.gh ?? runGitHub;
  assertQualifiedDaemonAcquisitionTarget(owner.target);
  assertNativeInstallHost(process.platform, process.arch, owner.target);
  if (!/^[1-9]\d*$/.test(runId) || !Number.isSafeInteger(Number(runId))) throw new Error('Expected an exact positive CI run ID');
  parseNativeInstallArgs(['rollback', '--prefix', prefix]);
  signal?.throwIfAborted();
  const base = `repos/${DAEMON_CI_REPOSITORY}/actions/runs/${runId}`;
  const run = admitRun(api(gh, base), runId, owner); admitJobs(gh, base, run.run_attempt);
  const artifactId = artifactIdentity(gh, base, owner);
  const scratch = mkdtempSync(join(tmpdir(), 'daemon-ci-acquire-'));
  try {
    const downloaded = join(scratch, 'download'); mkdirSync(downloaded);
    gh(['run', 'download', runId, '--repo', `https://github.com/${DAEMON_CI_REPOSITORY}`, '--name', ARTIFACT, '--dir', downloaded]);
    signal?.throwIfAborted();
    const archiveStat = lstatSync(join(downloaded, ARCHIVE));
    if (readdirSync(downloaded).join(',') !== ARCHIVE || !archiveStat.isFile()) throw new Error('Unexpected CI artifact download layout');
    if (archiveStat.size > 256 * 1024 * 1024) throw new Error('CI archive exceeds the compressed size limit');
    const artifactRoot = stageDaemonCiArchive(readFileSync(join(downloaded, ARCHIVE)), join(scratch, 'staged'), owner.target);
    const current = admitRun(api(gh, base), runId, owner);
    if (current.run_attempt !== run.run_attempt || artifactIdentity(gh, base, owner) !== artifactId) throw new Error('CI run/artifact identity changed during acquisition');
    await installDaemonNative({ artifactRoot, prefix, owner, ...(signal ? { signal } : {}) });
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try {
    const values = new Map<string, string>(); const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]!; const value = args[i + 1];
      if (!['--run-id', '--prefix', '--source-commit', '--head-commit'].includes(key) || !value || value.startsWith('--') || values.has(key)) throw new Error('Expected --run-id ID --prefix ABSOLUTE_PATH --source-commit SHA --head-commit SHA');
      values.set(key, value);
    }
    if (values.size !== 4) throw new Error('Expected --run-id ID --prefix ABSOLUTE_PATH --source-commit SHA --head-commit SHA');
    const owner = readDaemonInstallOwner(resolve(import.meta.dir, '../../..'), values.get('--source-commit')!, values.get('--head-commit')!);
    await acquireDaemonNative({ runId: values.get('--run-id')!, prefix: values.get('--prefix')!, owner });
    console.log('[native:acquire] Qualified CI cohort installed. No service or automatic updater was configured.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof UpdateTransactionError && error.receipt.recoveryRequired) console.error(JSON.stringify(error.receipt));
    process.exitCode = 1;
  }
}
