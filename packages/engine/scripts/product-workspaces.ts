import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { inspectProductWorkspaces, productCheckCommands, readProductSources, type ProductCheckCommand } from './product-workspace-contract.ts';
import { typecheckFailures } from './typecheck-output-rule.ts';

interface ProductCommandResult { readonly status: number | null; readonly stdout: string; readonly stderr: string; readonly error?: Error | undefined; }
type ProductCommandRunner = (executable: string, args: string[], cwd: string) => ProductCommandResult;

/** Run real product commands and refuse nonzero exits or printed TS diagnostics. */
export function executeProductCommands(root: string, commands: readonly ProductCheckCommand[], mode: 'build' | 'test' | 'typecheck', runCommand: ProductCommandRunner = (executable, args, cwd) => spawnSync(executable, args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })): void {
  for (const command of commands) {
    console.log(`[products] ${command.label} ...`);
    const executable = command.kind === 'tsconfig' ? 'node' : 'bun';
    const args = command.kind === 'tsconfig'
      ? [resolve(root, 'node_modules/typescript/bin/tsc'), '--project', command.file, '--noEmit', '--pretty', 'false']
      : ['run', command.script];
    const run = runCommand(executable, args, command.cwd);
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    process.stdout.write(output);
    const failures = mode === 'typecheck' ? typecheckFailures({ label: command.label, exitCode: run.status, output }) : [];
    if (run.error || run.status !== 0 || failures.length > 0) {
      for (const failure of failures) console.error(failure);
      throw new Error(`${command.label} failed${run.error ? `: ${run.error.message}` : ''}`);
    }
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../../..');
  const mode = process.argv[2] ?? 'check';
  if (!['check', 'complete', 'build', 'test', 'typecheck'].includes(mode)) throw new Error(`Unknown product check mode ${mode}`);
  const inspection = inspectProductWorkspaces(root, readProductSources(root), mode === 'complete');
  if (inspection.findings.length > 0) {
    for (const finding of inspection.findings) console.error(`[products] ${finding}`);
    process.exit(1);
  }
  console.log(`[products] ${inspection.products.length} present, ${inspection.missing.length} pending${inspection.missing.length > 0 ? ` (${inspection.missing.join(', ')})` : ''}`);
  if (mode === 'build' || mode === 'test' || mode === 'typecheck') executeProductCommands(root, productCheckCommands(root, inspection.products, mode), mode);
}
