/** JSON's spec.id belongs to a grouped spec, not each project TestCase. */
import { writeFileSync } from 'node:fs';
import type { FullConfig, Reporter, Suite, TestError, TestStatus } from '@playwright/test/reporter';

export interface BrowserInventory {
  errors: string[];
  tests: {
    id: string;
    projectName: string;
    expectedStatus: TestStatus;
    status: 'skipped' | 'expected' | 'unexpected' | 'flaky';
    results: { status: TestStatus; retry: number }[];
  }[];
}

/** Used during --list, execution and native blob merge, without loading the app config. */
export default class BrowserInventoryReporter implements Reporter {
  private suite?: Suite;
  private readonly errors: string[] = [];

  onBegin(_config: FullConfig, suite: Suite): void {
    this.suite = suite;
  }
  onError(error: TestError): void {
    this.errors.push(error.message ?? error.value ?? 'Unknown Playwright error');
  }
  onEnd(): void {
    const output = process.env.BROWSER_INVENTORY_OUTPUT;
    if (!output) throw new Error('BROWSER_INVENTORY_OUTPUT is required for browser identity proof');
    const inventory: BrowserInventory = {
      errors: this.errors,
      tests: (this.suite?.allTests() ?? []).map((test) => ({
        id: test.id,
        projectName: test.parent.project()?.name ?? '',
        expectedStatus: test.expectedStatus,
        status: test.outcome(),
        results: test.results.map((result) => ({ status: result.status, retry: result.retry })),
      })),
    };
    writeFileSync(output, `${JSON.stringify(inventory, null, 2)}\n`);
  }
  printsToStdio(): boolean { return false; }
}
