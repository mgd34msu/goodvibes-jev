import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretsManager } from '../sdk/src/platform/config/secrets.ts';
import { acquireCrossProcessLock } from '../sdk/src/platform/workspace/checkpoint/cross-process-lock.ts';
const roots: string[] = [];
afterEach(() => { delete process.env.SYNTHETIC_ALIAS; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const root = mkdtempSync(join(tmpdir(), 'local-credential-snapshot-')); roots.push(root);
 return new SecretsManager({ projectRoot: join(root, 'project'), globalHome: join(root, 'home'), surfaceRoot: 'synthetic', configManager: { get: () => 'plaintext_allowed' } as never });
}
const plain = { scope: 'user', medium: 'plaintext' } as const;
test('local managed alias follows exact precedence and changes revision across ABA', async () => {
 const manager = fixture();
 await manager.set('SYNTHETIC_ALIAS', 'goodvibes://secrets/goodvibes/SYNTHETIC_LEAF', plain);
 await manager.set('SYNTHETIC_LEAF', 'one', plain);
 const before = manager.resolveLocalCredentialSnapshot('SYNTHETIC_ALIAS');
 expect(before).toMatchObject({ state: 'resolved', value: 'one' }); expect(await manager.get('SYNTHETIC_ALIAS')).toBe('one');
 await manager.set('SYNTHETIC_LEAF', 'two', plain); await manager.set('SYNTHETIC_LEAF', 'one', plain);
 expect(manager.resolveLocalCredentialSnapshot('SYNTHETIC_ALIAS')).not.toEqual(before);
 await manager.set('SYNTHETIC_LEAF', 'higher', { scope: 'project', medium: 'plaintext' });
 expect(manager.resolveLocalCredentialSnapshot('SYNTHETIC_ALIAS')).toMatchObject({ state: 'resolved', value: 'higher' });
});
test('local aliases refuse pending leaf writes before post-success notification', async () => {
 const manager = fixture(); await manager.set('SYNTHETIC_ALIAS', 'goodvibes://secrets/goodvibes/SYNTHETIC_LEAF', plain); await manager.set('SYNTHETIC_LEAF', 'one', plain);
 const path = (await manager.listDetailed()).find(row => row.key === 'SYNTHETIC_LEAF')!.path!;
 const release = await acquireCrossProcessLock(`${path}.mutation.lock`, { strictOwnership: true });
 const write = manager.set('SYNTHETIC_LEAF', 'two', plain);
 try { expect(manager.resolveLocalCredentialSnapshot('SYNTHETIC_ALIAS').state).toBe('unsupported'); } finally { release(); await write; }
 expect(manager.resolveLocalCredentialSnapshot('SYNTHETIC_ALIAS')).toMatchObject({ state: 'resolved', value: 'two' });
});
test('missing root differs from dangling alias, cycles and unsupported external/env references', async () => {
 const manager = fixture(); expect(manager.resolveLocalCredentialSnapshot('SYNTHETIC_ALIAS').state).toBe('absent');
 for (const value of ['goodvibes://secrets/goodvibes/MISSING', 'goodvibes://secrets/goodvibes/SYNTHETIC_ALIAS', 'goodvibes://secrets/env/HOME']) {
   await manager.set('SYNTHETIC_ALIAS', value, plain); expect(manager.resolveLocalCredentialSnapshot('SYNTHETIC_ALIAS').state).toBe('unsupported');
 }
 process.env.SYNTHETIC_ALIAS = 'synthetic'; expect(manager.resolveLocalCredentialSnapshot('SYNTHETIC_ALIAS').state).toBe('unsupported');
});
