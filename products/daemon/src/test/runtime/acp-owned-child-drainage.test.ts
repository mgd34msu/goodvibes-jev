/** Actual ACP peers and product shutdown; no synthetic child-exit promises. */
import { expect, spyOn, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { externalProtocolFixture, until } from '../helpers/external-protocol-fixture.js';

async function peer(mode: 'normal' | 'reject-handshake' | 'hang-handshake' = 'normal') {
  const f = await externalProtocolFixture();
  await f.spawn(); // Reach the actual product-owned ACP host.
  const wrapper = join(f.daemon.workingDirectory, `ignore-term-${mode}.ts`);
  const fake = resolve(import.meta.dir, '../../../../../packages/engine/test/fixtures/fake-acp-agent.ts');
  writeFileSync(wrapper, mode === 'normal'
    ? `process.on('SIGTERM',()=>{}); await import(${JSON.stringify(fake)});`
    : `process.on('SIGTERM',()=>{}); const {createInterface}=await import('node:readline');
for await(const line of createInterface({input:process.stdin})) { const request=JSON.parse(line);
${mode === 'reject-handshake' ? "if(request.id!==undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32603,message:'Synthetic ACP handshake refusal'}})+'\\n');" : ''} }`);
  const spawns = spyOn(Bun, 'spawn');
  const starting = f.acp.spawnAgent({ agent: { id: `owned-exit-${mode}`, title: 'Owned local ACP peer', binaryPath: process.execPath, args: [wrapper, 'permission-reject-first'] }, cwd: f.daemon.workingDirectory });
  let index = -1;
  await until(() => { index = spawns.mock.calls.findIndex(([input]) => Array.isArray(input) && input.includes(wrapper)); return index >= 0; }, 'owned local ACP peer must spawn');
  const child = spawns.mock.results[index]!.value as ReturnType<typeof Bun.spawn>;
  const forceKill = child.kill.bind(child);
  const kills = spyOn(child, 'kill');
  let exited = false; void child.exited.then(() => { exited = true; });
  return { f, child, kills, starting, exited: () => exited,
    async close() {
      try { forceKill('SIGKILL'); } catch { /* Already exited. */ }
      await child.exited;
      await starting;
      kills.mockRestore(); spawns.mockRestore();
      await f.close();
    },
  };
}

test('concurrent ACP stops await one real child drain and cannot dismiss it early', async () => {
  const p = await peer();
  try {
    const hosted = await p.starting; expect(hosted.state).toBe('idle');
    const first = p.f.acp.stop(hosted.id), second = p.f.acp.stop(hosted.id);
    expect(p.f.acp.get(hosted.id)?.state).toBe('stopped');
    expect(p.f.acp.prompt(hosted.id, 'Cannot restart a stopped turn').queued).toBe(false);
    expect(p.f.acp.dismiss(hosted.id)).toBe(false);
    expect(await Promise.all([first, second])).toEqual([true, false]);
    expect(p.exited()).toBe(true);
    expect(p.kills.mock.calls.map(([signal]) => signal)).toEqual(['SIGTERM', 'SIGKILL']);
    expect(p.f.acp.dismiss(hosted.id)).toBe(true);
  } finally { await p.close(); }
});

test('failed ACP handshake returns only after the real ignored-SIGTERM child is drained', async () => {
  const p = await peer('reject-handshake');
  try {
    const hosted = await p.starting; expect(hosted.state).toBe('failed');
    expect(p.exited()).toBe(true);
    expect(await p.f.acp.stop(hosted.id)).toBe(false);
    expect(p.f.acp.dismiss(hosted.id)).toBe(true);
  } finally { await p.close(); }
});

test('stop during ACP negotiation drains the same child before both calls settle', async () => {
  const p = await peer('hang-handshake');
  try {
    const row = p.f.acp.list().find(record => record.agentId === 'owned-exit-hang-handshake')!;
    expect(row.state).toBe('starting');
    await p.f.acp.stop(row.id);
    expect((await p.starting).state).toBe('stopped');
    expect(p.exited()).toBe(true);
  } finally { await p.close(); }
});

test('outer daemon close awaits actual ACP forced child exit', async () => {
  const p = await peer();
  try {
    const hosted = await p.starting;
    const closing = p.f.daemon.services.close();
    expect(p.f.acp.prompt(hosted.id, 'No new work during shutdown').queued).toBe(false);
    await closing;
    expect(p.exited()).toBe(true);
  } finally { await p.close(); }
});
