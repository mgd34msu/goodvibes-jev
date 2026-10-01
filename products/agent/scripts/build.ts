#!/usr/bin/env bun
/**
 * Production build, compiles standalone binaries across the target matrix.
 *
 * The compile matrix, the sqlite-vec native-addon copy (same-host) and
 * cross-target npm-pack fetch, and the prebuild step now live in the shared
 * @goodvibes-jev/engine/toolchain `build-binaries` (one implementation shared
 * across tui/agent). The target matrix + addon layout
 * (dist/lib/sqlite-vec-<os>-<arch>/vec0.<suffix>) come from
 * toolchain.config.json. This file forwards to that tool.
 *
 * Usage (unchanged):
 *   bun run scripts/build.ts                     # build for current platform
 *   bun run scripts/build.ts --all               # build all platform targets
 *   bun run scripts/build.ts --target linux-x64  # build a specific target
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync('bunx', ['goodvibes-build-binaries', ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
