/** Genuine installed formatter/linter candidates under admitted Node/dependency inputs. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { installJudgmentPort } from '../errors/src/index.js';
import { ConfigManager } from '../sdk/src/platform/config/index.js';
import { createContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import { admitCapturedExecDependency } from '../sdk/src/platform/tools/exec/captured-exec-dependencies.js';
import { createCapturedExecNodeRuntimeAdmission } from '../sdk/src/platform/tools/exec/captured-exec-runtime-input.js';
import { probeCapturedExecAvailability, type CapturedExecAuthority } from '../sdk/src/platform/tools/exec/captured-exec.js';
import { createCapturedAutoHealBackend, healToolFile } from '../sdk/src/platform/tools/shared/captured-auto-heal.js';
import { capturedInputTool } from '../sdk/src/platform/tools/shared/captured-input-tools.js';
import type { HealResult } from '../sdk/src/platform/tools/shared/auto-heal.js';
import { toolReadingsPort } from './_helpers/tool-readings.js';

const supported = (await probeCapturedExecAvailability()).available;
if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT === '1' && !supported)
  throw new Error('required genuine captured formatter/linter containment backend is unavailable');

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
}
/** Copy the installed package's complete runtime dependency closure, no network. */
function copyPackage(source: string, target: string, seen = new Set<string>()): void {
  const metadata = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')) as { name: string; dependencies?: Record<string, string> };
  if (seen.has(metadata.name)) return;
  seen.add(metadata.name);
  const destination = join(target, metadata.name); mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true,
    filter: (path) => path === source || !path.slice(source.length + 1).split('/').includes('node_modules') });
  for (const name of Object.keys(metadata.dependencies ?? {})) {
    let cursor = source;
    while (!existsSync(join(cursor, 'node_modules', name)) && dirname(cursor) !== cursor) cursor = dirname(cursor);
    const dependency = join(cursor, 'node_modules', name);
    if (!existsSync(dependency)) throw new Error(`fixture dependency missing: ${name}`);
    copyPackage(realpathSync(dependency), target, seen);
  }
}

for (const stage of ['formatter', 'linter'] as const) {
  describe.skipIf(!supported)(`real captured ${stage}`, () => {
    const input = stage === 'formatter' ? 'export const value={answer:1}\n' : 'export const value = 1;;\n';
    const expected = stage === 'formatter' ? 'export const value = { answer: 1 };\n' : 'export const value = 1;\n';
    let owner: string | undefined;
    let root: string;
    let authority: Awaited<ReturnType<typeof createContractInputAuthority>>;
    let binding: CapturedExecAuthority;
    let backend: ReturnType<typeof createCapturedAutoHealBackend>;
    let config: ConfigManager;
    let previous: ReturnType<typeof installJudgmentPort>;
    let setupTimings: { captureMs: number; copyMs: number; dependencyAdmissionMs: number; nodeAdmissionMs: number } | undefined;
    const invocations: { accept: boolean; milliseconds: number }[] = [];

    beforeAll(async () => {
      const started = performance.now();
      owner = mkdtempSync(join(tmpdir(), 'captured-heal-real-tools-'));
      previous = installJudgmentPort(toolReadingsPort().port);
      git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
      writeFileSync(join(owner, '.gitignore'), '.goodvibes/\nnode_modules/\n');
      writeFileSync(join(owner, 'source.js'), input);
      writeFileSync(join(owner, 'neighbor.txt'), 'NEIGHBOR_MUST_REMAIN\n');
      // If either config is loaded, the fixture fails and records an escaped
      // config effect. The real stage must use its fixed config-free flags.
      writeFileSync(join(owner, '.prettierrc.cjs'), 'require("node:fs").writeFileSync("CONFIG_EXECUTED", "prettier"); throw Error("project prettier config executed");');
      writeFileSync(join(owner, '.prettierignore'), 'source.js\n');
      writeFileSync(join(owner, 'eslint.config.mjs'), 'import {writeFileSync} from "node:fs"; writeFileSync("CONFIG_EXECUTED", "eslint"); throw Error("project eslint config executed");');
      writeFileSync(join(owner, '.editorconfig'), 'root = true\n[*]\nindent_style = tab\nindent_size = 8\n');
      git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'real captured repair fixture');
      const inputSnapshot = await captureContractInput(owner);
      root = contractInputPath(inputSnapshot); const branch = `input/${inputSnapshot.id}`;
      git(owner, 'worktree', 'add', '--no-checkout', '-b', branch, root, inputSnapshot.inputCommit);
      await materializeContractInput(inputSnapshot, root);
      authority = await createContractInputAuthority({ projectRoot: owner, inputSnapshot } as Contract, root, { mutable: true, branch });
      const base: CapturedExecAuthority = { authority, root, readAccessFilter: async () => true };
      const capturedAt = performance.now();
      const modules = join(owner, 'node_modules'); mkdirSync(modules);
      const store = realpathSync(join(import.meta.dir, '../../../node_modules/.bun'));
      const name = stage === 'formatter' ? 'prettier' : 'eslint';
      const version = stage === 'formatter' ? '3.8.4' : '10.5.0';
      const entry = readdirSync(store).find((candidate) => candidate === `${name}@${version}` || candidate.startsWith(`${name}@${version}+`));
      expect(entry, `installed ${name}@${version} is required for genuine qualification`).toBeDefined();
      copyPackage(join(store, entry!, 'node_modules', name), modules);
      mkdirSync(join(modules, '.bin'));
      symlinkSync(stage === 'formatter' ? '../prettier/bin/prettier.cjs' : '../eslint/bin/eslint.js', join(modules, '.bin', name));
      const copiedAt = performance.now();
      const dependency = await admitCapturedExecDependency(base, { sourceRoot: modules, targetRelativePath: 'node_modules' });
      expect(dependency).toBeDefined();
      const dependenciesAt = performance.now();
      const nodeRuntimeInput = await createCapturedExecNodeRuntimeAdmission(base)();
      const runtimeAt = performance.now();
      binding = { ...base, dependencyInputs: [dependency!], nodeRuntimeInput };
      backend = createCapturedAutoHealBackend(binding);
      config = new ConfigManager({ surfaceRoot: 'agent', configDir: join(owner, '.goodvibes', 'config'), workingDir: owner, homeDir: owner });
      config.set('tools.autoHeal', true);
      setupTimings = { captureMs: capturedAt - started, copyMs: copiedAt - capturedAt,
        dependencyAdmissionMs: dependenciesAt - copiedAt, nodeAdmissionMs: runtimeAt - dependenciesAt };
    }, 240_000);

    afterAll(() => {
      if (process.env.GOODVIBES_TEST_REPAIR_TIMINGS === '1') console.info(JSON.stringify({ stage, ...setupTimings, invocations }));
      installJudgmentPort(previous);
      if (owner) rmSync(owner, { recursive: true, force: true });
    });

    // Distinct tests report genuine progress between the two command pipelines.
    // Each receives a fresh publication lease; unchanged inputs and immutable
    // runtime/dependency admissions are owned by this stage's shared fixture.
    for (const accept of [true, false]) {
      test(`${accept ? 'accepts' : 'rejects'} a config-free candidate without publishing it`, async () => {
        const readings = toolReadingsPort([[expected.trim(), { fixesErrors: accept }]]);
        installJudgmentPort(readings.port);
        let modelCalls = 0;
        const tool = capturedInputTool({
          definition: { name: 'edit', description: 'Exercise the owned repair candidate boundary without publishing its result', parameters: { type: 'object', properties: {} } },
          async execute() {
            const healed = await healToolFile(config, { chat: async () => { modelCalls++; return ''; } },
              join(root, 'source.js'), input, [stage === 'formatter' ? 'Source must have canonical spacing and a trailing semicolon' : 'Remove the redundant trailing semicolon'], backend);
            await healed.assertCurrent();
            const { assertCurrent: _check, ...result } = healed;
            return { success: true, output: JSON.stringify(result) };
          },
        }, authority, root, binding.readAccessFilter, undefined);
        const invocationStart = performance.now();
        const result = await tool.execute({});
        invocations.push({ accept, milliseconds: performance.now() - invocationStart });
        expect(result.success, JSON.stringify(result)).toBe(true);
        const healed = JSON.parse(result.output!) as HealResult;
        expect(healed.healed, JSON.stringify(healed)).toBe(accept);
        expect(healed.method).toBe(accept ? stage : undefined);
        expect(modelCalls).toBe(accept ? 0 : 1);
        if (accept) expect(healed.content).toBe(expected);
        const acceptance = readings.requests.filter((request) => Object.hasOwn(request.questions, 'fixes_errors'));
        expect(acceptance).toHaveLength(1);
        expect(JSON.stringify(acceptance[0]?.state)).toContain(expected.trim());
        for (const directory of [owner!, root]) {
          expect(readFileSync(join(directory, 'source.js'), 'utf8')).toBe(input);
          expect(readFileSync(join(directory, 'neighbor.txt'), 'utf8')).toBe('NEIGHBOR_MUST_REMAIN\n');
          expect(existsSync(join(directory, 'CONFIG_EXECUTED'))).toBe(false);
          expect(existsSync(join(directory, '.eslintcache'))).toBe(false);
        }
      }, 240_000);
    }
  });
}
