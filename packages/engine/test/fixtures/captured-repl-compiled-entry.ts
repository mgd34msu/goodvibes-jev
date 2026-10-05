/** Real compiled parent and nested compiled program, using the production REPL boundary. */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { createContractInputAuthority } from '../../sdk/src/platform/contract/input-authority.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../../sdk/src/platform/contract/input-snapshot.js';
import type { Contract } from '../../sdk/src/platform/contract/types.js';
import { resolveProcessCapturedBunRuntimeExecutable } from '../../sdk/src/platform/runtime/captured-bun-runtime.js';
import { createCapturedExecBunRuntimeAdmission } from '../../sdk/src/platform/tools/exec/captured-bun-runtime-input.js';
import { createCapturedReplTool } from '../../sdk/src/platform/tools/repl/captured.js';


function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
}

async function main(): Promise<void> {
  const owner = process.argv.at(-1)!;
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, 'allowed.ts'), 'export const value = "CAPTURED_ALLOWED";\n');
  writeFileSync(join(owner, 'private.ts'), 'export const value = "DENIED_COMPILED_REPL_BYTES";\n');
  writeFileSync(join(owner, 'bunfig.toml'), `preload = ["./configured-preload.ts", "./second-preload.ts"]
[define]
CAPTURED_CONFIG_VALUE = '"PROJECT_CONFIG_OK"'
environment = 'null'
[loader]
".fixture" = "ts"
`);
  writeFileSync(join(owner, 'configured-preload.ts'), `import { nested } from './launch-compiled.ts'; globalThis.configuredPreload = nested; globalThis.startupOrder = ['first'];`);
  writeFileSync(join(owner, 'second-preload.ts'), `globalThis.startupOrder.push('second');`);
  writeFileSync(join(owner, 'configured.fixture'), 'export const configuredType: string = "LOADER_OK";');
  writeFileSync(join(owner, 'launch-compiled.ts'), `
    import { closeSync, openSync, readFileSync, writeFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    function execute(command, args, cwd = '/tmp') {
      const stdout = openSync('/tmp/compiled-program-out', 'w');
      const stderr = openSync('/tmp/compiled-program-err', 'w');
      let child;
      try { child = spawnSync(command, args, { cwd, stdio: ['ignore', stdout, stderr], timeout: 5000 }); }
      finally { closeSync(stdout); closeSync(stderr); }
      return { status: child.status, stdout: readFileSync('/tmp/compiled-program-out', 'utf8'), stderr: readFileSync('/tmp/compiled-program-err', 'utf8'), mode: process.env.BUN_BE_BUN ?? null, error: child.error?.message };
    }
    writeFileSync('/tmp/compiled-program-source.ts', 'console.log("COMPILED_PROGRAM_OK");');
    const built = execute(process.execPath, ['--config=/dev/null', 'build', '/tmp/compiled-program-source.ts', '--compile', '--outfile', '/tmp/nested-compiled-program']);
    if (built.status !== 0) throw new Error('contained fixture compile failed: ' + JSON.stringify(built));
    export function runCompiledProgram() { return execute('/tmp/nested-compiled-program', []); }
    export function runInterpreter() { return execute('bun', ['--no-env-file', '--print', 'JSON.stringify({answer:6*7,config:CAPTURED_CONFIG_VALUE,order:startupOrder})'], process.cwd()); }
    export const nested = runCompiledProgram();
  `);
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'compiled captured REPL fixture');
  const inputSnapshot = await captureContractInput(owner);
  const root = contractInputPath(inputSnapshot);
  git(owner, 'worktree', 'add', '--no-checkout', '-b', `input/${inputSnapshot.id}`, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract, root, { mutable: true, branch: `input/${inputSnapshot.id}` });
  // Synthetic semantic decision only; process, mount, filesystem, seccomp and
  // compiled-runtime behavior below are the real production implementations.
  installJudgmentPort(fakePort(() => noulAnswer(0.03)).port);
  const runtimeExecutable = resolveProcessCapturedBunRuntimeExecutable();
  let denyRuntime = false;
  const binding = { authority, root, readAccessFilter: async (path: string) => !path.endsWith('/private.ts') && !(denyRuntime && path === runtimeExecutable) };
  const bunRuntimeAdmission = createCapturedExecBunRuntimeAdmission(binding, { bunExecutable: runtimeExecutable });
  const tool = createCapturedReplTool({ ...binding, bunRuntimeAdmission });
  const results = [];
  for (const runtime of ['javascript', 'typescript']) {
    const declaration = runtime === 'typescript' ? 'const answer: number = amount * 7;' : 'const answer = amount * 7;';
    const result = await tool.execute({
      mode: 'eval', runtime, bindings: { amount: 6 },
      // Model-selected env must not replace trusted interpreter startup.
      env: { BUN_BE_BUN: '0' },
      expression: `import { value } from './allowed.ts'; import { nested, runCompiledProgram, runInterpreter } from './launch-compiled.ts'; import { configuredType } from './configured.fixture';
        const fs = require('node:fs'); ${declaration}
        fs.writeFileSync('generated.txt', 'MEMBER_GENERATED');
        let networkBlocked = false; try { Bun.listen({hostname:'127.0.0.1',port:0,socket:{data(){}}}); } catch { networkBlocked = true; }
        JSON.stringify({ value, answer, nested, configuredPreload, startupOrder, configValue: CAPTURED_CONFIG_VALUE, configuredType, mode:process.env.BUN_BE_BUN ?? null,
          ambient:process.env.CAPTURED_REPL_COMPILED_PARENT ?? null,
          deniedVisible:fs.existsSync('private.ts'), ownerVisible:fs.existsSync(${JSON.stringify(join(owner, 'allowed.ts'))}),
          hostVisible:fs.existsSync('/etc/passwd'), networkBlocked,
          compiledInBody:runCompiledProgram().stdout, nestedInterpreter:runInterpreter().stdout })`,
    });
    results.push({ runtime, result });
  }
  const history = await tool.execute({ mode: 'history' });
  denyRuntime = true;
  const deniedHistory = await tool.execute({ mode: 'history' });
  let compiledRuntimeRejected = false;
  try { await createCapturedExecBunRuntimeAdmission(binding, { bunExecutable: process.execPath })(); }
  catch { compiledRuntimeRejected = true; }
  process.stdout.write(JSON.stringify({
    execPath: process.execPath, runtimeExecutable: resolveProcessCapturedBunRuntimeExecutable(), compiledRuntimeRejected, argv: process.argv, parentMode: process.env.BUN_BE_BUN ?? null, results, history, deniedHistory,
    memberOutput: existsSync(join(root, 'generated.txt')) ? readFileSync(join(root, 'generated.txt'), 'utf8') : null,
    ownerOutput: existsSync(join(owner, 'generated.txt')),
  }) + '\n');
}
await main();
