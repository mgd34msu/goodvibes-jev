/**
 * ContractStore (design 7.1): round trip, atomic write, quarantine of files it
 * cannot trust, reaping bounds, and importContract refusing to replace a live
 * contract without force.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContractEvent } from '../../sdk/src/events/contract.js';
import {
  CONTRACT_QUARANTINE_MAX_AGE_MS,
  ContractStore,
  MAX_CONTRACT_QUARANTINE_FILES,
  MAX_TERMINAL_CONTRACT_FILES,
  TERMINAL_CONTRACT_MAX_AGE_MS,
  contractPath,
  contractsDir,
  deserializeContract,
  readContractSnapshot,
  serializeContract,
  type Contract,
  type ContractSnapshotRejection,
} from '../../sdk/src/platform/contract/index.js';
import { makeContract } from './fixtures.js';

const DAY = 24 * 60 * 60 * 1000;
const roots: string[] = [];

function tempRoot(): string {
  const root = join(tmpdir(), `gv-contract-store-${Date.now()}-${crypto.randomUUID()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const dir = contractsDir(root);
    if (existsSync(dir)) chmodSync(dir, 0o700);
    rmSync(root, { recursive: true, force: true });
  }
});

function envelope(contract: unknown, schemaVersion = 1, writtenAt = 5): string {
  return JSON.stringify({ schemaVersion, writtenAt, contract });
}

function writeRaw(root: string, id: string, text: string): string {
  mkdirSync(contractsDir(root), { recursive: true });
  const path = contractPath(root, id);
  writeFileSync(path, text, 'utf-8');
  return path;
}

function storeAt(root: string, now: number = Date.now()): ContractStore {
  return new ContractStore({ projectRoot: root, now: () => now, sweepIntervalMs: 0 });
}

function terminalContract(completedAt: number, status: Contract['status'] = 'passed'): Contract {
  return makeContract({ status, completedAt });
}

describe('round trip', () => {
  test('a written contract loads back equal, inside a versioned envelope', () => {
    const root = tempRoot();
    const store = storeAt(root, 42_000);
    const contract = makeContract();
    contract.units[0]!.criteria[0]!.readings.push({
      checkId: 'u1.k1', at: 10, probabilityUnmet: 0.12, verdict: 'met', outcome: 'act', decisionId: 'd-1',
    });
    store.put(contract);
    expect(store.write(contract.id)).toBe(true);

    const onDisk = JSON.parse(readFileSync(contractPath(root, contract.id), 'utf-8')) as Record<string, unknown>;
    expect(onDisk['schemaVersion']).toBe(1);
    expect(onDisk['writtenAt']).toBe(42_000);
    expect(storeAt(root).load(contract.id)).toEqual(contract);
  });

  test('serialize, then import into another store, gives the same contract', () => {
    const source = storeAt(tempRoot());
    const contract = makeContract({ status: 'passed', completedAt: 9 });
    source.put(contract);
    const json = source.serialize(contract.id);
    expect(json).not.toBeNull();
    const target = storeAt(tempRoot());
    expect(target.importContract(json!)).toBe(true);
    expect(target.get(contract.id)).toEqual(contract);
    expect(deserializeContract(json!)).toEqual(contract);
    expect(source.serialize('ctr-00000000')).toBeNull();
  });
});

describe('atomic write', () => {
  test('a write leaves only the contract file behind, and a rewrite replaces it whole', () => {
    const root = tempRoot();
    const store = storeAt(root);
    const contract = makeContract();
    store.put(contract);
    store.write(contract.id);
    contract.goal = 'A second goal';
    contract.status = 'judging';
    store.write(contract.id);
    expect(readdirSync(contractsDir(root))).toEqual([`${contract.id}.json`]);
    expect(storeAt(root).load(contract.id)?.goal).toBe('A second goal');
  });

  test('a write that fails keeps the previous file whole', () => {
    const root = tempRoot();
    const store = storeAt(root);
    const contract = makeContract();
    store.put(contract);
    store.write(contract.id);
    chmodSync(contractsDir(root), 0o500);
    contract.goal = 'Never written';
    expect(store.write(contract.id)).toBe(false);
    chmodSync(contractsDir(root), 0o700);
    expect(storeAt(root).load(contract.id)?.goal).toBe('A parser for every documented input form');
    expect(readdirSync(contractsDir(root))).toEqual([`${contract.id}.json`]);
  });

  test('a temp file left by a dead writer is reaped after an hour; a fresh one is left alone', () => {
    const root = tempRoot();
    const contract = makeContract();
    const path = writeRaw(root, contract.id, envelope(contract));
    const stale = `${path}.tmp-999-1-deadbeef`;
    const fresh = `${path}.tmp-999-2-feedface`;
    writeFileSync(stale, '{"partial', 'utf-8');
    writeFileSync(fresh, '{"partial', 'utf-8');
    const now = Date.now();
    utimesSync(stale, new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000));
    const summary = storeAt(root, now).reap();
    expect(summary.staleTempRemoved).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  test('no contract id can name a path outside the contract directory', () => {
    expect(() => contractPath('/p', '../ctr-00000000')).toThrow('Not a contract id');
    expect(() => contractPath('/p', 'ctr-0000000g')).toThrow('Not a contract id');
    expect(contractPath('/p', 'ctr-0000abcd')).toBe(join('/p', '.goodvibes', 'contracts', 'ctr-0000abcd.json'));
  });
});

describe('quarantine', () => {
  const cases: ReadonlyArray<readonly [string, (contract: Contract) => string, ContractSnapshotRejection]> = [
    ['corrupt JSON', () => '{"schemaVersion": 1, "contract": {', 'unparseable'],
    ['a newer schema version', (contract) => envelope(contract, 2), 'future-version'],
    ['a bare contract with no envelope', (contract) => JSON.stringify(contract), 'invalid-contract'],
    ['an envelope with no schema version', (contract) => JSON.stringify({ writtenAt: 1, contract }), 'not-an-envelope'],
    ['a malformed contract', (contract) => envelope({ ...contract, units: 'none' }), 'invalid-contract'],
    ['an unknown status', (contract) => envelope({ ...contract, status: 'reviewing' }), 'invalid-contract'],
  ];

  for (const [name, text, reason] of cases) {
    test(`${name} is moved to .unrecognized and not loaded`, () => {
      const root = tempRoot();
      const contract = makeContract();
      const path = writeRaw(root, contract.id, text(contract));
      expect(readContractSnapshot(text(contract))).toEqual({ rejected: reason });
      expect(storeAt(root).load(contract.id)).toBeNull();
      expect(existsSync(path)).toBe(false);
      expect(readFileSync(`${path}.unrecognized`, 'utf-8')).toBe(text(contract));
    });
  }

  test('a file holding a different contract than its name is quarantined', () => {
    const root = tempRoot();
    const contract = makeContract();
    const path = writeRaw(root, 'ctr-0000ffff', envelope(contract));
    expect(storeAt(root).load('ctr-0000ffff')).toBeNull();
    expect(existsSync(`${path}.unrecognized`)).toBe(true);
  });

  test('deserializeContract refuses a newer schema rather than trusting part of it', () => {
    expect(deserializeContract(envelope(makeContract(), 2))).toBeNull();
    expect(deserializeContract(envelope(makeContract(), 1))).not.toBeNull();
  });
});

describe('reaping', () => {
  test('a terminal contract past 14 days is reaped; one within 14 days and any live contract are kept', () => {
    const root = tempRoot();
    const now = 100 * DAY;
    const old = terminalContract(now - TERMINAL_CONTRACT_MAX_AGE_MS - 1, 'failed');
    const recent = terminalContract(now - TERMINAL_CONTRACT_MAX_AGE_MS + 1, 'cancelled');
    const live = makeContract({ status: 'awaiting-owner', createdAt: 0 });
    for (const contract of [old, recent, live]) writeRaw(root, contract.id, envelope(contract, 1, 0));

    const summary = storeAt(root, now).reap();
    expect(summary.terminalExpired).toBe(1);
    expect(summary.reapedIds).toEqual([old.id]);
    expect(existsSync(contractPath(root, old.id))).toBe(false);
    expect(existsSync(contractPath(root, recent.id))).toBe(true);
    expect(existsSync(contractPath(root, live.id))).toBe(true);
  });

  test('beyond 50 terminal files the oldest go; live contracts do not count and are never reaped', () => {
    const root = tempRoot();
    const now = 100 * DAY;
    const terminal = Array.from({ length: MAX_TERMINAL_CONTRACT_FILES + 3 }, (_, index) => terminalContract(now - DAY + index));
    const live = Array.from({ length: 5 }, () => makeContract({ status: 'running' }));
    for (const contract of [...terminal, ...live]) writeRaw(root, contract.id, envelope(contract));

    const summary = storeAt(root, now).reap();
    expect(summary.terminalOverCap).toBe(3);
    expect([...summary.reapedIds].sort()).toEqual(terminal.slice(0, 3).map((contract) => contract.id).sort());
    expect(readdirSync(contractsDir(root))).toHaveLength(MAX_TERMINAL_CONTRACT_FILES + 5);
  });

  test('a contract held live in memory is not reaped even when its file on disk says terminal', () => {
    const root = tempRoot();
    const now = 100 * DAY;
    const onDisk = terminalContract(0);
    writeRaw(root, onDisk.id, envelope(onDisk));
    const store = storeAt(root, now);
    store.put({ ...onDisk, status: 'running', completedAt: undefined });
    expect(store.reap().total).toBe(0);
    expect(existsSync(contractPath(root, onDisk.id))).toBe(true);
  });

  test('a reaped terminal contract is released from memory', () => {
    const root = tempRoot();
    const store = storeAt(root, 100 * DAY);
    const contract = terminalContract(0);
    store.put(contract);
    store.write(contract.id);
    store.reap();
    expect(store.get(contract.id)).toBeNull();
  });

  test('quarantine files go after 30 days, and beyond 20 the oldest go', () => {
    const root = tempRoot();
    const now = Date.now();
    mkdirSync(contractsDir(root), { recursive: true });
    const files = Array.from({ length: MAX_CONTRACT_QUARANTINE_FILES + 4 }, (_, index) => {
      const path = join(contractsDir(root), `ctr-${index.toString(16).padStart(8, '0')}.json.unrecognized`);
      writeFileSync(path, 'x', 'utf-8');
      const at = new Date(now - (index + 1) * 60_000);
      utimesSync(path, at, at);
      return path;
    });
    const expired = join(contractsDir(root), 'ctr-ffffffff.json.unrecognized');
    writeFileSync(expired, 'x', 'utf-8');
    const long = new Date(now - CONTRACT_QUARANTINE_MAX_AGE_MS - 60_000);
    utimesSync(expired, long, long);

    const summary = storeAt(root, now).reap();
    expect(summary.quarantineExpired).toBe(1);
    expect(summary.quarantineOverCap).toBe(4);
    expect(existsSync(expired)).toBe(false);
    // The newest 20 remain: files are numbered newest first.
    expect(files.filter((path) => existsSync(path))).toEqual(files.slice(0, MAX_CONTRACT_QUARANTINE_FILES));
  });

  test('a refused file is left for load() to quarantine, not deleted by the reap', () => {
    const root = tempRoot();
    const contract = terminalContract(0);
    const path = writeRaw(root, contract.id, envelope(contract, 2));
    expect(storeAt(root, 100 * DAY).reap().total).toBe(0);
    expect(existsSync(path)).toBe(true);
  });

  test('listStoredIds reaps first, so a reaped id is never handed back', () => {
    const root = tempRoot();
    const old = terminalContract(0);
    const live = makeContract();
    writeRaw(root, old.id, envelope(old));
    writeRaw(root, live.id, envelope(live));
    writeFileSync(join(contractsDir(root), 'notes.json'), '{}', 'utf-8');
    expect(storeAt(root, 100 * DAY).listStoredIds()).toEqual([live.id]);
  });
});

describe('importContract', () => {
  test('refuses to replace a live contract held in memory unless forced', () => {
    const store = storeAt(tempRoot());
    const live = makeContract({ status: 'running' });
    store.put(live);
    const replacement = { ...live, status: 'passed' as const, goal: 'Replaced' };
    const json = serializeContract(replacement, 1)!;
    expect(store.importContract(json)).toBe(false);
    expect(store.get(live.id)?.goal).toBe(live.goal);
    expect(store.importContract(json, true)).toBe(true);
    expect(store.get(live.id)?.goal).toBe('Replaced');
  });

  test('refuses to replace a live contract that is only on disk unless forced', () => {
    const root = tempRoot();
    const live = makeContract({ status: 'awaiting-owner' });
    writeRaw(root, live.id, envelope(live));
    const json = serializeContract({ ...live, goal: 'Replaced' }, 1)!;
    expect(storeAt(root).importContract(json)).toBe(false);
    expect(storeAt(root).load(live.id)?.goal).toBe(live.goal);
    expect(storeAt(root).importContract(json, true)).toBe(true);
    expect(storeAt(root).load(live.id)?.goal).toBe('Replaced');
  });

  test('replaces a terminal contract without force, holding and writing it at once', () => {
    const root = tempRoot();
    const store = storeAt(root);
    const done = makeContract({ status: 'failed', completedAt: 3 });
    store.put(done);
    const again = { ...done, status: 'queued' as const, completedAt: undefined };
    expect(store.importContract(serializeContract(again, 1)!)).toBe(true);
    expect(store.get(done.id)?.status).toBe('queued');
    expect(storeAt(root).load(done.id)?.status).toBe('queued');
  });

  test('refuses a snapshot it cannot trust', () => {
    const store = storeAt(tempRoot());
    expect(store.importContract(envelope(makeContract(), 2))).toBe(false);
    expect(store.importContract('not json')).toBe(false);
    expect(store.list()).toEqual([]);
  });
});

describe('the debounced writer', () => {
  function bus(): { subscribe: (listener: (event: ContractEvent) => void) => () => void; emit: (event: ContractEvent) => void; listeners: number } {
    const listeners = new Set<(event: ContractEvent) => void>();
    return {
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (event) => listeners.forEach((listener) => listener(event)),
      get listeners() {
        return listeners.size;
      },
    };
  }

  test('a contract event schedules a write of that contract after the debounce', async () => {
    const root = tempRoot();
    const events = bus();
    const store = new ContractStore({ projectRoot: root, debounceMs: 20, sweepIntervalMs: 0 });
    const contract = makeContract();
    store.put(contract);
    store.flush();
    const detach = store.attach(events.subscribe);
    contract.status = 'judging';
    events.emit({ type: 'CONTRACT_STATUS_CHANGED', contractId: contract.id, from: 'running', to: 'judging' });
    expect(storeAt(root).load(contract.id)?.status).toBe('running');
    await Bun.sleep(60);
    expect(storeAt(root).load(contract.id)?.status).toBe('judging');
    detach();
    expect(events.listeners).toBe(0);
  });

  test('detaching writes whatever is still pending, and events for contracts not held are ignored', () => {
    const root = tempRoot();
    const events = bus();
    const store = new ContractStore({ projectRoot: root, debounceMs: 60_000, sweepIntervalMs: 0 });
    const contract = makeContract();
    store.put(contract);
    const detach = store.attach(events.subscribe);
    events.emit({ type: 'CONTRACT_PASSED', contractId: 'ctr-00000abc', criteriaMet: 1, criteriaJudged: 1, excluded: 0, nudges: 0 });
    events.emit({ type: 'CONTRACT_SPAWN_GUARD_TRIGGERED', agentId: 'a', depth: 2, activeAgents: 3, reason: 'units are leaves' });
    expect(existsSync(contractPath(root, contract.id))).toBe(false);
    detach();
    expect(existsSync(contractPath(root, contract.id))).toBe(true);
    expect(existsSync(contractPath(root, 'ctr-00000abc'))).toBe(false);
  });
});
