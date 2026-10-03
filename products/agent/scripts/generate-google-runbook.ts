/**
 * Regenerates docs/google-setup-runbook.md from the step plan.
 *
 * The runbook is generated rather than hand-written so the written fallback
 * cannot drift from what the automation actually does. A test compares the
 * checked-in file against this output and fails when they diverge; run this
 * script to bring the doc back in line after editing the plan.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderGoogleSetupRunbook, RUNBOOK_RELATIVE_PATH } from '@goodvibes-jev/engine/sdk/platform/google';

const repoRoot = join(import.meta.dir, '..');
const target = join(repoRoot, RUNBOOK_RELATIVE_PATH);
writeFileSync(target, renderGoogleSetupRunbook(), 'utf8');
console.log(`Wrote ${RUNBOOK_RELATIVE_PATH}`);
