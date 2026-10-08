/** Two independently scheduled browser lanes, with exact discovery/execution proof. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { BrowserInventory } from './ci-browser-inventory-reporter';

export const PARTITIONS = {
  phone: ['phone'],
  'desktop-lan': ['desktop', 'lan-origin'],
} as const;
export type Partition = keyof typeof PARTITIONS;
const PROJECTS = Object.values(PARTITIONS).flat();
const ARTIFACTS = 'e2e/.artifacts';
const CLI = 'node_modules/@playwright/test/cli.js';
const REPORTER = resolve(import.meta.dirname, 'ci-browser-inventory-reporter.ts');

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
export function partitionName(name: string | undefined): Partition {
  check(name && Object.hasOwn(PARTITIONS, name), `Unknown browser partition: ${name ?? '(missing)'}`);
  return name as Partition;
}

/** A multiset, not a count: an omission cannot be hidden by a duplicate. */
export function assertSameInventory(expected: readonly string[], actual: readonly string[], label: string): void {
  const counts = (values: readonly string[]): Map<string, number> => {
    const result = new Map<string, number>();
    for (const value of values) result.set(value, (result.get(value) ?? 0) + 1);
    return result;
  };
  const left = counts(expected);
  const right = counts(actual);
  const differences = [...new Set([...left.keys(), ...right.keys()])]
    .filter((key) => left.get(key) !== right.get(key))
    .map((key) => `${key}: expected ${left.get(key) ?? 0}, received ${right.get(key) ?? 0}`);
  check(!differences.length, `${label}: inventory mismatch\n${differences.join('\n')}`);
}

export function reportInventory(report: BrowserInventory, mode: 'discovery' | 'execution', projects: readonly string[]): string[] {
  check(Array.isArray(report.errors) && report.errors.length === 0, `${mode}: report has errors or is incomplete`);
  check(Array.isArray(report.tests), `${mode}: missing tests`);
  const identities: string[] = [];
  const seenProjects = new Set<string>();
  for (const test of report.tests) {
    check(typeof test.id === 'string' && test.id.length > 0, `${mode}: missing test identity`);
    check(projects.includes(test.projectName), `${mode}: unexpected project ${test.projectName}`);
    check(Array.isArray(test.results), `${mode}: missing results`);
    if (mode === 'discovery') check(test.results.length === 0, 'Discovery must not execute tests');
    else verifyResult(test);
    seenProjects.add(test.projectName);
    identities.push(JSON.stringify([test.projectName, test.id]));
  }
  check(identities.length > 0, `${mode}: empty browser inventory`);
  assertSameInventory(projects, [...seenProjects], `${mode} projects`);
  return identities.sort();
}

function verifyResult(test: BrowserInventory['tests'][number]): void {
  check(test.results.length === 1, `${test.projectName}: missing execution or unexpected retry`);
  const result = test.results[0];
  check(result.retry === 0, `${test.projectName}: retries are forbidden`);
  check(test.status === 'expected' || test.status === 'skipped', `${test.projectName}: ${test.status} test`);
  check(test.status === 'skipped' ? result.status === 'skipped' : result.status === test.expectedStatus, `${test.projectName}: unexpected result ${result.status}`);
  check(result.status !== 'interrupted' && result.status !== 'timedOut', `${test.projectName}: incomplete execution`);
}

export interface Manifest {
  full: string[];
  partitions: Record<Partition, string[]>;
}

export function verifyDiscovery(full: BrowserInventory, phone: BrowserInventory, desktopLan: BrowserInventory): Manifest {
  const manifest: Manifest = {
    full: reportInventory(full, 'discovery', PROJECTS),
    partitions: {
      phone: reportInventory(phone, 'discovery', PARTITIONS.phone),
      'desktop-lan': reportInventory(desktopLan, 'discovery', PARTITIONS['desktop-lan']),
    },
  };
  const union = Object.values(manifest.partitions).flat();
  check(new Set(union).size === union.length, 'Browser partitions overlap or contain duplicate identities');
  assertSameInventory(manifest.full, union, 'Full discovery versus partition union');
  return manifest;
}

/** Runs on each hosted runner before execution. Real LAN admission is unchanged. */
export function discover(cwd = process.cwd()): void {
  const output = join(cwd, ARTIFACTS);
  mkdirSync(output, { recursive: true });
  const list = (name: string, projects: readonly string[]): BrowserInventory => {
    const result = spawnSync('node', [CLI, 'test', '--list', `--reporter=json,${REPORTER}`, ...projects.map((p) => `--project=${p}`)], {
      cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      // Do not inherit an execution report destination into discovery.
      env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: '', PLAYWRIGHT_JSON_OUTPUT_FILE: '',
        BROWSER_INVENTORY_OUTPUT: join(output, `discovery-${name}.json`) },
    });
    writeFileSync(join(output, `discovery-${name}-report.json`), result.stdout ?? '');
    writeFileSync(join(output, `discovery-${name}.log`), result.stderr ?? '');
    check(!result.error && result.status === 0, `Browser ${name} discovery failed: ${result.error?.message ?? result.stderr}`);
    return readJson<BrowserInventory>(join(output, `discovery-${name}.json`));
  };
  const full = list('full', PROJECTS);
  const phone = list('phone', PARTITIONS.phone);
  const desktopLan = list('desktop-lan', PARTITIONS['desktop-lan']);
  const manifest = verifyDiscovery(full, phone, desktopLan);
  writeJson(join(output, 'manifest.json'), manifest);
  console.log(`Verified ${manifest.full.length} browser identities: full discovery equals the disjoint partition union.`);
}

export function runPartition(partition: Partition, cwd = process.cwd()): number {
  // Do not run without successful full/disjoint discovery on this very runner.
  const output = join(cwd, ARTIFACTS);
  const manifest = readJson<Manifest>(join(output, 'manifest.json'));
  check(manifest.partitions[partition].length > 0, `Missing ${partition} discovery`);
  const result = spawnSync('node', [CLI, 'test', ...PARTITIONS[partition].map((p) => `--project=${p}`), '--workers=2', `--reporter=list,blob,json,${REPORTER}`], {
    cwd, stdio: 'inherit', env: {
      ...process.env,
      PLAYWRIGHT_JSON_OUTPUT_FILE: join(output, 'executed-report.json'),
      BROWSER_INVENTORY_OUTPUT: join(output, 'executed.json'),
      PLAYWRIGHT_BLOB_OUTPUT_DIR: join(output, 'blob-report'),
      PLAYWRIGHT_BLOB_OUTPUT_NAME: `report-${partition}.zip`,
    },
  });
  check(!result.error, `Cannot start browser partition: ${result.error?.message}`);
  return result.status ?? 1;
}

interface Outcome { partition: Partition; discovery: string; browser: string; sha: string }
export function recordOutcome(partition: Partition, output = ARTIFACTS): void {
  mkdirSync(output, { recursive: true });
  const outcome: Outcome = {
    partition, discovery: process.env.DISCOVERY_OUTCOME ?? 'missing',
    browser: process.env.BROWSER_OUTCOME ?? 'missing', sha: process.env.GITHUB_SHA ?? 'local',
  };
  writeJson(join(output, 'outcome.json'), outcome);
  const summary = `Partition: ${partition}\nDiscovery outcome: ${outcome.discovery}\nBrowser command outcome: ${outcome.browser}\nA setup, build, or launch failure is not a passing browser assertion.\n`;
  writeFileSync(join(output, 'execution.txt'), summary);
  console.log(summary);
}

function partitionDirectory(output: string, partition: Partition): string {
  return join(output, 'partitions', `webui-browser-partition-${partition}`);
}

/** Preserve readable root evidence even when a runner never uploaded a report. */
export function collect(output = ARTIFACTS): void {
  mkdirSync(output, { recursive: true });
  const summaries = [`Build job: ${process.env.BUILD_RESULT ?? 'missing'}\nBrowser partition jobs: ${process.env.PARTITION_RESULT ?? 'missing'}\n`];
  const logs: string[] = [];
  const missing: string[] = [];
  for (const partition of Object.keys(PARTITIONS) as Partition[]) {
    const source = partitionDirectory(output, partition);
    const readEvidence = (name: string): string => {
      const path = join(source, name);
      if (existsSync(path)) return readFileSync(path, 'utf8');
      missing.push(`${partition}/${name}`);
      return `MISSING: ${partition}/${name}\n`;
    };
    summaries.push(`=== ${partition} ===\n${readEvidence('execution.txt')}`);
    logs.push(`=== ${partition} browser.log ===\n${readEvidence('browser.log')}`);
    const blobDir = join(source, 'blob-report');
    const files = existsSync(blobDir) ? readdirSync(blobDir).filter((name) => name.endsWith('.zip')) : [];
    if (files.length !== 1) missing.push(`${partition}: expected exactly one native blob report, found ${files.length}`);
    else {
      mkdirSync(join(output, 'blob-report'), { recursive: true });
      copyFileSync(join(blobDir, files[0]), join(output, 'blob-report', `report-${partition}.zip`));
    }
  }
  writeFileSync(join(output, 'execution.txt'), summaries.join('\n'));
  writeFileSync(join(output, 'browser.log'), logs.join('\n'));
  check(missing.length === 0, `Incomplete browser evidence:\n${missing.join('\n')}`);
}

export function verifyExecution(output = ARTIFACTS): void {
  check(process.env.BUILD_RESULT === 'success', `Build job did not succeed: ${process.env.BUILD_RESULT}`);
  check(process.env.PARTITION_RESULT === 'success', `Not every browser partition job succeeded: ${process.env.PARTITION_RESULT}`);
  let canonical: Manifest | undefined;
  const executed: string[] = [];
  for (const partition of Object.keys(PARTITIONS) as Partition[]) {
    const source = partitionDirectory(output, partition);
    const outcome = readJson<Outcome>(join(source, 'outcome.json'));
    check(outcome.partition === partition && outcome.discovery === 'success' && outcome.browser === 'success', `Incomplete ${partition} command outcome`);
    check(outcome.sha === process.env.GITHUB_SHA, `${partition}: evidence source SHA mismatch`);
    const manifest = verifyDiscovery(
      readJson<BrowserInventory>(join(source, 'discovery-full.json')),
      readJson<BrowserInventory>(join(source, 'discovery-phone.json')),
      readJson<BrowserInventory>(join(source, 'discovery-desktop-lan.json')),
    );
    const recorded = readJson<Manifest>(join(source, 'manifest.json'));
    assertSameInventory(manifest.full, recorded.full, `${partition} recorded manifest`);
    for (const name of Object.keys(PARTITIONS) as Partition[]) {
      assertSameInventory(manifest.partitions[name], recorded.partitions[name], `${partition} recorded ${name}`);
      if (canonical) assertSameInventory(canonical.partitions[name], manifest.partitions[name], `${partition} runner discovery ${name}`);
    }
    if (canonical) assertSameInventory(canonical.full, manifest.full, 'Runner full discoveries');
    canonical = manifest;
    const identities = reportInventory(readJson<BrowserInventory>(join(source, 'executed.json')), 'execution', PARTITIONS[partition]);
    assertSameInventory(manifest.partitions[partition], identities, `${partition} execution`);
    executed.push(...identities);
  }
  check(canonical, 'Missing canonical browser discovery');
  assertSameInventory(canonical.full, executed, 'Combined execution');
  const merged = reportInventory(readJson<BrowserInventory>(join(output, 'merged-inventory.json')), 'execution', PROJECTS);
  assertSameInventory(canonical.full, merged, 'Native merged report');
  writeJson(join(output, 'inventory-verification.json'), { complete: true, identities: canonical.full, partitions: canonical.partitions });
  console.log(`Verified all ${merged.length} discovered browser identities exactly once across both successful partitions and the merged report.`);
}

if (import.meta.main) {
  try {
    const [command, name] = process.argv.slice(2);
    if (command === 'discover') discover();
    else if (command === 'run') process.exitCode = runPartition(partitionName(name));
    else if (command === 'record') recordOutcome(partitionName(name));
    else if (command === 'collect') collect();
    else if (command === 'verify') verifyExecution();
    else throw new Error(`Unknown browser proof command: ${command}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
