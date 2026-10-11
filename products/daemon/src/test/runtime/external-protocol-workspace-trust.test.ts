import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createDaemonWorkspaceTrustResolver } from '../../runtime/workspace-trust-composition.js';
import { deferred, externalProtocolFixture, until } from '../helpers/external-protocol-fixture.js';

function protocolSpawns(calls: readonly (readonly unknown[])[], workspace: string): string[][] {
  return calls.map(([input]) => Array.isArray(input) ? input : input && typeof input === 'object' && 'cmd' in input ? input.cmd : undefined)
    .filter((command): command is string[] => Array.isArray(command) && command.every(arg => typeof arg === 'string'))
    .filter(command => command[0] === process.execPath || command[0] === join(workspace, '..', 'bin', 'claude-code-acp'));
}


for (const mode of ['ask-on-risk', 'allow-all'] as const) test(`explicit workspace restriction prevents MCP ${mode} write`, async () => {
  const f = await externalProtocolFixture();
  try {
    await f.daemon.services.workspaceTrustManager.setLevel('restricted');
    f.registry.setServerTrustMode('owned-protocol', mode);
    await expect(f.call()).rejects.toThrow();
    expect(f.calls).toHaveLength(0); expect(f.human).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('MCP deterministic allow needs genuine original source and recorded admission', async () => {
  const f = await externalProtocolFixture();
  try {
    f.registry.setServerTrustMode('owned-protocol', 'allow-all');
    await expect(f.registry.callTool('mcp:owned-protocol:write', { goal: 'Peer prose is not an origin' })).rejects.toThrow('original operation source');
    expect(f.calls).toHaveLength(0);
    expect(await f.call()).toMatchObject({ done: true });
    expect(f.calls).toHaveLength(1); expect(f.admissions).toHaveBeenCalled();
    expect(JSON.stringify(f.readings.filter(reading => 'disposition' in reading.questions))).toContain('Original caller:');
    expect(f.daemon.services.workspaceTrustManager.isDecided()).toBe(false);
    expect(f.human).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('restricted daemon origin prevents initial ACP and MCP process spawn', async () => {
  const f = await externalProtocolFixture();
  const spawn = spyOn(Bun, 'spawn');
  try {
    await f.daemon.services.workspaceTrustManager.setLevel('restricted');
    await expect(f.spawn('Original owner goal')).rejects.toThrow();
    await expect(f.daemon.daemon.registerMcpServer({ name: 'must-not-start', command: process.execPath, args: ['--version'] })).rejects.toThrow();
    expect(protocolSpawns(spawn.mock.calls, f.daemon.workingDirectory)).toEqual([]); expect(f.human).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); await f.close(); }
});

test('ACP target capability is shared with physical aliases and cannot borrow trusted daemon root', async () => {
  const f = await externalProtocolFixture();
  const other = join(f.daemon.workingDirectory, 'other'); mkdirSync(other);
  const alias = join(f.daemon.workingDirectory, 'alias'); symlinkSync(other, alias);
  const trustFor = createDaemonWorkspaceTrustResolver({ workingDirectory: f.daemon.workingDirectory, homeDirectory: f.daemon.homeDirectory, workspaceTrustManager: f.daemon.services.workspaceTrustManager });
  const spawn = spyOn(Bun, 'spawn');
  try {
    expect(trustFor(f.daemon.workingDirectory)).toBe(f.daemon.services.workspaceTrustManager);
    expect(trustFor(alias)).toBe(trustFor(other));
    await f.daemon.services.workspaceTrustManager.setLevel('trusted');
    await trustFor(other).setLevel('restricted');
    await expect(f.spawn('Original owner goal', 'permission-reject-first', alias)).rejects.toThrow();
    expect(protocolSpawns(spawn.mock.calls, f.daemon.workingDirectory)).toEqual([]); expect(f.human).not.toHaveBeenCalled();
  } finally { spawn.mockRestore(); await f.close(); }
});

test('ACP physical cwd replacement during target preparation cannot spawn', async () => {
  const f = await externalProtocolFixture();
  const original = join(f.daemon.workingDirectory, 'original'), replacement = join(f.daemon.workingDirectory, 'replacement');
  mkdirSync(original); mkdirSync(replacement);
  const alias = join(f.daemon.workingDirectory, 'alias'); symlinkSync(original, alias);
  const trustFor = createDaemonWorkspaceTrustResolver({ workingDirectory: f.daemon.workingDirectory, homeDirectory: f.daemon.homeDirectory, workspaceTrustManager: f.daemon.services.workspaceTrustManager });
  const target = trustFor(original); const entered = deferred(), release = deferred();
  const prepare = target.prepareAutonomousConstraint.bind(target);
  const held = spyOn(target, 'prepareAutonomousConstraint').mockImplementation(async (...args) => { const current = await prepare(...args); entered.resolve(); await release.promise; return current; });
  const spawn = spyOn(Bun, 'spawn');
  const pending = f.spawn('Original owner goal', 'permission-reject-first', alias).then(value => ({ value }), error => ({ error }));
  try {
    await entered.promise; unlinkSync(alias); symlinkSync(replacement, alias); release.resolve();
    expect(await pending).toHaveProperty('error'); expect(protocolSpawns(spawn.mock.calls, f.daemon.workingDirectory)).toEqual([]);
  } finally { release.resolve(); await pending; held.mockRestore(); spawn.mockRestore(); await f.close(); }
});

for (const protocol of ['MCP', 'ACP']) test(`${protocol} trust ABA during recorded admission cannot write permission`, async () => {
  const f = await externalProtocolFixture();
  const trust = f.daemon.services.workspaceTrustManager;
  await trust.setLevel('trusted');
  let changed = false;
  f.onReading(async reading => {
    if (changed || !('disposition' in reading.questions)) return;
    changed = true; await trust.setLevel('restricted'); await trust.setLevel('trusted');
  });
  try {
    if (protocol === 'MCP') { await expect(f.call()).rejects.toThrow(); expect(f.calls).toHaveLength(0); }
    else {
      const hosted = await f.spawn('Original owner goal');
      await until(() => f.acp.get(hosted.id)?.state === 'idle', 'ACP refusal settles');
      expect(f.acp.get(hosted.id)?.progress).not.toContain('permission granted');
    }
    expect(changed).toBe(true); expect(f.human).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('MCP stdio trust change while negotiating prevents late transport publication', async () => {
  const f = await externalProtocolFixture();
  const { existsSync, writeFileSync } = await import('node:fs');
  const peer = join(f.daemon.workingDirectory, 'held-peer.ts');
  const entered = join(f.daemon.workingDirectory, 'discover-entered');
  const release = join(f.daemon.workingDirectory, 'discover-release');
  writeFileSync(peer, `import { createInterface } from 'node:readline'; import { existsSync,writeFileSync } from 'node:fs';
for await (const line of createInterface({input:process.stdin})) { const req=JSON.parse(line); if(req.method==='server/discover') {writeFileSync(${JSON.stringify(entered)},'ready'); while(!existsSync(${JSON.stringify(release)})) await new Promise(r=>setTimeout(r,5)); process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{},serverInfo:{name:'local',version:'1'}}})+'\\n');} }`);
  const pending = f.daemon.daemon.registerMcpServer({ name: 'held-stdio', command: process.execPath, args: [peer] }).then(() => ({ connected: true }), error => ({ error }));
  try {
    await until(() => existsSync(entered), 'local stdio peer must enter negotiation');
    await f.daemon.services.workspaceTrustManager.setLevel('restricted'); writeFileSync(release, 'continue');
    expect(await pending).toHaveProperty('error'); expect(f.registry.getClient('held-stdio')).toBeUndefined();
  } finally { writeFileSync(release, 'continue'); await pending; await f.close(); }
});

test('MCP restart process boundary cannot reuse revoked workspace execution authority', async () => {
  const f = await externalProtocolFixture();
  const { writeFileSync } = await import('node:fs');
  const peer = join(f.daemon.workingDirectory, 'restart-peer.ts');
  writeFileSync(peer, `import { createInterface } from 'node:readline';
for await (const line of createInterface({input:process.stdin})) { const req=JSON.parse(line); if(req.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result:{resultType:'complete',supportedVersions:['2026-07-28'],capabilities:{},serverInfo:{name:'local',version:'1'}}})+'\\n'); }`);
  const spawn = spyOn(Bun, 'spawn');
  try {
    await f.daemon.daemon.registerMcpServer({ name: 'restart-stdio', command: process.execPath, args: [peer] });
    const client = f.registry.getClient('restart-stdio'); expect(client?.isConnected).toBe(true);
    const internal = client as unknown as { proc: ReturnType<typeof Bun.spawn>; _startProcess(): Promise<void> };
    // _startProcess is the exact boundary the automatic restart timer calls.
    // Dispose the first real peer and directly exercise that restart boundary
    // rather than waiting on wall-clock scheduling or a child crash heuristic.
    await client!.disconnect();
    await f.daemon.services.workspaceTrustManager.setLevel('restricted');
    await expect(internal._startProcess()).rejects.toThrow();
    expect(protocolSpawns(spawn.mock.calls, f.daemon.workingDirectory)).toEqual([[process.execPath, peer]]); expect(client?.isConnected).toBe(false);
  } finally { spawn.mockRestore(); await f.close(); }
});

test('ACP origin physical retarget cannot borrow a stable distinct target capability', async () => {
  const f = await externalProtocolFixture();
  const targetPath = join(f.daemon.workingDirectory, 'target'), replacement = join(f.daemon.workingDirectory, 'replacement');
  mkdirSync(targetPath); mkdirSync(replacement);
  const rootAlias = join(f.daemon.homeDirectory, 'origin-alias'); symlinkSync(f.daemon.workingDirectory, rootAlias);
  // Model a daemon rooted through a lexical alias without replacing its real
  // permission manager, workspace authority or target resolver.
  const host = (f.registry as unknown as { permissionHost: { workspaceRoot: string } }).permissionHost;
  const originalRoot = host.workspaceRoot; host.workspaceRoot = rootAlias;
  const trustFor = createDaemonWorkspaceTrustResolver({ workingDirectory: f.daemon.workingDirectory, homeDirectory: f.daemon.homeDirectory, workspaceTrustManager: f.daemon.services.workspaceTrustManager });
  const target = trustFor(targetPath), entered = deferred(), release = deferred();
  const prepare = target.prepareAutonomousConstraint.bind(target);
  const held = spyOn(target, 'prepareAutonomousConstraint').mockImplementation(async (...args) => { const current = await prepare(...args); entered.resolve(); await release.promise; return current; });
  const spawn = spyOn(Bun, 'spawn');
  const pending = f.spawn('Original owner goal', 'permission-reject-first', targetPath).then(value => ({ value }), error => ({ error }));
  try {
    await entered.promise; unlinkSync(rootAlias); symlinkSync(replacement, rootAlias); release.resolve();
    expect(await pending).toHaveProperty('error'); expect(protocolSpawns(spawn.mock.calls, f.daemon.workingDirectory)).toEqual([]);
  } finally { release.resolve(); await pending; host.workspaceRoot = originalRoot; held.mockRestore(); spawn.mockRestore(); await f.close(); }
});

test('MCP post-dispatch trust ABA prevents an elicitation continuation', async () => {
  const f = await externalProtocolFixture();
  const trust = f.daemon.services.workspaceTrustManager;
  await trust.setLevel('trusted'); f.elicit();
  let changed = false;
  f.onReading(async reading => {
    if (changed || !f.calls.length || !('disposition' in reading.questions)) return;
    changed = true; await trust.setLevel('restricted'); await trust.setLevel('trusted');
  });
  try { await expect(f.call()).rejects.toThrow(); expect(changed).toBe(true); expect(f.calls).toHaveLength(1); }
  finally { await f.close(); }
});

test('an autonomous protocol owner with missing workspace capability fails closed', async () => {
  const f = await externalProtocolFixture();
  const host = (f.registry as unknown as { permissionHost: { workspaceTrust: unknown } }).permissionHost;
  const trust = host.workspaceTrust; host.workspaceTrust = undefined;
  try {
    f.registry.setServerTrustMode('owned-protocol', 'allow-all');
    await expect(f.call()).rejects.toThrow('workspace trust owner');
    await expect(f.spawn('Original owner goal')).rejects.toThrow();
    expect(f.calls).toHaveLength(0); expect(f.human).not.toHaveBeenCalled();
  } finally { host.workspaceTrust = trust; await f.close(); }
});
