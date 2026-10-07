import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { inspectProductWorkspaces, productCheckCommands, productTestMatrix, readProductSources, selectProductWorkspaces, type ProductCheckCommand } from './product-workspace-contract.ts';
import { typecheckFailures } from './typecheck-output-rule.ts';

interface ProductCommandResult { readonly status: number | null; readonly signal?: NodeJS.Signals | null | undefined; readonly stdout: string | null; readonly stderr: string | null; readonly error?: Error | undefined; }
type ProductCommandRunner = (executable: string, args: string[], cwd: string) => ProductCommandResult;

/** A failed command must not exit while its diagnostic tail is still queued. */
async function writeOutput(stream: NodeJS.WriteStream, output: string): Promise<void> {
  if (output.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    stream.write(output, (error) => error ? reject(error) : resolve());
  });
}

/** Run real product commands and refuse nonzero exits or printed TS diagnostics. */
export async function executeProductCommands(root: string, commands: readonly ProductCheckCommand[], mode: 'build' | 'test' | 'typecheck', runCommand: ProductCommandRunner = (executable, args, cwd) => spawnSync(executable, args, {
  cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  // Test/build children own their output and lifecycle. Inherit the real sinks
  // so progress is visible before exit without another pipe/drain layer.
  // Compiler output must remain captured: printed errors also fail exit zero.
  stdio: mode === 'typecheck' ? 'pipe' : ['ignore', 'inherit', 'inherit'],
})): Promise<void> {
  for (const command of commands) {
    console.log(`[products] ${command.label} ...`);
    const executable = command.kind === 'tsconfig' ? 'node' : 'bun';
    const args = command.kind === 'tsconfig'
      ? [resolve(root, 'node_modules/typescript/bin/tsc'), '--project', command.file, '--noEmit', '--pretty', 'false']
      : ['run', command.script];
    const run = runCommand(executable, args, command.cwd);
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    await writeOutput(process.stdout, run.stdout ?? '');
    await writeOutput(process.stderr, run.stderr ?? '');
    const failures = mode === 'typecheck' ? typecheckFailures({ label: command.label, exitCode: run.status, output }) : [];
    if (run.error || run.signal || run.status !== 0 || failures.length > 0) {
      for (const failure of failures) console.error(failure);
      throw new Error(`${command.label} failed (exit code ${run.status ?? 'null'}, signal ${run.signal ?? 'none'})${run.error ? `: ${run.error.message}` : ''}`);
    }
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, '../../..');
  const mode = process.argv[2] ?? 'check';
  if (!['check', 'complete', 'build', 'test', 'typecheck', 'matrix', 'matrix-without-agent'].includes(mode)) throw new Error(`Unknown product check mode ${mode}`);
  const selectors = process.argv.slice(3);
  if (selectors.length > 0 && !['build', 'test', 'typecheck'].includes(mode)) throw new Error(`${mode} does not accept product selectors`);
  const inspection = inspectProductWorkspaces(root, readProductSources(root), mode === 'complete');
  if (inspection.findings.length > 0) {
    for (const finding of inspection.findings) console.error(`[products] ${finding}`);
    process.exit(1);
  }
  if (mode === 'matrix' || mode === 'matrix-without-agent') {
    // Machine-readable stdout: findings are already checked for the whole tree.
    const products = productTestMatrix(inspection);
    if (mode === 'matrix-without-agent' && !products.includes('agent')) throw new Error('Dedicated Agent CI groups require the Agent workspace');
    console.log(JSON.stringify(mode === 'matrix' ? products : products.filter((product) => product !== 'agent')));
  } else console.log(`[products] ${inspection.products.length} present, ${inspection.missing.length} pending${inspection.missing.length > 0 ? ` (${inspection.missing.join(', ')})` : ''}`);
  if (mode === 'build' || mode === 'test' || mode === 'typecheck') await executeProductCommands(root, productCheckCommands(root, selectProductWorkspaces(inspection.products, selectors), mode), mode);
}
