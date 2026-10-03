// Derived unchanged from main b6cd286 engine test support; product-local fixture, no production behavior.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const RUNNER_ENV_FLAG = 'GOODVIBES_SDK_TEST_RUNNER';

export const NETWORK_VIOLATIONS_ENV = 'GOODVIBES_TEST_NETWORK_VIOLATIONS';

// Inherit execution/display/test controls, never the user's provider keys,
// subscriptions, proxies, preload hooks or application configuration paths.
const INHERITED = new Set([
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC',
  'SHELL', 'TERM', 'COLORTERM', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'CI', 'GITHUB_ACTIONS', 'NO_COLOR', 'FORCE_COLOR', 'TMPDIR', 'TMP', 'TEMP',
  RUNNER_ENV_FLAG,
  'GOODVIBES_SDK_DEV_ROUNDTRIP_TEST',
]);

/** Isolate persisted user state while allowing tests to declare fixture env explicitly. */
export function isolatedTestEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  root: string,
  fixtureEnv: Readonly<Record<string, string | undefined>> = {},
): Record<string, string | undefined> {
  const env = Object.fromEntries(Object.entries(inherited).filter(([name]) =>
    INHERITED.has(name) || /^GOODVIBES_(?:TEST|LEAK)_/.test(name) || /^BUN_TEST_/.test(name)));
  const homes = {
    HOME: join(root, 'home'),
    USERPROFILE: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
  };
  for (const directory of new Set(Object.values(homes))) mkdirSync(directory, { recursive: true });
  return { ...env, NODE_ENV: 'test', ...fixtureEnv, ...homes };
}
