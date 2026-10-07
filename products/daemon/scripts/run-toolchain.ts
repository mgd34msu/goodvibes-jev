import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const command = process.argv[2] ?? '';
    const args = process.argv.slice(3);
    validateToolchainArguments(command, args);
    const cli = resolveWorkspaceToolchain(root, command);
    const child = Bun.spawn([process.execPath, cli, ...args], { cwd: root, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' });
    process.exit(await child.exited);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
