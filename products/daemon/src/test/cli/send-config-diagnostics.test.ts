/** Exercise the real configuration owner before any send stack can be acquired. */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDaemonCliConfiguration } from '../../cli/configuration.js';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../../config/surface.js';
import { makeOwnedTempDir } from '../helpers/owned-temp.js';

const SENTINEL = 'OWNED_SYNTHETIC_CREDENTIAL_7D6EA2';
const BODY = 'Owned private send body 0FF21B';
const MALFORMED = `{"surfaces":{"signal":{"token":${SENTINEL}}}}`;

function fixture() {
  const root = makeOwnedTempDir('daemon-send-config-diagnostics');
  const home = join(root, 'home');
  const work = join(root, 'work');
  const daemon = join(root, 'daemon');
  for (const directory of [home, work, daemon]) mkdirSync(directory, { recursive: true });
  const env = { ...process.env, HOME: home, GOODVIBES_HOME: home, GOODVIBES_DAEMON_HOME: daemon,
    GOODVIBES_WORKING_DIR: work, XDG_CONFIG_HOME: join(root, 'xdg'), NO_COLOR: '1' };
  return { root, home, work, daemon, env };
}

interface ProbeResult {
  readonly code: number;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly logs: Array<[string, string, Record<string, unknown>]>;
  readonly privateErrorPreserved: boolean;
  readonly secretLookups: number;
  readonly serviceResolutions: number;
  readonly transports: number;
}

function probe(mode: 'send' | 'structural' | 'default' | 'config', tier: 'daemon' | 'global' | 'project' | 'shared' = 'daemon') {
  const fx = fixture();
  const path = tier === 'daemon' ? join(fx.daemon, 'settings.json')
    : tier === 'global' ? join(fx.home, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'settings.json')
    : tier === 'project' ? join(fx.work, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT, 'settings.json')
    : join(fx.home, '.goodvibes', 'shared', 'settings.json');
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, MALFORMED);
  const script = join(fx.root, 'probe.ts');
  const imports = {
    run: new URL('../../cli/run.ts', import.meta.url).href,
    configuration: new URL('../../cli/configuration.ts', import.meta.url).href,
    secrets: new URL('../../config/secrets.ts', import.meta.url).href,
    registry: new URL('../../../../../packages/engine/sdk/src/platform/config/service-registry.ts', import.meta.url).href,
    logger: new URL('../../../../../packages/engine/sdk/src/platform/utils/logger.ts', import.meta.url).href,
  };
  writeFileSync(script, `
import { spyOn } from 'bun:test';
import { runDaemonCli } from ${JSON.stringify(imports.run)};
import { createDaemonCliConfiguration } from ${JSON.stringify(imports.configuration)};
import { SecretsManager } from ${JSON.stringify(imports.secrets)};
import { ServiceRegistry } from ${JSON.stringify(imports.registry)};
import { logger } from ${JSON.stringify(imports.logger)};
const records = [];
let secretLookups = 0; let serviceResolutions = 0; let transports = 0;
for (const level of ['debug', 'info', 'warn', 'error']) {
  spyOn(logger, level).mockImplementation((...args) => records.push([level, ...args]));
}
spyOn(SecretsManager.prototype, 'get').mockImplementation(async () => {
  secretLookups++; throw new Error('Unexpected credential lookup in malformed-settings fixture');
});
spyOn(ServiceRegistry.prototype, 'resolveSecret').mockImplementation(async () => {
  serviceResolutions++; throw new Error('Unexpected registry lookup in malformed-settings fixture');
});
spyOn(globalThis, 'fetch').mockImplementation(async () => {
  transports++; throw new Error('Unexpected transport in malformed-settings fixture');
});
const stdout = []; const stderr = []; let code = 1; let privateErrorPreserved = false;
const mode = ${JSON.stringify(mode)};
if (mode === 'send' || mode === 'config') {
  code = await runDaemonCli(mode === 'send'
    ? ['send', '--channel', 'signal', '--to', 'owned-recipient', ${JSON.stringify(BODY)}]
    : ['config', 'get', 'controlPlane.port'], {
      stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
    });
} else {
  let parseMessage = '';
  try { JSON.parse(${JSON.stringify(MALFORMED)}); } catch (error) { parseMessage = error.message; }
  try {
    createDaemonCliConfiguration({}, process.env, process.cwd(),
      mode === 'structural' ? { diagnosticMode: 'structural' } : {});
  } catch (error) {
    privateErrorPreserved = error.message.endsWith(': ' + parseMessage)
      && error.message.includes(${JSON.stringify(SENTINEL)});
  }
}
console.log(JSON.stringify({ code, stdout, stderr, logs: records, privateErrorPreserved,
  secretLookups, serviceResolutions, transports }));
`);
  const child = spawnSync(process.execPath, ['--no-env-file', script], {
    cwd: fx.work, env: fx.env, encoding: 'utf8', timeout: 15_000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  const result = JSON.parse(child.stdout.trim()) as ProbeResult;
  expect(result.secretLookups).toBe(0);
  expect(result.serviceResolutions).toBe(0);
  expect(result.transports).toBe(0);
  expect(readFileSync(path, 'utf8')).toBe(MALFORMED);
  return { ...fx, path, result, rawStdout: child.stdout, rawStderr: child.stderr };
}

describe('standalone send config-load diagnostics', () => {
  for (const tier of ['daemon', 'global', 'project', 'shared'] as const) {
    test(`send withholds malformed ${tier} settings source bytes from logger and real stderr`, () => {
      const fx = probe('send', tier);
      expect(fx.result.code).toBe(1);
      expect(fx.result.stdout).toEqual([]);
      expect(fx.result.stderr).toEqual(['Daemon command failed']);
      expect(fx.rawStdout).not.toContain(SENTINEL);
      expect(fx.rawStderr).not.toContain(SENTINEL);
      expect(fx.rawStdout).not.toContain(BODY);
      expect(fx.rawStderr).not.toContain(BODY);
      expect(fx.rawStderr).toContain('REFUSED (whole file)');
      expect(fx.rawStderr).toContain(fx.path);
      expect(fx.rawStderr).toContain('could not be read as JSON');
      expect(fx.result.logs.find((entry) => entry[1] === 'goodvibes settings: a setting could not be ingested')?.[2])
        .toMatchObject({ file: fx.path, key: '(whole file)', reason: 'could not be read as JSON' });
      if (tier === 'daemon') {
        expect(fx.result.logs.find((entry) => entry[1] === 'daemon-owned config migration failed; continuing with existing config state')?.[2])
          .toEqual({ markerPath: join(fx.daemon, 'config-moved.json'), reason: 'config-migration-failed' });
      }
    });
  }

  test('structural publication preserves the original private ConfigError parse detail', () => {
    const fx = probe('structural');
    expect(fx.result.privateErrorPreserved).toBe(true);
    expect(fx.rawStdout).not.toContain(SENTINEL);
    expect(fx.rawStderr).not.toContain(SENTINEL);
  });

  test('the existing default configuration diagnostics and private error remain unchanged', () => {
    const fx = probe('default');
    expect(fx.result.privateErrorPreserved).toBe(true);
    expect(fx.rawStdout).toContain(SENTINEL);
    expect(fx.rawStderr).toContain(SENTINEL);
    expect(fx.result.logs.find((entry) => entry[0] === 'warn')?.[2].error).toContain(SENTINEL);
  });

  test('the CLI selects structural mode only for send', () => {
    const fx = probe('config');
    expect(fx.result.code).toBe(1);
    expect(fx.rawStdout).toContain(SENTINEL);
    expect(fx.rawStderr).toContain(SENTINEL);
  });

  test('structural mode retains canonical daemon migration and settings precedence', () => {
    const fx = fixture();
    const legacy = join(fx.home, '.goodvibes', GOODVIBES_DAEMON_SURFACE_ROOT);
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, 'settings.json'), JSON.stringify({ controlPlane: { port: 43129 }, surfaces: { signal: { enabled: true, token: SENTINEL } } }));
    writeFileSync(join(fx.daemon, 'settings.json'), JSON.stringify({ controlPlane: { port: 43130 } }));
    const configuration = createDaemonCliConfiguration({ daemonHome: undefined, workingDir: undefined }, fx.env, fx.work, { diagnosticMode: 'structural' });
    expect(configuration.config.get('controlPlane.port')).toBe(43130);
    expect(configuration.config.get('surfaces.signal.enabled')).toBe(true);
    expect(configuration.config.get('surfaces.signal.token')).toBe(SENTINEL);
    expect(existsSync(join(fx.daemon, 'config-moved.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(fx.daemon, 'settings.json'), 'utf8')).surfaces.signal.token).toBe(SENTINEL);
    expect(readFileSync(join(legacy, 'settings.json'), 'utf8')).not.toContain(SENTINEL);
  });
});
