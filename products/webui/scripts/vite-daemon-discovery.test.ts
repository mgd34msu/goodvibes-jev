import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installTestCleanup, makeProjectTempDir } from './helpers/project-temp';

installTestCleanup(afterAll);
const configPath = fileURLToPath(new URL('../vite.config.ts', import.meta.url));
const daemonEntry = fileURLToPath(new URL('../../daemon/src/cli/entrypoint.ts', import.meta.url));
const result = { schema: 'goodvibes.daemon.webui-binding', schemaVersion: 1, source: 'configuration', endpoint: 'web' };
const query = { args: ['status', '--json'], result };
const catalog = JSON.stringify({ schema: 'goodvibes.daemon.cli-catalog', schemaVersion: 1,
  commands: [{ name: 'webui', subcommands: ['status'], machineQueries: [query] }] });
const binding = JSON.stringify({ ...result, host: '127.0.0.2', port: 44323 });
const fallback = JSON.stringify({ host: '127.0.0.3', port: 45323 });
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

function fixture(options: {
  help?: string;
  status?: string;
  cli?: string;
  realDaemon?: boolean;
  hang?: 'help' | 'status' | 'terminal';
  helpExitCode?: number;
  statusExitCode?: number;
} = {}) {
  // Reuse the dev-tool fixture prefix so the existing stale-root sweep owns it.
  const root = makeProjectTempDir('webui-sdk-dev-');
  const bin = join(root, 'bin'); const home = join(root, 'home'); const daemon = join(root, 'daemon');
  mkdirSync(bin); mkdirSync(home);
  const calls = join(root, 'calls'); const unsafe = join(root, 'unsafe-start');
  const daemonBody = options.realDaemon
    ? `exec ${quote(process.execPath)} ${quote(daemonEntry)} "$@"`
    : `if [ "$1" = "--help" ]; then
  ${options.hang === 'help' ? "trap '' TERM; while :; do :; done" : `printf '%s\\n' ${quote(options.help ?? catalog)}; exit ${options.helpExitCode ?? 0}`}
fi
if [ "$*" = "webui status --json" ]; then
  ${options.hang === 'status' ? "trap '' TERM; while :; do :; done" : `printf '%s\\n' ${quote(options.status ?? binding)}; exit ${options.statusExitCode ?? 0}`}
fi
printf 'unrecognized command would start daemon' > ${quote(unsafe)}
exit 94`;
  writeFileSync(join(bin, 'goodvibes-daemon'), `#!/bin/sh\nprintf 'daemon %s\\n' "$*" >> ${quote(calls)}\n${daemonBody}\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'goodvibes'), `#!/bin/sh\nprintf 'terminal %s\\n' "$*" >> ${quote(calls)}\n${options.hang === 'terminal'
    ? "trap '' TERM; while :; do :; done" : `printf '%s\\n' ${quote(options.cli ?? fallback)}`}\n`, { mode: 0o755 });
  const settings = join(root, 'tui-settings.json');
  writeFileSync(settings, JSON.stringify({ web: { host: '127.0.0.4', port: 46323 } }));
  function run(command: 'serve' | 'build' = 'serve', isPreview = false, discovery = '1') {
    const runner = join(root, 'run-config.ts');
    writeFileSync(runner, `import config from ${JSON.stringify(configPath)};\nconst result = typeof config === 'function' ? await config({ command: ${JSON.stringify(command)}, mode: 'development', isPreview: ${String(isPreview)} }) : config;\nconsole.log(JSON.stringify(result.server));\n`);
    const child = spawnSync(process.execPath, [runner], { cwd: root, encoding: 'utf8', timeout: 10_000, killSignal: 'SIGKILL',
      env: { PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`, HOME: home, GOODVIBES_HOME: home, GOODVIBES_DAEMON_HOME: daemon,
        GOODVIBES_WORKING_DIR: root, GOODVIBES_TUI_SETTINGS_PATH: settings, GOODVIBES_WEBUI_BINDING_DISCOVERY: discovery,
        // Keep the runtime's transpiler cache outside the settings-home proof.
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(root, 'bun-transpiler-cache') } });
    expect(child.error).toBeUndefined(); expect(child.status, child.stderr).toBe(0);
    return { server: JSON.parse(child.stdout) as { host: string; port: number }, stderr: child.stderr };
  }
  return { root, home, daemon, unsafe, run,
    calls: () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n') : [] };
}

describe('the actual Vite config caller discovers safely', () => {
  test('machine proof gates the status subprocess and overrides terminal fallback', () => {
    const f = fixture(); const output = f.run();
    expect(output.server).toMatchObject({ host: '127.0.0.2', port: 44323 });
    expect(output.stderr).toBe('');
    expect(f.calls()).toEqual(['daemon --help --json', 'daemon webui status --json']);
    expect(existsSync(f.unsafe)).toBe(false);
  });

  test.each([
    'This legacy daemon serves webui assets, but has no webui command.',
    'Commands:\n  webui    See the separate webui product.\nVersion 99.99.99',
    JSON.stringify({ schema: 'goodvibes.daemon.cli-catalog', schemaVersion: 1,
      commands: [{ name: 'webui', subcommands: ['status'], machineQueries: [] }] }),
  ])('legacy or unsupported output never invokes webui: %s', (help) => {
    const f = fixture({ help }); const output = f.run();
    expect(output.server).toMatchObject({ host: '127.0.0.3', port: 45323 });
    expect(output.stderr).toContain('falling back');
    expect(f.calls()).toEqual(['daemon --help --json', 'terminal web --json']);
    expect(existsSync(f.unsafe)).toBe(false);
  });

  test('malformed status falls back, then absent terminal output reaches settings', () => {
    const f = fixture({ status: '{}', cli: 'not JSON' });
    expect(f.run().server).toMatchObject({ host: '127.0.0.4', port: 46323 });
    expect(f.calls()).toEqual(['daemon --help --json', 'daemon webui status --json', 'terminal web --json']);
  });

  test.each(['null', '[]', '{"host":false,"port":3423}', '{"host":"localhost","port":0}', '{"port":"3423"}'])(
    'malformed terminal JSON reaches settings safely: %s', (cli) => {
      const f = fixture({ help: 'legacy help', cli });
      expect(f.run().server).toMatchObject({ host: '127.0.0.4', port: 46323 });
      expect(f.calls()).toEqual(['daemon --help --json', 'terminal web --json']);
    },
  );

  test.each([
    { helpExitCode: 1 }, { help: `${catalog}${' '.repeat(70_000)}` },
  ])('failed or oversized help never authorizes a status invocation', (options) => {
    const f = fixture(options);
    expect(f.run().server).toMatchObject({ host: '127.0.0.3', port: 45323 });
    expect(f.calls()).toEqual(['daemon --help --json', 'terminal web --json']);
  });

  test.each([
    { statusExitCode: 1 }, { status: `${binding}${' '.repeat(70_000)}` },
  ])('failed or oversized status retains the terminal fallback', (options) => {
    const f = fixture(options);
    expect(f.run().server).toMatchObject({ host: '127.0.0.3', port: 45323 });
    expect(f.calls()).toEqual(['daemon --help --json', 'daemon webui status --json', 'terminal web --json']);
  });

  test('a stuck legacy help process is killed before safe fallback', () => {
    const f = fixture({ hang: 'help' }); const started = performance.now();
    expect(f.run().server).toMatchObject({ host: '127.0.0.3', port: 45323 });
    expect(performance.now() - started).toBeLessThan(8_000);
    expect(f.calls()).toEqual(['daemon --help --json', 'terminal web --json']);
  });

  test('a stuck status process is killed before the terminal fallback', () => {
    const f = fixture({ hang: 'status' }); const started = performance.now();
    expect(f.run().server).toMatchObject({ host: '127.0.0.3', port: 45323 });
    expect(performance.now() - started).toBeLessThan(8_000);
    expect(f.calls()).toEqual(['daemon --help --json', 'daemon webui status --json', 'terminal web --json']);
  });

  test('a stuck terminal fallback is killed before reading settings', () => {
    const f = fixture({ help: 'legacy help', hang: 'terminal' }); const started = performance.now();
    expect(f.run().server).toMatchObject({ host: '127.0.0.4', port: 46323 });
    expect(performance.now() - started).toBeLessThan(8_000);
    expect(f.calls()).toEqual(['daemon --help --json', 'terminal web --json']);
  });

  test.each([
    ['build', false, '1'], ['serve', true, '1'], ['serve', false, '0'],
  ] as const)('%s preview=%s discovery=%s performs no subprocess discovery', (command, preview, discovery) => {
    const f = fixture(); f.run(command, preview, discovery); expect(f.calls()).toEqual([]);
  });

  test('Vite reaches the real daemon CLI machine producer without initializing a home', () => {
    const f = fixture({ realDaemon: true }); const output = f.run();
    expect(output.server).toMatchObject({ host: '127.0.0.1', port: 3423 });
    expect(output.stderr).toBe('');
    expect(f.calls()).toEqual(['daemon --help --json', 'daemon webui status --json']);
    expect(readdirSync(f.home)).toEqual([]); expect(existsSync(f.daemon)).toBe(false);
  });

  test('real daemon-owned web config is used without claiming the control-plane port', () => {
    const f = fixture({ realDaemon: true }); mkdirSync(f.daemon);
    const path = join(f.daemon, 'settings.json');
    const original = JSON.stringify({ web: { enabled: true, hostMode: 'local', port: 47323 },
      controlPlane: { hostMode: 'local', port: 47321 } });
    writeFileSync(path, original);
    const output = f.run();
    expect(output.server).toMatchObject({ host: '127.0.0.1', port: 47323 });
    expect(output.stderr).toBe(''); expect(readFileSync(path, 'utf8')).toBe(original);
    expect(readdirSync(f.daemon)).toEqual(['settings.json']); expect(readdirSync(f.home)).toEqual([]);
  });
});
