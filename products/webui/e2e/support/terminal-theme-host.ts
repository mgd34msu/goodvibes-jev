/** Real config dispatcher/handler + owned on-disk ConfigManager, without a socket. */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  createDaemonSystemRouteHandlers,
  dispatchOperatorRoutes,
  isJsonRecord,
  type DaemonOperatorRouteHandlers,
  type DaemonSystemRouteContext,
} from '@goodvibes-jev/engine/daemon-sdk';
import { ConfigManager, isValidConfigKey } from '@goodvibes-jev/engine/sdk/platform/config';
import { forgetFailureReadings, installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { makeProjectTempDir } from '../../scripts/helpers/project-temp';

export const TERMINAL_THEME_TOKEN = 'e2e-operator-token';

// The error reader has a process-wide composition port. Serialize fixture
// dispatches across ALL hosts so overlapping requests cannot restore another
// request's synthetic port or remove it before a rejection is formatted.
let dispatchQueue: Promise<void> = Promise.resolve();
function serializeDispatch<T>(run: () => Promise<T>): Promise<T> {
  const result = dispatchQueue.then(run);
  dispatchQueue = result.then(() => undefined, () => undefined);
  return result;
}


export function createTerminalThemeHost(savedTheme?: string) {
  const root = makeProjectTempDir('webui-terminal-theme-');
  const configDir = join(root, 'host');
  const daemonTierPath = join(root, 'daemon', 'settings.json');
  const settingsPath = join(configDir, 'settings.json');
  if (savedTheme !== undefined) {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ display: { theme: savedTheme, themeMode: 'light' } }));
  }
  const options = { configDir, daemonTierPath };
  let manager = new ConfigManager(options);
  let allowWrites = true;
  const requests: { method: string; body?: unknown; status: number }[] = [];
  // Config validation stays real. Only the daemon's error-wording reading is
  // synthetic, so a rejected enum write never reaches a live judgment service.
  const failure = fakePort((name, question) => {
    if (name === 'category') return choiceAnswer(question, 'bad_request', 0.99);
    if (name === 'connection_failure') return choiceAnswer(question, 'none', 0.99);
    if (['billing', 'rate_limited', 'context_exceeded', 'transient_network', 'provider_unusable', 'before_response'].includes(name)) return noulAnswer(0.01);
    throw new Error(`Unexpected terminal-theme failure question: ${name}`);
  });

  // Only /config is admitted below. Fail closed if the fixture accidentally
  // starts depending on another host service rather than inventing its result.
  const context = new Proxy({
    configManager: {
      get: (key: string) => {
        if (!isValidConfigKey(key)) throw new Error(`Unknown config key: ${key}`);
        return manager.get(key);
      },
      getAll: () => manager.getAll(),
      setDynamic: (key: string, value: unknown) => {
        if (!isValidConfigKey(key)) throw new Error(`Unknown config key: ${key}`);
        manager.setDynamic(key, value);
      },
      getConfigPath: () => manager.getConfigPath(),
      describeConfigKeySource: (key: string) => {
        if (!isValidConfigKey(key)) throw new Error(`Unknown config key: ${key}`);
        return manager.describeConfigKeySource(key);
      },
    },
    isValidConfigKey,
    requireAdmin: (request: Request) => request.headers.get('authorization') === `Bearer ${TERMINAL_THEME_TOKEN}`
      && (request.method === 'GET' || allowWrites)
      ? null : Response.json({ error: 'Admin role required' }, { status: 403 }),
    parseJsonBody: async (request: Request) => {
      try {
        const value: unknown = await request.json();
        return isJsonRecord(value) ? value : Response.json({ error: 'Expected JSON object' }, { status: 400 });
      } catch {
        return Response.json({ error: 'Invalid JSON' }, { status: 400 });
      }
    },
  }, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      throw new Error(`Unexpected terminal-theme fixture service: ${String(key)}`);
    },
  }) as unknown as DaemonSystemRouteContext;
  const handlers = createDaemonSystemRouteHandlers(context);

  return {
    root, settingsPath, daemonTierPath, requests,
    get manager() { return manager; },
    setWriteAccess(allowed: boolean) { allowWrites = allowed; },
    reload() { manager = new ConfigManager(options); },
    persisted(): unknown { return existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) as unknown : null; },
    siblingTheme() {
      return new ConfigManager({ configDir: join(root, 'sibling'), daemonTierPath }).get('display.theme');
    },
    replaceSavedTheme(theme: string) {
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, JSON.stringify({ display: { theme, themeMode: manager.get('display.themeMode') } }));
      manager = new ConfigManager(options);
    },
    async dispatch(request: Request): Promise<Response> {
      if (new URL(request.url).pathname !== '/config' || !['GET', 'POST'].includes(request.method)) {
        throw new Error(`Unexpected terminal-theme fixture route: ${request.method} ${request.url}`);
      }
      const body: unknown = request.method === 'POST' ? await request.clone().json().catch(() => null) : undefined;
      return serializeDispatch(async () => {
        forgetFailureReadings();
        const previous = installJudgmentPort(failure.port);
        try {
          const response = await dispatchOperatorRoutes(request, handlers as DaemonOperatorRouteHandlers);
          if (!response) throw new Error('Production dispatcher did not handle /config');
          requests.push({ method: request.method, ...(body === undefined ? {} : { body }), status: response.status });
          return response;
        } finally {
          installJudgmentPort(previous);
          forgetFailureReadings();
        }
      });
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

export type TerminalThemeHost = ReturnType<typeof createTerminalThemeHost>;

export function themeConfigRequest(method: 'GET' | 'POST', body?: unknown): Request {
  return new Request('http://terminal-theme-fixture/config', {
    method,
    headers: { authorization: `Bearer ${TERMINAL_THEME_TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
