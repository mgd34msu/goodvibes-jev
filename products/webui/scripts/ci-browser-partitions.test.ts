import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { JSONReportSuite } from '@playwright/test/reporter';
import type { BrowserInventory } from './ci-browser-inventory-reporter';
import {
  PARTITIONS, assertSameInventory, collect, discover, partitionName, recordOutcome,
  reportInventory, runPartition, verifyDiscovery, verifyExecution,
} from './ci-browser-partitions';
import { installTestCleanup, makeProjectTempDir } from './helpers/project-temp';

installTestCleanup(afterAll);
const projects = ['phone', 'desktop', 'lan-origin'];
function report(names = projects, executed = false): BrowserInventory {
  return {
    tests: names.map((projectName) => ({ id: `id-${projectName}`, projectName,
      expectedStatus: 'passed', status: executed ? 'expected' : 'skipped',
      results: executed ? [{ status: 'passed', retry: 0 }] : [],
    })), errors: [],
  };
}

function json(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}
function environment(values: Record<string, string>, body: () => void): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  Object.assign(process.env, values);
  try { body(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
  }
}

function seedEvidence(output: string): void {
  const full = report();
  const phone = report(['phone']);
  const desktop = report(['desktop', 'lan-origin']);
  const manifest = verifyDiscovery(full, phone, desktop);
  for (const [partition, names] of Object.entries(PARTITIONS)) {
    const path = join(output, 'partitions', `webui-browser-partition-${partition}`);
    mkdirSync(join(path, 'blob-report'), { recursive: true });
    json(join(path, 'outcome.json'), { partition, discovery: 'success', browser: 'success', sha: 'fixture-sha' });
    json(join(path, 'discovery-full.json'), full);
    json(join(path, 'discovery-phone.json'), phone);
    json(join(path, 'discovery-desktop-lan.json'), desktop);
    json(join(path, 'manifest.json'), manifest);
    json(join(path, 'executed.json'), report([...names], true));
    writeFileSync(join(path, 'execution.txt'), `${partition} succeeded`);
    writeFileSync(join(path, 'browser.log'), `${partition} browser log`);
    writeFileSync(join(path, 'blob-report', 'fixture.zip'), 'fixture');
  }
  json(join(output, 'merged-inventory.json'), report(projects, true));
}

describe('browser partition proof', () => {
  test('uses exactly the measured two partitions and rejects unknown selectors', () => {
    expect(PARTITIONS).toEqual({ phone: ['phone'], 'desktop-lan': ['desktop', 'lan-origin'] });
    expect(partitionName('phone')).toBe('phone');
    expect(() => partitionName('desktop')).toThrow('Unknown browser partition');
    expect(() => partitionName(undefined)).toThrow('Unknown browser partition');
    expect(() => partitionName('__proto__')).toThrow('Unknown browser partition');
  });

  test('exact identity multisets reject equal-size omissions, duplicates, and relabelled projects', () => {
    expect(() => assertSameInventory(['a', 'b'], ['b', 'a'], 'same')).not.toThrow();
    expect(() => assertSameInventory(['a', 'a'], ['a'], 'missing')).toThrow('expected 2, received 1');
    expect(() => assertSameInventory(['a', 'b'], ['a', 'a'], 'duplicate')).toThrow('inventory mismatch');
    const full = report();
    expect(verifyDiscovery(full, report(['phone']), report(['desktop', 'lan-origin'])).full).toHaveLength(3);
    full.tests[0].id = 'replacement';
    expect(() => verifyDiscovery(full, report(['phone']), report(['desktop', 'lan-origin']))).toThrow('inventory mismatch');
    const duplicate = report(['phone', 'phone', 'desktop', 'lan-origin']);
    expect(() => verifyDiscovery(duplicate, report(['phone', 'phone']), report(['desktop', 'lan-origin']))).toThrow('duplicate identities');
    expect(() => verifyDiscovery(report(), report(['desktop']), report(['desktop', 'lan-origin']))).toThrow('unexpected project');
  });

  test('discovery requires every named project, no execution, and no report errors', () => {
    expect(() => reportInventory(report([]), 'discovery', projects)).toThrow('empty browser inventory');
    expect(() => reportInventory(report(['phone']), 'discovery', projects)).toThrow('projects: inventory mismatch');
    expect(() => reportInventory(report(projects, true), 'discovery', projects)).toThrow('must not execute');
    const broken = report();
    broken.errors.push('discovery failure');
    expect(() => reportInventory(broken, 'discovery', projects)).toThrow('report has errors');
  });

  test('execution rejects unrun cases, retries, failures, flakes and interruptions but preserves intentional skips', () => {
    expect(() => reportInventory(report(), 'execution', projects)).toThrow('missing execution');
    for (const status of ['unexpected', 'flaky'] as const) {
      const value = report(projects, true);
      value.tests[0].status = status;
      expect(() => reportInventory(value, 'execution', projects)).toThrow(`${status} test`);
    }
    for (const status of ['failed', 'timedOut', 'interrupted'] as const) {
      const value = report(projects, true);
      value.tests[0].results[0].status = status;
      expect(() => reportInventory(value, 'execution', projects)).toThrow('unexpected result');
    }
    const retry = report(projects, true);
    retry.tests[0].results[0].retry = 1;
    expect(() => reportInventory(retry, 'execution', projects)).toThrow('retries are forbidden');
    const duplicate = report(projects, true);
    duplicate.tests[0].results.push(duplicate.tests[0].results[0]);
    expect(() => reportInventory(duplicate, 'execution', projects)).toThrow('unexpected retry');
    const skipped = report(projects, true);
    skipped.tests[0].status = 'skipped';
    skipped.tests[0].results[0].status = 'skipped';
    expect(reportInventory(skipped, 'execution', projects)).toHaveLength(3);
  });

  test('aggregate fails closed for all non-successful dependency and command outcomes', () => {
    const output = makeProjectTempDir('ci-browser-partitions-');
    seedEvidence(output);
    environment({ BUILD_RESULT: 'success', PARTITION_RESULT: 'success', GITHUB_SHA: 'fixture-sha' }, () => {
      expect(() => verifyExecution(output)).not.toThrow();
      for (const key of ['BUILD_RESULT', 'PARTITION_RESULT']) {
        for (const status of ['failure', 'skipped', 'cancelled', '']) {
          environment({ [key]: status }, () => expect(() => verifyExecution(output)).toThrow());
        }
      }
      const path = join(output, 'partitions/webui-browser-partition-phone/outcome.json');
      for (const key of ['discovery', 'browser']) {
        for (const status of ['failure', 'skipped', 'cancelled', '']) {
          json(path, { partition: 'phone', discovery: 'success', browser: 'success', sha: 'fixture-sha', [key]: status });
          expect(() => verifyExecution(output)).toThrow('Incomplete phone');
        }
      }
      json(path, { partition: 'phone', discovery: 'success', browser: 'success', sha: 'different-sha' });
      expect(() => verifyExecution(output)).toThrow('source SHA mismatch');
    });
  });

  test('aggregate checks both raw execution and native merge against both runners discovery', () => {
    const output = makeProjectTempDir('ci-browser-partitions-');
    environment({ BUILD_RESULT: 'success', PARTITION_RESULT: 'success', GITHUB_SHA: 'fixture-sha' }, () => {
      seedEvidence(output);
      const root = join(output, 'partitions/webui-browser-partition-phone');
      json(join(root, 'executed.json'), report(['phone', 'phone'], true));
      expect(() => verifyExecution(output)).toThrow('phone execution: inventory mismatch');
      seedEvidence(output);
      const wrong = report(projects, true);
      wrong.tests[0].id = 'replacement';
      json(join(output, 'merged-inventory.json'), wrong);
      expect(() => verifyExecution(output)).toThrow('Native merged report: inventory mismatch');
      seedEvidence(output);
      const discovery = report();
      discovery.tests[0].id = 'different-runner';
      const phone = report(['phone']);
      phone.tests[0].id = 'different-runner';
      json(join(root, 'discovery-full.json'), discovery);
      json(join(root, 'discovery-phone.json'), phone);
      json(join(root, 'manifest.json'), verifyDiscovery(discovery, phone, report(['desktop', 'lan-origin'])));
      const executed = report(['phone'], true);
      executed.tests[0].id = 'different-runner';
      json(join(root, 'executed.json'), executed);
      expect(() => verifyExecution(output)).toThrow('runner discovery');
      seedEvidence(output);
      rmSync(join(output, 'partitions/webui-browser-partition-desktop-lan'), { recursive: true });
      expect(() => verifyExecution(output)).toThrow();
    });
  });

  test('collector retains labelled logs, and missing/extra blob reports cannot pass', () => {
    const output = makeProjectTempDir('ci-browser-partitions-');
    seedEvidence(output);
    collect(output);
    const logs = readFileSync(join(output, 'browser.log'), 'utf8');
    expect(logs).toContain('=== phone browser.log ===');
    expect(logs).toContain('=== desktop-lan browser.log ===');
    expect(existsSync(join(output, 'blob-report/report-phone.zip'))).toBe(true);
    writeFileSync(join(output, 'partitions/webui-browser-partition-phone/blob-report/extra.zip'), 'duplicate');
    expect(() => collect(output)).toThrow('found 2');
    rmSync(join(output, 'partitions/webui-browser-partition-phone'), { recursive: true });
    expect(() => collect(output)).toThrow('Incomplete browser evidence');
    expect(readFileSync(join(output, 'execution.txt'), 'utf8')).toContain('MISSING: phone/execution.txt');
  });

  test('native Playwright discovery, both execution partitions and blob merge preserve exact identities', () => {
    const cwd = makeProjectTempDir('ci-browser-partitions-');
    mkdirSync(join(cwd, 'node_modules/@playwright'), { recursive: true });
    // The actual installed CLI and reporters run; fixture tests need no browser.
    const cli = resolve(import.meta.dirname, '../node_modules/@playwright/test/cli.js');
    symlinkSync(resolve(cli, '..'), join(cwd, 'node_modules/@playwright/test'), 'dir');
    writeFileSync(join(cwd, 'playwright.config.ts'), `
      import { defineConfig } from '@playwright/test';
      export default defineConfig({ testDir: '.', testMatch: '*.spec.ts', fullyParallel: true, retries: 0,
        projects: [{ name: 'phone', testIgnore: 'lan.spec.ts' }, { name: 'desktop', testIgnore: 'lan.spec.ts' },
          { name: 'lan-origin', testMatch: 'lan.spec.ts' }] });
    `);
    writeFileSync(join(cwd, 'loopback.spec.ts'), `import { test, expect } from '@playwright/test';
      import { writeFileSync } from 'node:fs';
      test('passes', async ({}, testInfo) => {
        expect(1).toBe(1);
        const path = testInfo.outputPath('fixture-proof.txt');
        writeFileSync(path, 'retained browser evidence');
        await testInfo.attach('fixture-proof', { path, contentType: 'text/plain' });
      });
      test('intentional skip', () => test.skip(true, 'viewport fixture'));
    `);
    writeFileSync(join(cwd, 'lan.spec.ts'), `import { test, expect } from '@playwright/test';
      test('third project', () => expect(2).toBe(2));
    `);
    discover(cwd);
    const aggregate = join(cwd, 'combined');
    for (const partition of Object.keys(PARTITIONS) as (keyof typeof PARTITIONS)[]) {
      expect(runPartition(partition, cwd)).toBe(0);
      environment({ DISCOVERY_OUTCOME: 'success', BROWSER_OUTCOME: 'success', GITHUB_SHA: 'fixture-sha' }, () => recordOutcome(partition, join(cwd, 'e2e/.artifacts')));
      writeFileSync(join(cwd, 'e2e/.artifacts/browser.log'), `${partition} fixture log`);
      cpSync(join(cwd, 'e2e/.artifacts'), join(aggregate, 'partitions', `webui-browser-partition-${partition}`), { recursive: true });
    }
    environment({ BUILD_RESULT: 'success', PARTITION_RESULT: 'success', GITHUB_SHA: 'fixture-sha' }, () => {
      collect(aggregate);
      const merge = spawnSync('node', [cli, 'merge-reports', `--reporter=html,json,${resolve(import.meta.dirname, 'ci-browser-inventory-reporter.ts')}`, join(aggregate, 'blob-report')], {
        cwd, encoding: 'utf8', env: { ...process.env, PLAYWRIGHT_HTML_OPEN: 'never',
          PLAYWRIGHT_HTML_OUTPUT_DIR: join(aggregate, 'report'), PLAYWRIGHT_JSON_OUTPUT_FILE: join(aggregate, 'report.json'),
          BROWSER_INVENTORY_OUTPUT: join(aggregate, 'merged-inventory.json') },
      });
      expect(merge.status, merge.stdout + merge.stderr).toBe(0);
      expect(existsSync(join(aggregate, 'report/index.html'))).toBe(true);
      const merged = JSON.parse(readFileSync(join(aggregate, 'report.json'), 'utf8')) as { suites: JSONReportSuite[] };
      const attachments = (suites: JSONReportSuite[]): string[] => suites.flatMap((suite) => [
        ...suite.specs.flatMap((spec) => spec.tests.flatMap((entry) => entry.results.flatMap((result) =>
          result.attachments.filter((attachment) => attachment.name === 'fixture-proof').map((attachment) => attachment.path!)))),
        ...attachments(suite.suites ?? []),
      ]);
      const retained = attachments(merged.suites);
      expect(retained).toHaveLength(2);
      for (const path of retained) expect(readFileSync(resolve(cwd, path), 'utf8')).toBe('retained browser evidence');
      expect(() => verifyExecution(aggregate)).not.toThrow();
      const verified = JSON.parse(readFileSync(join(aggregate, 'inventory-verification.json'), 'utf8')) as { identities: string[] };
      expect(verified.identities).toHaveLength(5);
    });
  }, 60_000);
});
