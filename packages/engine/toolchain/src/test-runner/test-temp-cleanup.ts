import { afterAll } from 'bun:test';
import { drainTempDirsUntilSettled, ownedTestTmpRoot } from './temp-registry.js';

// Validation happens before any test can allocate a path.
ownedTestTmpRoot();
afterAll(async () => {
  const result = await drainTempDirsUntilSettled();
  if (result.survivors.length > 0) {
    console.error(`temp-cleanup: ${result.survivors.length} owned paths survived ${result.passes} bounded passes: ${result.survivors.join(', ')}`);
  }
});
