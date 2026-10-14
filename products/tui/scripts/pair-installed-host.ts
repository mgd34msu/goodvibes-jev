import { randomUUID } from 'node:crypto';
import { readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { beginTuiHostPairing, completeTuiHostPairing, readTuiHostPairing, type TuiHostPairingSecret } from '../src/runtime/tui-host-credential-store.ts';
import { readTuiLegacyPairingBootstrap } from '../src/runtime/tui-host-pairing-bootstrap.ts';

// The explicitly invoked local installer provisions its own client and daemon.
// Generic host pairing still requires the owner-terminal confirmation flow.
const [prefixArg, homeArg, portArg, workspaceArg] = process.argv.slice(2);
if (!prefixArg || !homeArg || !portArg || !workspaceArg) throw new Error('Expected installation prefix, data directory, port and workspace.');
const prefix = resolve(prefixArg), home = resolve(homeArg), port = Number(portArg);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid installed daemon port.');
const pid = execFileSync('systemctl', ['--user', 'show', 'goodvibes-jev.service', '--property=MainPID', '--value'], { encoding: 'utf8' }).trim();
const executable = realpathSync(join(prefix, 'current', 'daemon', `goodvibes-daemon-linux-${process.arch === 'arm64' ? 'arm64' : 'x64'}`));
if (readlinkSync(`/proc/${pid}/exe`) !== executable) throw new Error('Pairing requires the daemon running from this installation.');
const host = `http://127.0.0.1:${port}`;
interface Auth { authenticated: boolean; admin: boolean; principalKind: string; principalId: string; scopes: string[] }
async function invoke<T = unknown>(token: string, method: string, body: object = {}): Promise<T> {
  const response = await fetch(`${host}/api/control-plane/methods/${method}/invoke`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ body }),
  });
  if (!response.ok) throw new Error(`Installed daemon ${method} failed: HTTP ${response.status}.`);
  return response.json() as Promise<T>;
}
async function verify(pairing: TuiHostPairingSecret): Promise<void> {
  const auth = await invoke<Auth>(pairing.token, 'control.auth.current');
  if (!auth.authenticated || !auth.admin || auth.principalKind !== 'token' || auth.principalId !== `pairing:${pairing.tokenId}`
    || !['read:work-ledger', 'write:work-ledger'].every(scope => auth.scopes?.includes(scope) || auth.scopes?.includes('*'))) {
    throw new Error('Installed TUI credential lacks native conversation access.');
  }
}
const existing = readTuiHostPairing(home, host);
if (existing.status === 'paired') {
  await verify(existing);
} else {
  if (existing.status !== 'missing') throw new Error('TUI pairing needs recovery; the installer will not replace an uncertain credential.');
  const bootstrap = readTuiLegacyPairingBootstrap(home);
  if (!bootstrap) throw new Error('Installed daemon bootstrap credential is unavailable.');
  const auth = await invoke<Auth>(bootstrap, 'control.auth.current');
  if (!auth.authenticated || !auth.admin || auth.principalId !== 'shared-token') throw new Error('Installed daemon bootstrap authority is unavailable.');
  const attemptId = randomUUID(), name = 'GoodVibes installed TUI';
  const begun = await beginTuiHostPairing(home, host, { attemptId, name, startedAt: Date.now() });
  if (begun.status !== 'begun') throw new Error('TUI pairing changed during installation.');
  const result = await invoke<{ token: { id: string; token: string; name: string; createdAt: number } }>(bootstrap, 'pairing.tokens.migrate', { name });
  const minted = result.token;
  if (!minted || !/^pair-[0-9a-f-]{36}$/i.test(minted.id) || !/^gvp_[A-Za-z0-9_-]{32}$/.test(minted.token)
    || minted.name !== name || !Number.isSafeInteger(minted.createdAt) || minted.createdAt <= 0) throw new Error('Invalid daemon pairing response; inspect the saved pairing attempt before retrying.');
  const pairing = { token: minted.token, tokenId: minted.id, name, createdAt: minted.createdAt };
  const saved = await completeTuiHostPairing(home, host, attemptId, pairing);
  if (saved.status !== 'paired') throw new Error('Could not save TUI pairing; inspect the existing attempt before retrying.');
  await verify(pairing);
}
const pairing = readTuiHostPairing(home, host);
if (pairing.status !== 'paired') throw new Error('Installed TUI connection changed.');
await invoke(pairing.token, 'workspaces.registrations.add', { root: realpathSync(workspaceArg), origin: 'installer', label: 'Installed daemon workspace' });
await invoke(pairing.token, 'workLedger.intake.get', { inputId: 'installation-readiness-check' });
console.log('Installed TUI connection and conversation workspace verified.');
