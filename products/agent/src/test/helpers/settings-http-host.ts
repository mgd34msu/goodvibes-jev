/** Owned child lifecycle follows the native-integration host fixture convention. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

async function within<T>(promise: Promise<T>, label: string, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting for settings fixture ${label}`)), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

export function launchSettingsHttpHost(root: string, mode: 'normal' | 'lost-response') {
  const script = resolve(import.meta.dir, '../../../../../packages/engine/test/helpers/settings-http-owner-child.ts');
  const child = Bun.spawn([process.execPath, '--no-env-file', script, root, mode], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const output = child.stdout.getReader(); const decoder = new TextDecoder(); let buffered = '';
  // Drain rather than retain diagnostics: the private ready pipe alone carries the synthetic bearer.
  const drained = (async () => { const reader = child.stderr.getReader(); try { while (!(await reader.read()).done) {} }
    finally { reader.releaseLock(); } })().catch(() => {});
  const event = (kind: string, expectedId?: number) => within(Promise.race([(async (): Promise<Record<string, unknown>> => {
    while (true) {
      const end = buffered.indexOf('\n');
      if (end >= 0) {
        const line = buffered.slice(0, end); buffered = buffered.slice(end + 1);
        let value: unknown;
        try { value = JSON.parse(line); } catch { throw new Error('Invalid settings fixture reply'); }
        if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== kind
          || (expectedId !== undefined && (!('id' in value) || value.id !== expectedId))) throw new Error('Unexpected settings fixture reply');
        return value as Record<string, unknown>;
      }
      const next = await output.read();
      if (next.done) throw new Error('Settings fixture exited before reply');
      buffered += decoder.decode(next.value, { stream: true });
      if (buffered.length > 8192) throw new Error('Oversized settings fixture reply');
    }
  })(), child.exited.then(() => { throw new Error('Settings fixture exited before reply'); })]), kind, 30_000);
  let sequence = 0;
  const send = async (message: object) => { const id = ++sequence; child.stdin.write(`${JSON.stringify({ ...message, id })}\n`); await child.stdin.flush(); return id; };
  return {
    async ready() {
      const ready = await event('ready');
      if (Object.keys(ready).sort().join(',') !== 'baseUrl,defaultPort,kind,pid,settingsPath,token'
        || typeof ready.baseUrl !== 'string' || typeof ready.token !== 'string' || ready.token.length > 200 || !ready.token
        || typeof ready.settingsPath !== 'string' || ready.settingsPath !== join(root, 'remote-settings.json') || typeof ready.defaultPort !== 'number'
        || !Number.isInteger(ready.defaultPort) || typeof ready.pid !== 'number' || ready.pid !== child.pid) throw new Error('Invalid settings fixture ready event');
      const url = new URL(ready.baseUrl);
      if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash) throw new Error('Invalid settings fixture endpoint');
      const path = ready.settingsPath; const defaultPort = ready.defaultPort;
      return { baseUrl: ready.baseUrl, token: ready.token, pid: ready.pid,
        config: {
          get(key: string): unknown {
            let value: unknown = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
            for (const segment of key.split('.')) value = value && typeof value === 'object' ? (value as Record<string, unknown>)[segment] : undefined;
            return value === undefined ? key === 'controlPlane.port' ? defaultPort : '' : value;
          },
          async set(key: string, value: unknown) { const id = await within(send({ type: 'set', key, value }), 'set request', 2_000); await event('configured', id); },
          getSchema: () => [{ key: 'controlPlane.port', default: defaultPort }],
          getDaemonTierPath: () => path,
        },
        async revoke() { const id = await within(send({ type: 'revoke' }), 'revoke request', 2_000); await event('revoked', id); },
        async counts() {
          const id = await within(send({ type: 'inspect' }), 'inspect request', 2_000); const value = await event('inspection', id);
          if (Object.keys(value).sort().join(',') !== 'applies,captures,id,kind'
            || ![value.captures, value.applies].every(count => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 100)) throw new Error('Invalid settings fixture counts');
          return { captures: value.captures, applies: value.applies };
        },
      };
    },
    async stop() {
      try {
        if (child.exitCode === null) {
          try { await within(send({ type: 'stop' }), 'stop request', 2_000); child.stdin.end(); await within(child.exited, 'shutdown', 10_000); }
          catch { child.kill('SIGTERM'); try { await within(child.exited, 'termination', 2_000); }
            catch { child.kill('SIGKILL'); await within(child.exited, 'reap', 2_000); } }
        }
        if (await within(child.exited, 'exit', 2_000) !== 0) throw new Error('Settings fixture exited unsuccessfully');
      } finally { await within(output.cancel().catch(() => {}), 'stdout cleanup', 2_000); await within(drained, 'stderr cleanup', 2_000); }
    },
  };
}
