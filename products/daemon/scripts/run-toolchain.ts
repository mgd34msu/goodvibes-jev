import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withBuildPreparationLock } from './build-preparation-lock.ts';

const COMMANDS = {
  build: 'goodvibes-build-binaries',
  smoke: 'goodvibes-post-build-smoke',
} as const;

/** This product has one app leg; shared daemon-only selectors would skip it. */
export function validateToolchainArguments(command: string, args: readonly string[]): void {
  if (command === 'build') {
    if (args.includes('--daemon-only') || args.some(arg => arg.startsWith('daemon-') || arg.startsWith('--target=daemon-'))) {
      throw new Error('The daemon is the sole build artifact; use --target <platform-arch>, without --daemon-only or daemon-* selectors.');
    }
    if (args.length === 0 || (args.length === 1 && args[0] === '--all')
      || (args.length === 2 && args[0] === '--target' && !!args[1] && !args[1].startsWith('-'))) return;
    throw new Error('Usage: run-toolchain.ts build [--all | --target <platform-arch>]');
  }
  if (command === 'smoke') {
    if (args.length === 0 || (args.length === 2 && args[0] === '--binary' && !!args[1] && !args[1].startsWith('-'))) return;
    throw new Error('Usage: run-toolchain.ts smoke [--binary <path>]');
  }
  throw new Error('Usage: run-toolchain.ts build|smoke [arguments]');
}

/** Resolve the installed workspace engine's declared CLI, without relying on install scripts. */
export function resolveWorkspaceToolchain(productRoot: string, command: string): string {
  if (!Object.hasOwn(COMMANDS, command)) throw new Error('Usage: run-toolchain.ts build|smoke [arguments]');
  const require = createRequire(resolve(productRoot, 'package.json'));
  const manifestPath = require.resolve('@goodvibes-jev/engine/package.json');
  const manifest: { bin?: Record<string, unknown> } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const name = COMMANDS[command as keyof typeof COMMANDS];
  const entry = manifest.bin?.[name];
  if (typeof entry !== 'string') throw new Error(`The workspace engine does not declare ${name}.`);
  const path = resolve(dirname(manifestPath), entry);
  if (!existsSync(path)) throw new Error(`Build the workspace engine before running ${name}. Missing declared CLI: ${path}`);
  return path;
}

/** Keep version surfaces and native output stable until the real child exits. */
export async function runWorkspaceToolchain(productRoot: string, command: string, args: readonly string[]): Promise<number> {
  validateToolchainArguments(command, args);
  const cli = resolveWorkspaceToolchain(productRoot, command);
  return withBuildPreparationLock(productRoot, async () => {
    const child = Bun.spawn([process.execPath, cli, ...args], { cwd: productRoot, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    const stop = (): void => { child.kill('SIGTERM'); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    try { return await child.exited; }
    finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  });
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const command = process.argv[2] ?? '';
    const args = process.argv.slice(3);
    process.exitCode = await runWorkspaceToolchain(root, command, args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
