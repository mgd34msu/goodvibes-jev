import { expect } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { beginTuiHostPairing, completeTuiHostPairing, tuiHostPairingStorePath } from '../../runtime/tui-host-credential-store.ts';

/** Production durable store writes, scoped to one exact synthetic test origin. */
export async function pairNativeTestHost(home: string, host: string, token: string): Promise<void> {
  const attemptId = crypto.randomUUID(); const name = 'TUI native test';
  expect(await beginTuiHostPairing(home, host, { attemptId, name, startedAt: 1 })).toEqual({ status: 'begun' });
  expect(await completeTuiHostPairing(home, host, attemptId, { token, tokenId: 'paired-test-principal', name, createdAt: 2 })).toEqual({ status: 'paired' });
}

/** Simulates owner-side store replacement without giving the passive reader a writer. */
export function replaceNativeTestCredential(home: string, token?: string): void {
  const path = tuiHostPairingStorePath(home);
  const file = JSON.parse(readFileSync(path, 'utf8'));
  file.records[0].pairing.createdAt++;
  if (token) file.records[0].pairing.token = token;
  writeFileSync(path, JSON.stringify(file), { mode: 0o600 });
}
