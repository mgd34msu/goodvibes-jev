#!/usr/bin/env bun
/**
 * Post-build smoke test for the GoodVibes Agent binary.
 *
 * Verifies that the compiled Agent executable launches, reports its version
 * banner, and does not emit packaged module-resolution errors. It never starts
 * or owns a daemon.
 *
 * The boot/banner/sentinel policy now lives in the shared
 * @goodvibes-jev/engine/toolchain `post-build-smoke` (one implementation across
 * tui/agent). This file is a thin adapter: it resolves the binary (from
 * --binary or the configured default) and delegates to the toolchain, sourcing
 * the banner prefix + packaging-failure sentinels from toolchain.config.json.
 */
import { existsSync } from 'node:fs';
import { runPostBuildSmoke, loadToolchainConfig } from '@goodvibes-jev/engine/toolchain';

const root = process.cwd();
const smoke = loadToolchainConfig(root).smoke;
if (!smoke) {
  console.error('[agent-smoke] FAIL: toolchain.config.json is missing a `smoke` section');
  process.exit(1);
}

const args = process.argv.slice(2);
const binaryIndex = args.indexOf('--binary');
const binary = binaryIndex !== -1 && args[binaryIndex + 1]
  ? (args[binaryIndex + 1] as string)
  : smoke.binaryDefault;

if (!existsSync(binary)) {
  console.error(`[agent-smoke] FAIL: Binary not found: ${binary}`);
  process.exit(1);
}

const result = runPostBuildSmoke({ binary, config: smoke });
process.exit(result.ok ? 0 : 1);
