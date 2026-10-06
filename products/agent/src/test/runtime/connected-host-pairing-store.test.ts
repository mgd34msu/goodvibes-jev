import { expect, test } from 'bun:test';
import {
  chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  acquireCrossProcessLock, AtomicWriteDurabilityError, confirmFileDurable, writeJsonFileAtomic,
} from '@goodvibes-jev/engine/sdk/platform/state/durable-file-io';
import {
  AGENT_HOST_PAIRING_MAX_BYTES, AGENT_HOST_PAIRING_MAX_RECORDS, AGENT_HOST_PAIRING_UNAVAILABLE_REASON,
  agentHostPairingStorePath, beginAgentHostPairing, canonicalizePairingHost, completeAgentHostPairing, readAgentHostPairing,
} from '../../runtime/connected-host-pairing-store.ts';

const host = 'https://fixture.example:4443';
const otherHost = 'https://other.example:4443';
const attempt = { attemptId: 'fixture-attempt', name: 'Synthetic Agent', startedAt: 1_700_000_000_000 };
const secret = { token: 'fixture-secret-not-a-real-credential', tokenId: 'fixture-token-id', name: attempt.name, createdAt: attempt.startedAt + 1 };
const unavailable = { status: 'unavailable', reason: AGENT_HOST_PAIRING_UNAVAILABLE_REASON } as const;
async function fixture(run: (home: string, path: string) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'agent-host-pairing-'));
  try { await run(home, agentHostPairingStorePath(home)); }
  finally { rmSync(home, { recursive: true, force: true }); }
}
const moduleUrl = new URL('../../runtime/connected-host-pairing-store.ts', import.meta.url).href;

test('host keys are canonical exact origins and reject credentials and normalization-hidden paths', () => {
  expect(canonicalizePairingHost('HTTPS://Fixture.Example:443/')).toBe('https://fixture.example');
  expect(canonicalizePairingHost('http://[::1]:80/')).toBe('http://[::1]');
  expect(canonicalizePairingHost('http://fixture.example:4443')).toBe('http://fixture.example:4443');
  for (const invalid of [
    '', 'fixture.example', ' https://fixture.example', 'https://fixture.example\n',
    'file:///tmp/fixture', 'ftp://fixture.example', 'https://user:secret@fixture.example', 'https://@fixture.example',
    'https://fixture.example?token=secret', 'https://fixture.example?', 'https://fixture.example/#',
    'https://fixture.example/path', 'https://fixture.example//', 'https://fixture.example/.',
    'https://fixture.example/path/..', 'https://fixture.example/%2e', 'https://fixture.example\\',
    'https://fixture.example:invalid', 'https://fixture.example/#secret',
  ]) expect(canonicalizePairingHost(invalid)).toBeNull();
});

test('read-only absence creates no directories and never consults legacy or environment tokens', async () => fixture(async (home, path) => {
  expect(readAgentHostPairing(home, host)).toEqual({ status: 'missing' });
  expect(existsSync(join(home, '.goodvibes'))).toBe(false);
  const daemon = join(home, '.goodvibes', 'daemon'); mkdirSync(daemon, { recursive: true, mode: 0o700 });
  const legacy = join(daemon, 'operator-tokens.json'); writeFileSync(legacy, JSON.stringify({ token: secret.token }));
  const original = readFileSync(legacy);
  expect(readAgentHostPairing(home, host)).toEqual({ status: 'missing' });
  expect(existsSync(path)).toBe(false); expect(readFileSync(legacy)).toEqual(original);
}));

test('begin durably records private unknown state, and same-host repeats cannot authorize another mint', async () => fixture(async (home, path) => {
  const calls: string[] = [];
  expect(await beginAgentHostPairing(home, host, attempt, {
    acquireCrossProcessLock: async (target, options) => {
      expect(options?.strictOwnership).toBe(true); calls.push('lock');
      const release = await acquireCrossProcessLock(target, options);
      return () => { calls.push('release'); release(); };
    },
    writeJsonFileAtomic: (target, file, options) => {
      expect(options).toEqual({ durable: true, mode: 0o600, indent: null, trailingNewline: false });
      calls.push('write'); writeJsonFileAtomic(target, file, options);
    },
    confirmFileDurable: target => { calls.push('confirm'); confirmFileDurable(target); },
  })).toEqual({ status: 'begun' });
  expect(calls).toEqual(['lock', 'write', 'confirm', 'release']);
  expect(statSync(path).mode & 0o7777).toBe(0o600);
  expect(statSync(dirname(path)).mode & 0o7777).toBe(0o700);
  expect(readAgentHostPairing(home, `${host}/`)).toEqual({ status: 'unknown', ...attempt });
  const before = readFileSync(path);
  expect(await beginAgentHostPairing(home, host, attempt)).toEqual({ status: 'conflict' });
  expect(await beginAgentHostPairing(home, host, { ...attempt, attemptId: 'second-attempt' })).toEqual({ status: 'conflict' });
  expect(readFileSync(path)).toEqual(before);
}));

test('completion requires exact host, matching attempt and name, and cannot rotate a paired entry', async () => fixture(async (home, path) => {
  expect(await completeAgentHostPairing(home, host, attempt.attemptId, secret)).toEqual({ status: 'conflict' });
  await beginAgentHostPairing(home, host, attempt); const unknown = readFileSync(path);
  expect(await completeAgentHostPairing(home, host, 'stale-attempt', secret)).toEqual({ status: 'conflict' });
  expect(await completeAgentHostPairing(home, otherHost, attempt.attemptId, secret)).toEqual({ status: 'conflict' });
  expect(await completeAgentHostPairing(home, host, attempt.attemptId, { ...secret, name: 'Changed name' })).toEqual({ status: 'conflict' });
  expect(readFileSync(path)).toEqual(unknown);
  expect(await completeAgentHostPairing(home, host, attempt.attemptId, secret)).toEqual({ status: 'paired' });
  expect(readAgentHostPairing(home, host)).toEqual({ status: 'paired', ...secret });
  for (const different of [otherHost, host.replace('https:', 'http:'), host.replace('4443', '4444')]) {
    expect(readAgentHostPairing(home, different)).toEqual({ status: 'missing' });
  }
  const paired = readFileSync(path);
  expect(await beginAgentHostPairing(home, host, attempt)).toEqual({ status: 'conflict' });
  expect(await completeAgentHostPairing(home, host, attempt.attemptId, secret)).toEqual({ status: 'conflict' });
  expect(readFileSync(path)).toEqual(paired);
}));

test('concurrent same-host begins have a single winner and cross-host mutations preserve all records', async () => fixture(async home => {
  const attempts = [attempt, { ...attempt, attemptId: 'second-attempt' }];
  const results = await Promise.all(attempts.map(value => beginAgentHostPairing(home, host, value)));
  expect(results.filter(result => result.status === 'begun')).toHaveLength(1);
  expect(results.filter(result => result.status === 'conflict')).toHaveLength(1);
  const retained = readAgentHostPairing(home, host);
  expect(retained.status).toBe('unknown'); if (retained.status !== 'unknown') throw new Error('Expected unknown fixture');
  await Promise.all([
    completeAgentHostPairing(home, host, retained.attemptId, secret),
    beginAgentHostPairing(home, otherHost, { ...attempt, attemptId: 'other-attempt' }),
  ]);
  expect(readAgentHostPairing(home, host)).toEqual({ status: 'paired', ...secret });
  expect(readAgentHostPairing(home, otherHost)).toEqual({ status: 'unknown', ...attempt, attemptId: 'other-attempt' });
}));

test('independent processes serialize updates without dropping another host', async () => fixture(async home => {
  const children = Array.from({ length: 4 }, (_, index) => Bun.spawn([process.execPath, '--eval', `
    import { beginAgentHostPairing } from ${JSON.stringify(moduleUrl)};
    const keepAlive = setInterval(() => {}, 1000);
    try { console.log(JSON.stringify(await beginAgentHostPairing(${JSON.stringify(home)}, 'https://host-${index}.example', ${JSON.stringify({ ...attempt, attemptId: `attempt-${index}` })}))); }
    finally { clearInterval(keepAlive); }
  `], { stdout: 'pipe', stderr: 'pipe' }));
  for (const child of children) {
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text())).toEqual({ status: 'begun' });
  }
  for (let index = 0; index < children.length; index++) {
    expect(readAgentHostPairing(home, `https://host-${index}.example`)).toEqual({ status: 'unknown', ...attempt, attemptId: `attempt-${index}` });
  }
}));

test('independent same-host processes get one durable winner, including repeated identical attempt IDs', async () => fixture(async home => {
  const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, '--eval', `
    import { beginAgentHostPairing } from ${JSON.stringify(moduleUrl)};
    const keepAlive = setInterval(() => {}, 1000);
    try { console.log(JSON.stringify(await beginAgentHostPairing(${JSON.stringify(home)}, ${JSON.stringify(host)}, ${JSON.stringify(attempt)}))); }
    finally { clearInterval(keepAlive); }
  `], { stdout: 'pipe', stderr: 'pipe' }));
  const statuses: string[] = [];
  for (const child of children) {
    expect(await child.exited).toBe(0);
    statuses.push(JSON.parse(await new Response(child.stdout).text()).status);
  }
  expect(statuses.sort()).toEqual(['begun', 'conflict', 'conflict']);
  expect(readAgentHostPairing(home, host)).toEqual({ status: 'unknown', ...attempt });
}));

test('a crashed process leaves a durable unknown marker and its dead-owner lock is recoverable', async () => fixture(async (home, path) => {
  const durableModule = import.meta.resolve('@goodvibes-jev/engine/sdk/platform/state/durable-file-io');
  const child = Bun.spawnSync([process.execPath, '--eval', `
    import { writeSync } from 'node:fs';
    import { beginAgentHostPairing } from ${JSON.stringify(moduleUrl)};
    import { acquireCrossProcessLock } from ${JSON.stringify(durableModule.startsWith('file:') ? durableModule : pathToFileURL(durableModule).href)};
    const result = await beginAgentHostPairing(${JSON.stringify(home)}, ${JSON.stringify(host)}, ${JSON.stringify(attempt)});
    if (result.status !== 'begun') process.exit(1);
    await acquireCrossProcessLock(${JSON.stringify(`${path}.lock`)}, { strictOwnership: true });
    writeSync(1, 'durable'); process.kill(process.pid, 'SIGKILL');
  `], { stdout: 'pipe', stderr: 'pipe' });
  expect(child.stdout.toString()).toBe('durable'); expect(child.success).toBe(false);
  expect(readAgentHostPairing(home, host)).toEqual({ status: 'unknown', ...attempt });
  expect(await beginAgentHostPairing(home, host, attempt)).toEqual({ status: 'conflict' });
  expect(await completeAgentHostPairing(home, host, attempt.attemptId, secret)).toEqual({ status: 'paired' });
}));

test('a pre-publication begin failure reports no success, preserves unrelated hosts and leaks no diagnostics', async () => fixture(async (home, path) => {
  await beginAgentHostPairing(home, otherHost, attempt); const before = readFileSync(path);
  const result = await beginAgentHostPairing(home, host, attempt, {
    writeJsonFileAtomic() { throw new Error(`Untrusted diagnostic ${secret.token}`); },
  });
  expect(result).toEqual(unavailable); expect(JSON.stringify(result)).not.toContain(secret.token);
  expect(readFileSync(path)).toEqual(before);
  expect(readAgentHostPairing(home, host)).toEqual({ status: 'missing' });
}));

test('published-indeterminate begin retains unknown and prevents any second mint after restart', async () => fixture(async (home, path) => {
  const result = await beginAgentHostPairing(home, host, attempt, {
    writeJsonFileAtomic(target, file, options) {
      writeJsonFileAtomic(target, file, options);
      throw new AtomicWriteDurabilityError(target, 'published-indeterminate', new Error(secret.token));
    },
  });
  expect(result).toEqual(unavailable); const before = readFileSync(path);
  expect(readAgentHostPairing(home, host, { confirmFileDurable() { throw new Error(secret.token); } })).toEqual(unavailable);
  expect(readAgentHostPairing(home, host)).toEqual({ status: 'unknown', ...attempt });
  expect(await beginAgentHostPairing(home, host, { ...attempt, attemptId: 'retry' })).toEqual({ status: 'conflict' });
  expect(readFileSync(path)).toEqual(before);
}));

test('failed completion retains unknown, while indeterminate published secret is recovered without reminting', async () => fixture(async (home, path) => {
  await beginAgentHostPairing(home, host, attempt); const before = readFileSync(path);
  expect(await completeAgentHostPairing(home, host, attempt.attemptId, secret, {
    writeJsonFileAtomic() { throw new Error(secret.token); },
  })).toEqual(unavailable);
  expect(readFileSync(path)).toEqual(before);
  expect(readAgentHostPairing(home, host)).toEqual({ status: 'unknown', ...attempt });
  expect(await completeAgentHostPairing(home, host, attempt.attemptId, secret, {
    writeJsonFileAtomic(target, file, options) {
      writeJsonFileAtomic(target, file, options);
      throw new AtomicWriteDurabilityError(target, 'published-indeterminate', new Error(secret.token));
    },
  })).toEqual(unavailable);
  expect(readAgentHostPairing(home, host)).toEqual({ status: 'paired', ...secret });
  expect(await beginAgentHostPairing(home, host, attempt)).toEqual({ status: 'conflict' });
}));

test('publication success requires exact readback and durability verification', async () => fixture(async (home, path) => {
  expect(await beginAgentHostPairing(home, host, attempt, { writeJsonFileAtomic() {}, confirmFileDurable() {} })).toEqual(unavailable);
  expect(existsSync(path)).toBe(false);
  expect(await beginAgentHostPairing(home, host, attempt, {
    confirmFileDurable() { throw new Error('fixture verification failure'); },
  })).toEqual(unavailable);
  expect(readAgentHostPairing(home, host)).toEqual({ status: 'unknown', ...attempt });
  expect(await beginAgentHostPairing(home, host, attempt)).toEqual({ status: 'conflict' });
}));

test('corrupt, oversized, invalid UTF-8 and invalid-schema stores are never treated as empty or rewritten', async () => fixture(async (home, path) => {
  await beginAgentHostPairing(home, host, attempt);
  const record = { host, pairing: { status: 'unknown', ...attempt } };
  const samples = [
    `{\"token\":\"${secret.token}`, new Uint8Array([0xff, 0xfe]), 'x'.repeat(AGENT_HOST_PAIRING_MAX_BYTES + 1),
    JSON.stringify({ version: 2, records: [] }), JSON.stringify({ version: 1, records: [], token: secret.token }),
    JSON.stringify({ version: 1, records: [record, record] }),
    JSON.stringify({ version: 1, records: [{ ...record, host: `${host}/` }] }),
    JSON.stringify({ version: 1, records: [{ ...record, pairing: { ...record.pairing, startedAt: -1 } }] }),
    JSON.stringify({ version: 1, records: [{ ...record, pairing: { status: 'paired', ...secret, token: '' } }] }),
    JSON.stringify({ version: 1, records: Array.from({ length: AGENT_HOST_PAIRING_MAX_RECORDS + 1 }, (_, index) => ({ ...record, host: `https://host-${index}.example` })) }),
  ];
  for (const sample of samples) {
    writeFileSync(path, sample, { mode: 0o600 }); const before = readFileSync(path);
    expect(readAgentHostPairing(home, host)).toEqual(unavailable);
    expect(await beginAgentHostPairing(home, otherHost, attempt)).toEqual(unavailable);
    expect(await completeAgentHostPairing(home, host, attempt.attemptId, secret)).toEqual(unavailable);
    expect(readFileSync(path)).toEqual(before);
  }
}));

test('record limit refuses a new host without evicting unresolved attempts', async () => fixture(async (home, path) => {
  for (let index = 0; index < AGENT_HOST_PAIRING_MAX_RECORDS; index++) {
    expect(await beginAgentHostPairing(home, `https://host-${index}.example`, attempt)).toEqual({ status: 'begun' });
  }
  const before = readFileSync(path);
  expect(await beginAgentHostPairing(home, host, attempt)).toEqual(unavailable);
  expect(readFileSync(path)).toEqual(before);
  expect(await completeAgentHostPairing(home, 'https://host-0.example', attempt.attemptId, secret)).toEqual({ status: 'paired' });
}));

test('insecure existing file or directory permissions fail closed and are not repaired implicitly', async () => fixture(async (home, path) => {
  await beginAgentHostPairing(home, host, attempt); const before = readFileSync(path);
  for (const [target, badMode, restoredMode] of [
    [path, 0o644, 0o600], [path, 0o400, 0o600], [dirname(path), 0o755, 0o700],
    [join(home, '.goodvibes', 'agent'), 0o777, 0o700], [home, 0o777, 0o700],
  ] as const) {
    chmodSync(target, badMode);
    expect(readAgentHostPairing(home, host)).toEqual(unavailable);
    expect(await beginAgentHostPairing(home, otherHost, attempt)).toEqual(unavailable);
    expect(await completeAgentHostPairing(home, host, attempt.attemptId, secret)).toEqual(unavailable);
    expect(statSync(target).mode & 0o7777).toBe(badMode);
    chmodSync(target, restoredMode);
  }
  expect(readFileSync(path)).toEqual(before);
}));

test('a replaceable home ancestry is unavailable even when the private store itself has safe modes', async () => fixture(async home => {
  const unsafe = join(home, 'unsafe-parent'); mkdirSync(unsafe, { mode: 0o700 });
  const nestedHome = join(unsafe, 'home'); mkdirSync(nestedHome, { mode: 0o700 });
  await beginAgentHostPairing(nestedHome, host, attempt);
  chmodSync(unsafe, 0o777);
  expect(readAgentHostPairing(nestedHome, host)).toEqual(unavailable);
  expect(await beginAgentHostPairing(nestedHome, otherHost, attempt)).toEqual(unavailable);
  expect(await completeAgentHostPairing(nestedHome, host, attempt.attemptId, secret)).toEqual(unavailable);
}));

test('symlink files, dangling links, symlink ancestors and hardlinked secrets fail closed', async () => fixture(async (home, path) => {
  await beginAgentHostPairing(home, host, attempt); const original = readFileSync(path);
  const target = join(home, 'target.json'); writeFileSync(target, original, { mode: 0o600 });
  rmSync(path); symlinkSync(target, path);
  expect(readAgentHostPairing(home, host)).toEqual(unavailable);
  expect(await beginAgentHostPairing(home, otherHost, attempt)).toEqual(unavailable);
  rmSync(path); symlinkSync(join(home, 'absent'), path);
  expect(readAgentHostPairing(home, host)).toEqual(unavailable);
  expect(await completeAgentHostPairing(home, host, attempt.attemptId, secret)).toEqual(unavailable);
  rmSync(path); linkSync(target, path);
  expect(readAgentHostPairing(home, host)).toEqual(unavailable);
  expect(await beginAgentHostPairing(home, otherHost, attempt)).toEqual(unavailable);
  rmSync(dirname(path), { recursive: true });
  const actual = join(home, 'actual'); mkdirSync(actual, { mode: 0o700 }); symlinkSync(actual, dirname(path));
  expect(readAgentHostPairing(home, host)).toEqual(unavailable);
  expect(await beginAgentHostPairing(home, host, attempt)).toEqual(unavailable);
  expect(readFileSync(target)).toEqual(original);
}));

test('invalid input, failed lock acquisition and hostile lock symlinks never publish pairing state', async () => fixture(async (home, path) => {
  expect(await beginAgentHostPairing(home, `${host}/path`, attempt)).toEqual(unavailable);
  expect(await beginAgentHostPairing(home, host, { ...attempt, attemptId: '' })).toEqual(unavailable);
  expect(await beginAgentHostPairing(home, host, { ...attempt, name: 'bad\nname' })).toEqual(unavailable);
  expect(await completeAgentHostPairing(home, host, attempt.attemptId, { ...secret, token: 'bad token' })).toEqual(unavailable);
  expect(existsSync(dirname(path))).toBe(false);
  expect(await beginAgentHostPairing(home, host, attempt, {
    acquireCrossProcessLock: async () => { throw new Error(secret.token); },
  })).toEqual(unavailable);
  expect(existsSync(path)).toBe(false);
  const target = join(home, 'lock-target'); writeFileSync(target, 'unchanged');
  symlinkSync(target, `${path}.lock`);
  expect(await beginAgentHostPairing(home, host, attempt)).toEqual(unavailable);
  expect(readFileSync(target, 'utf8')).toBe('unchanged'); expect(existsSync(path)).toBe(false);
}));
