import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeOwnedTempDir } from './owned-temp.js';

export function companionCliFixture() {
  const root = makeOwnedTempDir('daemon-cli-companion');
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  const daemonHome = join(cwd, 'selected-daemon');
  const envDaemonHome = join(root, 'env-daemon');
  const defaultDaemonHome = join(home, '.goodvibes', 'daemon');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });

  function launch(args: string[], options: { composed?: boolean; pairingOutput?: boolean; env?: NodeJS.ProcessEnv } = {}) {
    const env: NodeJS.ProcessEnv = {
      ...process.env, HOME: home, GOODVIBES_HOME: home,
      GOODVIBES_DAEMON_HOME: envDaemonHome, GOODVIBES_WORKING_DIR: cwd,
      XDG_CONFIG_HOME: join(root, 'xdg'), NO_COLOR: '1',
    };
    // Tests must prove bootstrap without an inherited server or HTTP credential.
    delete env.GOODVIBES_DAEMON_TOKEN;
    delete env.GOODVIBES_HTTP_TOKEN;
    Object.assign(env, options.env);
    // Test launcher selection only; the production CLI has no reveal flag/env.
    env.GOODVIBES_TEST_PAIRING_OUTPUT = options.pairingOutput ? '1' : '0';
    const entry = options.composed
      ? new URL('./daemon-cli-child.ts', import.meta.url)
      : new URL('../../../dist/cli/entrypoint.js', import.meta.url);
    const child = spawn(process.execPath, [fileURLToPath(entry), ...args], {
      cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = ''; let exited = false;
    const changes = new EventEmitter();
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); changes.emit('change'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    const done = new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => { exited = true; changes.emit('change'); resolve(code); });
    });
    // Keep rejection owned even while a caller is waiting for the readiness line.
    void done.catch(() => {});
    async function waitFor(text: string) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup(); reject(new Error(`CLI did not report ${text}: ${stdout}\n${stderr}`));
        }, 15_000);
        function cleanup() { clearTimeout(timer); changes.off('change', check); }
        function check() {
          if (stdout.includes(text)) { cleanup(); resolve(); }
          else if (exited) { cleanup(); reject(new Error(`CLI exited before ${text}: ${stdout}\n${stderr}`)); }
        }
        changes.on('change', check); check();
      });
    }
    async function waitForExit() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([done, new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`CLI did not exit: ${stdout}\n${stderr}`)), 15_000);
        })]);
      } finally { clearTimeout(timer); }
    }
    return {
      child, waitFor, waitForExit, output: () => ({ stdout, stderr }),
      async stop() { if (!exited) child.kill('SIGTERM'); return await waitForExit(); },
      async close() { if (!exited) child.kill('SIGKILL'); await done; },
    };
  }

  async function oneShot(args: string[], env?: NodeJS.ProcessEnv) {
    const process = launch(args, { env });
    try { return { code: await process.waitForExit(), ...process.output() }; }
    finally { await process.close(); }
  }

  return { root, home, cwd, daemonHome, envDaemonHome, defaultDaemonHome, launch, oneShot };
}

/** Bind ephemeral leases together so the optional listener receives a distinct port. */
export async function availableLoopbackPorts(count: number): Promise<number[]> {
  const leases: Bun.Server<undefined>[] = [];
  try {
    for (let index = 0; index < count; index++) {
      leases.push(Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('lease') }));
    }
    return leases.map((lease) => lease.port!);
  } finally { await Promise.all(leases.map((lease) => lease.stop(true))); }
}
