import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyVerifiedUpdate, compareVersions, resolveLatestReleaseTag, rollbackKeptPrevious,
  sha256, swapFileAtomically, UpdateTransactionError,
  type UpdateFetchLike, type UpdateFileIo, type UpdateTarget,
} from '../sdk/src/platform/runtime/self-update.js';

const targets: readonly UpdateTarget[] = [
  { label: 'daemon', path: '/fixture/daemon', assetName: 'daemon', executable: true },
  { label: 'addon', path: '/fixture/lib/addon', assetName: 'addon', executable: false },
];
const base = 'https://fixture.invalid/releases/download/v2.0.0';
const payloads = { daemon: Buffer.from('new daemon'), addon: Buffer.from('new addon') };
const initial = {
  '/fixture/daemon': 'old daemon', '/fixture/daemon.previous': 'older daemon',
  '/fixture/lib/addon': 'old addon', '/fixture/lib/addon.previous': 'older addon',
};
type Fault = (operation: string, files: Map<string, Buffer>) => void;
function memory(seed: Record<string, string> = initial, fault: Fault = () => {}) {
  const files = new Map<string, Buffer>(Object.entries(seed).map(([path, body]) => [path, Buffer.from(body)]));
  const operations: string[] = [];
  const act = (operation: string) => { operations.push(operation); fault(operation, files); };
  const io: UpdateFileIo = {
    exists: (path) => files.has(path),
    mkdir: (path) => act(`mkdir ${path}`),
    writeExclusive: (path, bytes) => {
      act(`claim ${path}`);
      if (files.has(path)) throw new Error(`exclusive file exists: ${path}`);
      files.set(path, bytes);
    },
    writeFile: (path, bytes) => { act(`write ${path}`); files.set(path, bytes); },
    chmod: (path, mode) => act(`chmod ${path} ${mode.toString(8)}`),
    rename: (from, to) => {
      act(`rename ${from} -> ${to}`);
      const bytes = files.get(from);
      if (!bytes) throw new Error(`missing source: ${from}`);
      files.delete(from);
      files.set(to, bytes);
    },
    remove: (path) => { act(`remove ${path}`); files.delete(path); },
  };
  const contents = () => Object.fromEntries([...files].map(([path, bytes]) => [path, bytes.toString()]).sort());
  return { files, io, operations, contents };
}
function response(url: string, body: Buffer): Awaited<ReturnType<UpdateFetchLike>> {
  return { ok: true, status: 200, url, headers: { get: () => null }, text: async () => body.toString(),
    arrayBuffer: async () => Uint8Array.from(body).buffer };
}
const fetchRelease: UpdateFetchLike = async (url) => {
  const manifest = Buffer.from(Object.entries(payloads).map(([name, bytes]) => `${sha256(bytes)}  ${name}`).join('\n'));
  return response(url, url.endsWith('/SHA256SUMS.txt') ? manifest : url.endsWith('/daemon') ? payloads.daemon : payloads.addon);
};
const apply = (io: UpdateFileIo, rest: Partial<Parameters<typeof applyVerifiedUpdate>[0]> = {}) =>
  applyVerifiedUpdate({ fetchImpl: fetchRelease, downloadBaseUrl: base, targets, io, platform: 'linux', ...rest });
async function failure(run: () => unknown): Promise<UpdateTransactionError> {
  try { await run(); } catch (error) { expect(error).toBeInstanceOf(UpdateTransactionError); return error as UpdateTransactionError; }
  throw new Error('expected transaction failure');
}

// Generate the fault boundaries from this explicit expected successful sequence,
// rather than a trace produced by the implementation under test.
const commitRenames = targets.flatMap(({ path }) => [
  `rename ${path}.previous -> ${path}.update-previous`,
  `rename ${path} -> ${path}.previous`,
  `rename ${path}.update-download -> ${path}`,
]);

describe('owned update transaction fault matrix', () => {
  test('all payloads are staged and chmodded before the first live rename', async () => {
    const state = memory();
    await apply(state.io);
    const renames = state.operations.filter((operation) => operation.startsWith('rename '));
    expect(renames).toEqual(commitRenames);
    expect(state.operations.indexOf('chmod /fixture/lib/addon.update-download 644')).toBeLessThan(state.operations.indexOf(commitRenames[0]!));
    expect(state.contents()).toEqual({
      '/fixture/daemon': 'new daemon', '/fixture/daemon.previous': 'old daemon',
      '/fixture/lib/addon': 'new addon', '/fixture/lib/addon.previous': 'old addon',
    });
  });

  for (const operation of [
    'mkdir /fixture', 'mkdir /fixture/lib',
    ...targets.map(({ path }) => `claim ${path}.update-transaction`),
    ...targets.flatMap(({ path, executable }) => [`write ${path}.update-download`, `chmod ${path}.update-download ${executable ? '755' : '644'}`]),
    ...commitRenames,
  ]) {
    test(`restores original cohort and genuine baseline after ${operation} fails, then safely retries`, async () => {
      let fired = false;
      const state = memory(initial, (seen, files) => {
        if (!fired && seen === operation) {
          fired = true;
          if (seen.startsWith('write ')) files.set(seen.slice(6), Buffer.from('partial write'));
          throw new Error(`injected ${seen}`);
        }
      });
      const error = await failure(() => apply(state.io));
      expect(fired).toBe(true);
      expect(error.receipt.committed).toBe(false);
      expect(error.receipt.recoveryRequired).toBe(false);
      expect(state.contents()).toEqual(initial);
      await apply(state.io);
      expect(state.files.get('/fixture/daemon.previous')?.toString()).toBe('old daemon');
      expect(state.files.get('/fixture/lib/addon.previous')?.toString()).toBe('old addon');
    });
  }

  for (const existingBackup of [false, true]) {
    test(`a first install compensates earlier new live files (existing backup=${existingBackup})`, async () => {
      const seed = existingBackup ? { '/fixture/daemon.previous': 'historic daemon' } : {};
      let failed = false;
      const state = memory(seed, (operation) => {
        if (!failed && operation === 'rename /fixture/lib/addon.update-download -> /fixture/lib/addon') {
          failed = true; throw new Error('second install failed');
        }
      });
      const error = await failure(() => apply(state.io));
      expect(error.receipt.recoveryRequired).toBe(false);
      expect(state.contents()).toEqual(seed);
      await apply(state.io);
      expect(state.files.get('/fixture/daemon.previous')?.toString()).toBe(existingBackup ? 'historic daemon' : undefined);
    });
  }

  // Fail the final commit rename, then independently fail every reverse move.
  const undoRenames = commitRenames.slice(0, -1).reverse().map((operation) => {
    const [from, to] = operation.slice(7).split(' -> ');
    return `rename ${to} -> ${from}`;
  });
  for (const undo of undoRenames) {
    test(`retains bytes and fences retry when compensation fails at ${undo}`, async () => {
      let failedCommit = false;
      let failedUndo = false;
      const state = memory(initial, (operation) => {
        if (!failedCommit && operation === commitRenames.at(-1)) { failedCommit = true; throw new Error('commit failed'); }
        if (failedCommit && !failedUndo && operation === undo) { failedUndo = true; throw new Error('undo failed'); }
      });
      const error = await failure(() => apply(state.io));
      expect(failedUndo).toBe(true);
      expect(error.receipt.recoveryRequired).toBe(true);
      expect(error.receipt.recoveryErrors.length).toBeGreaterThan(0);
      // Every original live/previous byte string survives somewhere for recovery.
      for (const bytes of Object.values(initial)) expect(Object.values(state.contents())).toContain(bytes);
      const fenced = state.contents();
      const retry = await failure(() => apply(state.io));
      expect(retry.receipt.recoveryRequired).toBe(true);
      expect(state.contents()).toEqual(fenced);
    });
  }

  for (const path of [...targets.map(({ path }) => `${path}.update-previous`), ...targets.map(({ path }) => `${path}.update-transaction`)]) {
    test(`committed cleanup failure at ${path} is explicit and fenced`, async () => {
      let failed = false;
      const state = memory(initial, (operation) => {
        if (!failed && operation === `remove ${path}`) { failed = true; throw new Error('cleanup denied'); }
      });
      const error = await failure(() => apply(state.io));
      expect(error.receipt).toMatchObject({ committed: true, recoveryRequired: true, phase: 'cleanup' });
      expect(state.files.get('/fixture/daemon')?.toString()).toBe('new daemon');
      expect(state.files.get('/fixture/daemon.previous')?.toString()).toBe('old daemon');
      const fenced = state.contents();
      await failure(() => apply(state.io));
      expect(state.contents()).toEqual(fenced);
    });
  }

  test('partial exclusive-claim write is retained and never overwritten', async () => {
    const state = memory(initial, (operation, files) => {
      if (operation.startsWith('claim ')) { files.set(operation.slice(6), Buffer.from('partial claim evidence')); throw new Error('disk full'); }
    });
    const error = await failure(() => apply(state.io));
    expect(error.receipt.recoveryRequired).toBe(true);
    expect(state.files.get('/fixture/daemon.update-transaction')?.toString()).toBe('partial claim evidence');
    expect(state.files.get('/fixture/daemon.previous')?.toString()).toBe('older daemon');
  });

  test('failed stage cleanup retains ownership and rejects the next attempt', async () => {
    const state = memory(initial, (operation) => {
      if (operation.startsWith('chmod ') || operation.startsWith('remove ')) throw new Error('injected staging cleanup failure');
    });
    const error = await failure(() => apply(state.io));
    expect(error.receipt.recoveryRequired).toBe(true);
    expect(state.files.has('/fixture/daemon.update-transaction')).toBe(true);
    const fenced = state.contents();
    await failure(() => apply(state.io));
    expect(state.contents()).toEqual(fenced);
  });

  test('legacy adapters fail closed before filesystem mutation', async () => {
    const state = memory();
    const { writeExclusive: _writeExclusive, remove: _remove, ...legacy } = state.io;
    await expect(apply(legacy)).rejects.toThrow(/must support writeExclusive and remove/);
    expect(state.operations).toEqual([]);
    expect(state.contents()).toEqual(initial);
  });

  for (const overlap of ['/fixture/daemon', '/fixture/daemon.previous', '/fixture/daemon.update-download', '/fixture/daemon.update-transaction', '/fixture/daemon/child', '/fixture/./daemon']) {
    test(`rejects ambiguous target namespace ${overlap} before any I/O`, async () => {
      const state = memory();
      await expect(apply(state.io, { targets: [targets[0]!, { ...targets[1]!, path: overlap }] })).rejects.toThrow();
      expect(state.operations).toEqual([]);
    });
  }

  for (const suffix of ['.update-download', '.update-previous', '.rollback-exchange', '.update-transaction']) {
    test(`preserves preexisting ${suffix} recovery evidence`, async () => {
      const state = memory({ ...initial, [`/fixture/daemon${suffix}`]: 'unowned evidence' });
      const error = await failure(() => apply(state.io));
      expect(error.receipt.recoveryRequired).toBe(true);
      expect(state.files.get(`/fixture/daemon${suffix}`)?.toString()).toBe('unowned evidence');
      expect(state.files.get('/fixture/daemon')?.toString()).toBe('old daemon');
    });
  }

  test('an async admission callback is refused and its rejected promise is owned', async () => {
    const state = memory();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', listener);
    try {
      const error = await failure(() => apply(state.io, { beforeCommit: async () => { throw new Error('async admission rejected'); } }));
      expect(error.receipt).toMatchObject({ phase: 'admission', committed: false, recoveryRequired: false });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unhandled).toEqual([]);
      expect(state.contents()).toEqual(initial);
    } finally { process.off('unhandledRejection', listener); }
  });

  test('final synchronous admission rejection cleans stages and changes no live/backup file', async () => {
    const state = memory();
    const error = await failure(() => apply(state.io, { beforeCommit: () => { throw new Error('became busy'); } }));
    expect(error.receipt).toMatchObject({ phase: 'admission', committed: false, recoveryRequired: false });
    expect(state.operations.some((operation) => operation.startsWith('rename '))).toBe(false);
    expect(state.contents()).toEqual(initial);
  });
});

describe('asynchronous preparation owns immutable intent', () => {
  test('late caller edits cannot redirect targets, assets, adapter methods, or the cohort', async () => {
    const state = memory();
    const mutableTargets = targets.map((target) => ({ ...target }));
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const requests: string[] = [];
    const options = { fetchImpl: (async (url: string) => { requests.push(url); await gate; return fetchRelease(url); }) as UpdateFetchLike,
      downloadBaseUrl: base, targets: mutableTargets, io: { ...state.io }, platform: 'linux' as NodeJS.Platform };
    const running = applyVerifiedUpdate(options);
    mutableTargets[0]!.path = '/unowned/redirect';
    mutableTargets[0]!.assetName = 'other-artifact';
    mutableTargets[0]!.executable = false;
    mutableTargets.splice(1, 1, { ...targets[1]!, path: '/unowned/added' });
    options.downloadBaseUrl = 'https://unowned.invalid';
    options.fetchImpl = async () => { throw new Error('late replaced fetch'); };
    options.io.rename = () => { throw new Error('late replaced I/O'); };
    release!();
    await running;
    expect(requests).toEqual([`${base}/SHA256SUMS.txt`, `${base}/daemon`, `${base}/addon`]);
    expect(state.operations).toContain('chmod /fixture/daemon.update-download 755');
    expect(state.files.get('/fixture/daemon')?.toString()).toBe('new daemon');
    expect([...state.files.keys()].some((path) => path.startsWith('/unowned'))).toBe(false);
  });
  test('retained fetch ArrayBuffers cannot mutate already verified bytes during a later await', async () => {
    const state = memory();
    const external = Uint8Array.from(payloads.daemon);
    const fetchImpl: UpdateFetchLike = async (url) => {
      const original = await fetchRelease(url);
      if (url.endsWith('/daemon')) return { ...original, arrayBuffer: async () => external.buffer };
      if (url.endsWith('/addon')) external.fill(0);
      return original;
    };
    await apply(state.io, { fetchImpl });
    expect(state.files.get('/fixture/daemon')?.toString()).toBe('new daemon');
  });
  test('conflicting checksum entries refuse the cohort before any write', async () => {
    const state = memory();
    const fetchImpl: UpdateFetchLike = async (url) => url.endsWith('/SHA256SUMS.txt')
      ? response(url, Buffer.from(`${sha256(payloads.daemon)}  daemon\n${sha256(Buffer.from('other'))}  daemon`))
      : fetchRelease(url);
    await expect(apply(state.io, { fetchImpl })).rejects.toThrow(/conflicting checksum entries/);
    expect(state.operations).toEqual([]);
  });
  test('asset path traversal is rejected before fetch or filesystem effects', async () => {
    const state = memory();
    await expect(apply(state.io, { targets: [{ ...targets[0]!, assetName: '../other' }],
      fetchImpl: async () => { throw new Error('must not fetch'); } })).rejects.toThrow(/invalid update asset filename/);
    expect(state.operations).toEqual([]);
  });
});

describe('rollback uses the same compensated cohort contract', () => {
  test('rollback admission runs under every claim before any live rename and compensates refusal', async () => {
    const state = memory(); let admitted = false;
    const error = await failure(() => rollbackKeptPrevious(targets, state.io, () => {
      admitted = true;
      for (const target of targets) expect(state.files.has(target.path + '.update-transaction')).toBe(true);
      expect(state.operations.some(operation => operation.startsWith('rename '))).toBe(false);
      throw new Error('previous cohort no longer verified');
    }));
    expect(admitted).toBe(true); expect(error.receipt.phase).toBe('admission');
    expect(error.receipt.recoveryRequired).toBe(false); expect(state.contents()).toEqual(initial);
  });

  test('rollback admission is synchronous and cannot replace captured targets or effects', async () => {
    const state = memory();
    const error = await failure(() => rollbackKeptPrevious(targets, state.io, async () => { throw new Error('async refusal'); }));
    expect(error.message).toContain('synchronously'); expect(state.contents()).toEqual(initial);
    const ownedTargets = targets.map(target => ({ ...target }));
    const result = rollbackKeptPrevious(ownedTargets, state.io, () => {
      ownedTargets[0]!.path = '/unowned/replacement';
      state.io.rename = () => { throw new Error('replacement effect must not run'); };
    });
    expect(result.restored.map(target => target.path)).toEqual(targets.map(target => target.path));
    expect(state.files.has('/unowned/replacement')).toBe(false);
    expect(state.files.get(targets[0]!.path)?.toString()).toBe('older daemon');
  });

  const renames = targets.flatMap(({ path }) => [
    `rename ${path} -> ${path}.rollback-exchange`,
    `rename ${path}.previous -> ${path}`,
    `rename ${path}.rollback-exchange -> ${path}.previous`,
  ]);
  for (const failAt of renames) {
    test(`rollback restores the entire original cohort after ${failAt} fails`, async () => {
      let failed = false;
      const state = memory(initial, (operation) => {
        if (!failed && operation === failAt) { failed = true; throw new Error('rollback rename failed'); }
      });
      const error = await failure(() => rollbackKeptPrevious(targets, state.io));
      expect(error.receipt).toMatchObject({ operation: 'rollback', recoveryRequired: false, committed: false });
      expect(state.contents()).toEqual(initial);
      expect(rollbackKeptPrevious(targets, state.io).restored).toHaveLength(2);
      expect(rollbackKeptPrevious(targets, state.io).restored).toHaveLength(2);
      expect(state.contents()).toEqual(initial);
    });
  }
  for (const operation of renames.slice(0, -1).reverse().map((rename) => {
    const [from, to] = rename.slice(7).split(' -> '); return `rename ${to} -> ${from}`;
  })) {
    test(`rollback compensation failure ${operation} preserves bytes and fences update/rollback`, async () => {
      let primary = false;
      let undo = false;
      const state = memory(initial, (seen) => {
        if (!primary && seen === renames.at(-1)) { primary = true; throw new Error('rollback commit'); }
        if (primary && !undo && seen === operation) { undo = true; throw new Error('rollback undo'); }
      });
      const error = await failure(() => rollbackKeptPrevious(targets, state.io));
      expect(undo).toBe(true);
      expect(error.receipt.recoveryRequired).toBe(true);
      for (const bytes of Object.values(initial)) expect(Object.values(state.contents())).toContain(bytes);
      const fenced = state.contents();
      await failure(() => rollbackKeptPrevious(targets, state.io));
      await failure(() => apply(state.io));
      expect(state.contents()).toEqual(fenced);
    });
  }
  test('missing live file can be restored, and compensated if a later target fails', async () => {
    const seed = { '/fixture/daemon.previous': 'old daemon', '/fixture/lib/addon.previous': 'old addon' };
    let failed = false;
    const state = memory(seed, (operation) => {
      if (!failed && operation === 'rename /fixture/lib/addon.previous -> /fixture/lib/addon') { failed = true; throw new Error('second target'); }
    });
    await failure(() => rollbackKeptPrevious(targets, state.io));
    expect(state.contents()).toEqual(seed);
    rollbackKeptPrevious(targets, state.io);
    expect(state.contents()).toEqual({ '/fixture/daemon': 'old daemon', '/fixture/lib/addon': 'old addon' });
  });
});

describe('release discovery validation and semantic precedence', () => {
  const latest = 'https://fixture.invalid/owner/repo/releases/latest';
  const redirect = (status: number, location: string | null, actualUrl = latest): UpdateFetchLike => async () => ({
    ...response(actualUrl, Buffer.alloc(0)), status, ok: status >= 200 && status < 300,
    headers: { get: () => location },
  });
  test('accepts relative/absolute same repository manual redirects', async () => {
    for (const location of ['/owner/repo/releases/tag/v1.2.3-rc.10+build.5', 'https://fixture.invalid/owner/repo/releases/tag/v1.2.3']) {
      expect(await resolveLatestReleaseTag(redirect(302, location), latest)).toBe(location.split('/').at(-1)!);
    }
  });
  for (const [status, location] of [
    [500, 'https://unrelated.invalid/login/v99.0.0'], [200, '/owner/repo/releases/tag/v2.0.0'], [304, '/owner/repo/releases/tag/v2.0.0'],
    [302, null], [302, 'https://unrelated.invalid/owner/repo/releases/tag/v99.0.0'],
    [302, '/owner/other/releases/tag/v2.0.0'], [302, '/login/v2.0.0'],
    [302, 'http://fixture.invalid/owner/repo/releases/tag/v2.0.0'],
    [302, 'https://user:pass@fixture.invalid/owner/repo/releases/tag/v2.0.0'],
    [302, '/owner/repo/releases/tag/latest'], [302, '/owner/repo/releases/tag/v2.0'],
    [302, '/owner/repo/releases/tag/v2.0.0?token=example'], [302, '/owner/repo/releases/tag/v2.0.0#fragment'],
    [302, '/owner/repo/releases/tag/v2.0.0-01'], [302, '/owner/repo/releases/tag/v2.0.0+'],
  ] as const) {
    test(`refuses status ${status} location ${location}`, async () => {
      await expect(resolveLatestReleaseTag(redirect(status, location), latest)).rejects.toThrow();
    });
  }
  test('refuses an unexpectedly followed redirect even with a plausible Location', async () => {
    await expect(resolveLatestReleaseTag(redirect(302, '/owner/repo/releases/tag/v2.0.0', 'https://unrelated.invalid'), latest)).rejects.toThrow();
  });
  test('orders the SemVer prerelease chain and ignores build metadata', () => {
    const versions = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
    for (let index = 1; index < versions.length; index += 1) {
      expect(compareVersions(versions[index - 1]!, versions[index]!)).toBe(-1);
      expect(compareVersions(versions[index]!, versions[index - 1]!)).toBe(1);
    }
    expect(compareVersions('1.0.0-rc.9', '1.0.0-rc.10')).toBe(-1);
    expect(compareVersions('1.0.0-9007199254740992', '1.0.0-9007199254740993')).toBe(-1);
    expect(compareVersions('v1.0.0+build.1', '1.0.0+build.2')).toBe(0);
    expect(compareVersions('1.2', ' v1.2.0 ')).toBe(0);
  });
  for (const invalid of ['', 'garbage', '1x.2.3', '-1.2.3', '01.2.3', '1.2.3.4', '1.2.3-01', '1.2.3-alpha..1', '1.2.3+', '1.2.3+build..1']) {
    test(`refuses invalid version ${JSON.stringify(invalid)} without coercion`, () => {
      expect(() => compareVersions(invalid, '1.0.0')).toThrow(/invalid update version/);
    });
  }
});

describe('bounded cancellation and filesystem fixture smoke', () => {
  for (const stalled of ['fetch', 'manifest', 'payload'] as const) {
    test(`bounds a stuck ${stalled} even when the adapter ignores its abort signal`, async () => {
      const state = memory();
      let release: (() => void) | undefined;
      const wait = new Promise<void>((resolve) => { release = resolve; });
      const fetchImpl: UpdateFetchLike = async (url) => {
        if (stalled === 'fetch') await wait;
        const result = await fetchRelease(url);
        return { ...result,
          text: async () => { if (stalled === 'manifest') await wait; return result.text(); },
          arrayBuffer: async () => { if (stalled === 'payload') await wait; return result.arrayBuffer(); },
        };
      };
      await expect(apply(state.io, { fetchImpl, timeoutMs: 5 })).rejects.toThrow(/timed out/);
      release!();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.operations).toEqual([]);
      expect(state.contents()).toEqual(initial);
    });
  }
  test('aborting a pending download prevents late resolution from staging', async () => {
    const state = memory();
    const abort = new AbortController();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl: UpdateFetchLike = async (url, init) => {
      expect(init?.signal).toBeDefined();
      await gate;
      return fetchRelease(url);
    };
    const result = apply(state.io, { fetchImpl, signal: abort.signal });
    abort.abort(new Error('shutdown'));
    await expect(result).rejects.toThrow('shutdown');
    release!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.operations).toEqual([]);
  });
  test('real filesystem claims/staging/backup/cleanup operate only inside a temporary fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'update-transaction-'));
    try {
      const target = join(dir, 'binary');
      writeFileSync(target, 'old');
      writeFileSync(`${target}.previous`, 'older');
      swapFileAtomically(target, Buffer.from('new'), { executable: true });
      expect(readFileSync(target, 'utf8')).toBe('new');
      expect(readFileSync(`${target}.previous`, 'utf8')).toBe('old');
      expect(readdirSync(dir).sort()).toEqual(['binary', 'binary.previous']);
      rollbackKeptPrevious([{ path: target, label: 'fixture' }]);
      expect(readFileSync(target, 'utf8')).toBe('old');
      writeFileSync(`${target}.update-transaction`, 'another owner');
      expect(() => swapFileAtomically(target, Buffer.from('third'), { executable: true })).toThrow(/recovery required/);
      expect(readFileSync(`${target}.update-transaction`, 'utf8')).toBe('another owner');
      expect(readFileSync(target, 'utf8')).toBe('old');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
