import { expect, test } from 'bun:test';
import { isolatedEnv, type E2EHome } from '../e2e/harness.ts';

test('isolated compiled TUI opts out through the supported wake-download policy', () => {
  const home: E2EHome = {
    root: '/fixture', home: '/fixture/home', workspace: '/fixture/workspace', daemonPort: 45678,
    setDaemonPort: () => { throw new Error('environment generation does not write settings'); },
    setTuiSetting: () => { throw new Error('environment generation does not write settings'); },
  };
  const env = isolatedEnv(home);
  expect(env.GOODVIBES_SKIP_WAKE_MODEL_DOWNLOAD).toBe('1');
  expect(env.HOME).toBe('/fixture/home');
  expect(env.GOODVIBES_HOME).toBe('/fixture/home');
  expect(env).not.toHaveProperty('TYPESAFE_API_KEY');
  expect(env).not.toHaveProperty('NODE_ENV');
});
