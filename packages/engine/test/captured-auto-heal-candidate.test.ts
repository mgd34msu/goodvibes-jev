import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContractInputAuthority, revokeContractInputAuthority } from '../sdk/src/platform/contract/input-authority.js';
import { captureContractInput, contractInputPath, materializeContractInput } from '../sdk/src/platform/contract/input-snapshot.js';
import type { Contract } from '../sdk/src/platform/contract/types.js';
import {
  probeCapturedExecAvailability, runCapturedCommand,
  type CapturedExecAuthority, type CapturedExecutionLease, type CapturedExecutionObserver,
} from '../sdk/src/platform/tools/exec/captured-exec.js';
import type { ExecCommandResult } from '../sdk/src/platform/tools/exec/schema.js';
import { withCapturedPublication, type CapturedPublicationLease } from '../sdk/src/platform/tools/shared/captured-publication.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const availability = await probeCapturedExecAvailability();
const supported = availability.available;

test('required captured auto-heal candidate proof cannot silently skip containment', () => {
  if (process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT !== undefined) {
    expect(process.env.GOODVIBES_TEST_REQUIRE_EXEC_CONTAINMENT).toBe('1');
    expect(availability).toEqual({ available: true, backend: 'linux-bwrap-projection' });
  } else if (!availability.available) {
    expect(availability.reason).toBeString();
    expect(availability.message).toBeString();
  }
});

function git(root: string, ...args: string[]): void {
  const result = spawnSync('git', ['-C', root, ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}
async function fixture(filter: (path: string) => boolean | Promise<boolean> = () => true) {
  const owner = mkdtempSync(join(tmpdir(), 'captured-heal-candidate-')); roots.push(owner);
  git(owner, 'init', '-q'); git(owner, 'config', 'user.name', 'Fixture'); git(owner, 'config', 'user.email', 'fixture@example.invalid');
  writeFileSync(join(owner, '.gitignore'), '.goodvibes/\n');
  writeFileSync(join(owner, 'input.txt'), 'original input\n');
  writeFileSync(join(owner, 'neighbor.txt'), 'original neighbor\n');
  git(owner, 'add', '.'); git(owner, 'commit', '-qm', 'fixture');
  const inputSnapshot = await captureContractInput(owner);
  const root = contractInputPath(inputSnapshot);
  const branch = `input/${inputSnapshot.id}`;
  git(owner, 'worktree', 'add', '--no-checkout', '-b', branch, root, inputSnapshot.inputCommit);
  await materializeContractInput(inputSnapshot, root);
  const contract = { projectRoot: owner, inputSnapshot } as Contract;
  const controller = new AbortController();
  const authority = await createContractInputAuthority(contract, root, { mutable: true, branch, signal: controller.signal });
  const binding: CapturedExecAuthority = { authority, root, readAccessFilter: async (path) => filter(path), signal: controller.signal };
  return { owner, root, contract, branch, controller, binding };
}
function run(binding: CapturedExecAuthority, command: string, observer: CapturedExecutionObserver, signal?: AbortSignal) {
  return runCapturedCommand(binding, command, {}, binding.root, 5000, signal, 'disabled', {}, observer);
}
function candidate(lease: CapturedPublicationLease | undefined, receive: (content: string) => void): CapturedExecutionObserver {
  return { publicationLease: lease, repairCandidate: { path: 'input.txt', content: 'staged café', receive } };
}
function assertUnpublished(f: Awaited<ReturnType<typeof fixture>>): void {
  for (const root of [f.root, f.owner]) {
    expect(readFileSync(join(root, 'input.txt'), 'utf8')).toBe('original input\n');
    expect(readFileSync(join(root, 'neighbor.txt'), 'utf8')).toBe('original neighbor\n');
    expect(existsSync(join(root, 'side.txt'))).toBe(false);
  }
}
function assertHeld(result: ExecCommandResult, received: string[]): void {
  expect(result.success).toBe(false);
  expect(result.denied).toBe(true);
  expect(result.stdout).toBe('');
  expect(result.stderr).not.toContain('CANDIDATE_PRIVATE_DIAGNOSTIC');
  expect(received).toEqual([]);
}

test.skipIf(!supported)('candidate returns exact staged target content and publishes no target, mode, deletion or side file changes', async () => {
  const f = await fixture(); const received: string[] = [];
  const originalMode = statSync(join(f.root, 'input.txt')).mode;
  const result = await withCapturedPublication(f.binding.authority, (lease) => run(f.binding,
    "test \"$(cat input.txt)\" = 'staged café' && printf '\\nfixed\\n' >> input.txt && chmod 600 input.txt && rm neighbor.txt && printf side > side.txt",
    candidate(lease, (content) => received.push(content))));
  expect(result.success).toBe(true);
  expect(result.sandboxed).toBe(true);
  expect(received).toEqual(['staged café\nfixed\n']);
  expect(statSync(join(f.root, 'input.txt')).mode).toBe(originalMode);
  assertUnpublished(f);
});

for (const [name, command, expected] of [
  ['unchanged stage', ':', 'staged café'],
  ['restored original', "printf 'original input\\n' > input.txt", 'original input\n'],
] as const) test.skipIf(!supported)(`candidate preserves exact ${name} bytes`, async () => {
  const f = await fixture(); const received: string[] = [];
  const result = await withCapturedPublication(f.binding.authority, (lease) =>
    run(f.binding, command, candidate(lease, (content) => received.push(content))));
  expect(result.success).toBe(true); expect(received).toEqual([expected]);
  assertUnpublished(f);
});

for (const [name, command] of [
  ['deleted', 'rm input.txt'],
  ['symlink', 'rm input.txt; ln -s neighbor.txt input.txt'],
  ['hardlink', 'rm input.txt; ln neighbor.txt input.txt'],
  ['invalid UTF-8', "printf '\\377\\376' > input.txt"],
] as const) test.skipIf(!supported)(`candidate rejects ${name} target output and withholds diagnostics`, async () => {
  const f = await fixture(); const received: string[] = [];
  const result = await withCapturedPublication(f.binding.authority, (lease) =>
    run(f.binding, `printf CANDIDATE_PRIVATE_DIAGNOSTIC; printf side > side.txt; ${command}`, candidate(lease, (content) => received.push(content))));
  assertHeld(result, received); assertUnpublished(f);
});

for (const interruption of ['per-call abort', 'owner abort', 'authority revocation', 'permission revocation'] as const)
  test.skipIf(!supported)(`candidate ${interruption} during a real subprocess withholds output and changes`, async () => {
    let allowed = true;
    const f = await fixture(() => allowed); const received: string[] = []; const call = new AbortController();
    let started = false; let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await withCapturedPublication(f.binding.authority, (lease) => run(f.binding,
        'printf CANDIDATE_PRIVATE_DIAGNOSTIC; sleep 1; printf changed > input.txt; printf side > side.txt', {
          ...candidate(lease, (content) => received.push(content)),
          onStarted: () => {
            started = true;
            timer = setTimeout(() => {
              if (interruption === 'per-call abort') call.abort();
              else if (interruption === 'owner abort') f.controller.abort();
              else if (interruption === 'authority revocation') revokeContractInputAuthority(f.binding.authority);
              else allowed = false;
            }, 80);
          },
        }, call.signal));
      expect(started).toBe(true); assertHeld(result, received); assertUnpublished(f);
    } finally { clearTimeout(timer); }
  });

for (const kind of ['missing', 'forged', 'copied', 'settled', 'same-root rebound'] as const)
  test.skipIf(!supported)(`candidate ${kind} publication lease cannot launch a command or return content`, async () => {
    const f = await fixture(); const received: string[] = []; let started = false;
    const execute = (binding: CapturedExecAuthority, lease: CapturedPublicationLease | undefined) => run(binding,
      'printf CANDIDATE_PRIVATE_DIAGNOSTIC; printf changed > input.txt; printf side > side.txt', {
        ...candidate(lease, (content) => received.push(content)), onStarted: () => { started = true; },
      });
    let result: ExecCommandResult;
    if (kind === 'missing') result = await execute(f.binding, undefined);
    else if (kind === 'forged') result = await execute(f.binding, { kind: 'captured-publication-lease' });
    else if (kind === 'settled') {
      const lease = await withCapturedPublication(f.binding.authority, async (active) => active);
      result = await execute(f.binding, lease);
    } else if (kind === 'copied') {
      result = await withCapturedPublication(f.binding.authority, (lease) => execute(f.binding, { ...lease }));
    } else {
      const authority = await createContractInputAuthority(f.contract, f.root, { mutable: true, branch: f.branch });
      result = await withCapturedPublication(f.binding.authority, (lease) => execute({ ...f.binding, authority }, lease));
    }
    expect(started).toBe(false); assertHeld(result, received); assertUnpublished(f);
  });

test.skipIf(!supported)('candidate owner settlement during runtime admission prevents a later subprocess launch', async () => {
  const f = await fixture(); const received: string[] = []; let started = false;
  let entered!: () => void; const admissionEntered = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void; const admissionRelease = new Promise<void>((resolve) => { release = resolve; });
  const binding: CapturedExecAuthority = { ...f.binding, nodeRuntimeAdmission: async () => {
    entered(); await admissionRelease; throw new Error('test admission unavailable');
  } };
  let pending!: Promise<ExecCommandResult>;
  await withCapturedPublication(f.binding.authority, async (lease) => {
    pending = run(binding, 'cat input.txt; printf changed > input.txt', {
      ...candidate(lease, (content) => received.push(content)), onStarted: () => { started = true; },
    });
    await Promise.race([admissionEntered, pending.then(() => { throw new Error('candidate ended before reaching runtime admission'); })]);
  });
  release();
  const result = await pending;
  expect(started).toBe(false); assertHeld(result, received); assertUnpublished(f);
});

test.skipIf(!supported)('settled candidate owner cannot read retained subprocess output', async () => {
  const f = await fixture(); const received: string[] = [];
  let started!: (lease: CapturedExecutionLease) => void;
  const processStarted = new Promise<CapturedExecutionLease>((resolve) => { started = resolve; });
  let pending!: Promise<ExecCommandResult>; let processLease!: CapturedExecutionLease;
  await withCapturedPublication(f.binding.authority, async (lease) => {
    pending = run(f.binding, 'printf CANDIDATE_PRIVATE_DIAGNOSTIC; sleep 1; printf changed > input.txt', {
      ...candidate(lease, (content) => received.push(content)), onStarted: started,
    });
    processLease = await Promise.race([processStarted, pending.then(() => { throw new Error('candidate ended before subprocess launch'); })]);
  });
  await expect(processLease.readOutput()).rejects.toThrow();
  const result = await pending;
  assertHeld(result, received); assertUnpublished(f);
});

test.skipIf(!supported)('ordinary captured execution without a candidate retains successful target and side file publication', async () => {
  const f = await fixture();
  const result = await withCapturedPublication(f.binding.authority, (publicationLease) =>
    run(f.binding, 'printf ordinary > input.txt; printf side > side.txt', { publicationLease }));
  expect(result.success).toBe(true);
  expect(readFileSync(join(f.root, 'input.txt'), 'utf8')).toBe('ordinary');
  expect(readFileSync(join(f.root, 'side.txt'), 'utf8')).toBe('side');
  expect(readFileSync(join(f.owner, 'input.txt'), 'utf8')).toBe('original input\n');
  expect(existsSync(join(f.owner, 'side.txt'))).toBe(false);
});
