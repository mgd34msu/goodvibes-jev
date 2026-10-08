/** Scheduling and evidence contracts for the required browser check. */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PARTITIONS } from '../../../products/webui/scripts/ci-browser-partitions';

interface Step {
  name: string; id?: string; if?: string; run?: string; uses?: string;
  env?: Record<string, string>; with?: Record<string, unknown>; 'continue-on-error'?: boolean;
}
interface Job {
  name?: string; needs?: string[]; if?: string; 'timeout-minutes'?: number;
  strategy?: { 'fail-fast': boolean; matrix: { partition: string[] } };
  env?: Record<string, string>; steps: Step[];
}
const root = resolve(import.meta.dirname, '../../..');
const workflow = Bun.YAML.parse(readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> };
const partitions = workflow.jobs['webui-browser-partitions'];
const aggregate = workflow.jobs['webui-browser'];
function step(job: Job, name: string): Step {
  const found = job.steps.find((value) => value.name === name);
  expect(found, name).toBeDefined();
  return found!;
}

describe('browser CI partition scheduling', () => {
  test('schedules every partition separately without fail-fast or relaxed job caps', () => {
    expect(partitions.needs).toEqual(['build']);
    expect(partitions['timeout-minutes']).toBe(25);
    expect(partitions.strategy).toEqual({ 'fail-fast': false, matrix: { partition: Object.keys(PARTITIONS) } });
    expect(partitions.env?.BROWSER_PARTITION).toBe('${{ matrix.partition }}');
    expect(partitions.env?.DESIGN_PROOF_SHOTS).toBe('e2e/.artifacts/screenshots');
    expect(partitions.steps.some((value) => value['continue-on-error'])).toBe(false);
    expect(step(partitions, 'Download workspace package output').with?.name).toBe('workspace-build-output');
    const discovery = step(partitions, 'Verify complete disjoint browser discovery');
    const execution = step(partitions, 'Exercise the production app with synthetic daemon fixtures');
    expect(discovery.id).toBe('discovery');
    expect(discovery.run).toBe('bun scripts/ci-browser-partitions.ts discover');
    expect(discovery.if).toBeUndefined();
    expect(execution.id).toBe('browser-proof');
    expect(execution.if).toBeUndefined();
    expect(partitions.steps.indexOf(discovery)).toBeLessThan(partitions.steps.indexOf(execution));
    expect(execution.run).toContain('set -euo pipefail');
    expect(execution.run).toContain('bun scripts/ci-browser-partitions.ts run "$BROWSER_PARTITION" 2>&1 | tee e2e/.artifacts/browser.log');
  });

  test('keeps required context and release dependency stable with fail-closed job results', () => {
    expect(aggregate.name).toBe('WebUI browser (phone, desktop, LAN)');
    expect(aggregate.needs).toEqual(['build', 'webui-browser-partitions']);
    expect(aggregate.if).toBe('always()');
    expect(aggregate['timeout-minutes']).toBe(25);
    expect(aggregate.env).toEqual({ BUILD_RESULT: '${{ needs.build.result }}', PARTITION_RESULT: '${{ needs.webui-browser-partitions.result }}' });
    expect(workflow.jobs['auto-release'].needs).toContain('webui-browser');
    expect(workflow.jobs['auto-release'].needs).not.toContain('webui-browser-partitions');
    const verification = step(aggregate, 'Require successful jobs and exact browser inventory');
    expect(verification.if).toBe('always()');
    expect(verification.run).toContain('set -euo pipefail');
    expect(verification.run).toContain('bun scripts/ci-browser-partitions.ts verify');
    expect(aggregate.steps.some((value) => value['continue-on-error'])).toBe(false);
  });

  test('preserves outcomes and all raw evidence in distinct partition artifacts', () => {
    const outcome = step(partitions, 'Record browser execution outcome');
    expect(outcome.if).toBe('always()');
    expect(outcome.env).toEqual({ DISCOVERY_OUTCOME: '${{ steps.discovery.outcome }}', BROWSER_OUTCOME: '${{ steps.browser-proof.outcome }}' });
    const upload = step(partitions, 'Retain partition reports, traces, and screenshots');
    expect(upload.if).toBe('always()');
    expect(upload.with?.name).toBe('webui-browser-partition-${{ matrix.partition }}');
    expect(upload.with?.['include-hidden-files']).toBe(true);
    expect(upload.with?.['if-no-files-found']).toBe('error');
    for (const name of ['execution.txt', 'outcome.json', 'browser.log', 'discovery-*', 'manifest.json', 'executed.json', 'executed-report.json', 'blob-report', 'test-output', 'screenshots']) {
      expect(upload.with?.path).toContain(`products/webui/e2e/.artifacts/${name}`);
    }
  });

  test('merges native blobs and retains compatible root HTML, logs and raw partitions', () => {
    const download = step(aggregate, 'Download every browser partition');
    expect(download.if).toBe('always()');
    expect(download.with).toEqual({ pattern: 'webui-browser-partition-*', path: 'products/webui/e2e/.artifacts/partitions' });
    expect(step(aggregate, 'Assemble labelled browser evidence').if).toBe('always()');
    const merge = step(aggregate, 'Merge native Playwright reports');
    expect(merge.if).toBe("always() && hashFiles('products/webui/e2e/.artifacts/blob-report/*.zip') != ''");
    expect(merge.run).toContain('merge-reports --reporter=html,json,./scripts/ci-browser-inventory-reporter.ts e2e/.artifacts/blob-report');
    expect(merge.env?.PLAYWRIGHT_HTML_OUTPUT_DIR).toBe('e2e/.artifacts/report');
    expect(merge.env?.PLAYWRIGHT_JSON_OUTPUT_FILE).toBe('e2e/.artifacts/report.json');
    expect(merge.env?.BROWSER_INVENTORY_OUTPUT).toBe('e2e/.artifacts/merged-inventory.json');
    const upload = step(aggregate, 'Retain combined browser proof and raw partition evidence');
    expect(upload.if).toBe('always()');
    expect(upload.with?.name).toBe('webui-browser-proof');
    for (const name of ['execution.txt', 'browser.log', 'report', 'report.json', 'merged-inventory.json', 'inventory-verification.json', 'blob-report', 'partitions']) {
      expect(upload.with?.path).toContain(`products/webui/e2e/.artifacts/${name}`);
    }
    expect(upload.with?.['include-hidden-files']).toBe(true);
    expect(upload.with?.['if-no-files-found']).toBe('error');
  });

  test('keeps real LAN admission, production preview, two workers and existing test deadlines', () => {
    const config = readFileSync(resolve(root, 'products/webui/playwright.config.ts'), 'utf8');
    expect(config).toContain('if (lanRequired && !LAN_ORIGIN_HOST && process.env.TEST_WORKER_INDEX === undefined)');
    expect(config).toContain('LAN-origin proof unsupported: no readable private-network interface');
    expect(config).toContain('bunx vite build --outDir');
    expect(config).toContain('bunx vite preview --outDir');
    expect(config).toContain('timeout: 60_000');
    expect(config).toContain('expect: { timeout: 10_000 }');
    expect(config).toContain('retries: 0');
    const helper = readFileSync(resolve(root, 'products/webui/scripts/ci-browser-partitions.ts'), 'utf8');
    expect(helper).toContain("'--workers=2'");
    expect(helper).not.toContain('--retries');
  });
});
