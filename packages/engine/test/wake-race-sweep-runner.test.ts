import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'wake-sweep-runner-'));
  roots.push(root);
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, '.env'), 'SWEEP_DOTENV_MARKER=must-not-load\n');
  return root;
}

function suite(root: string, name: string, body: string): void {
  // These are runner fixtures, not IMAP suites. Compose their discovery marker
  // so the real sweep does not discover this test of the sweep itself.
  const marker = ['fake', 'imap', 'mailbox'].join('-');
  writeFileSync(join(root, 'test', `${name}.test.ts`), `
    // ${marker}: authored sweep fixture
    import { test, expect } from 'bun:test';
    import { writeFileSync, mkdtempSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    test(${JSON.stringify(name)}, async () => { ${body} });
  `);
}

function recordPaths(root: string, name: string): string {
  return `writeFileSync(${JSON.stringify(join(root, name))}, JSON.stringify({
    temp: tmpdir(), home: process.env.HOME, pid: process.pid,
    leaked: mkdtempSync(join(tmpdir(), 'deliberately-unremoved-')),
  }));`;
}

async function run(root: string): Promise<{ code: number; output: string }> {
  const script = join(root, 'runner.ts');
  const sweep = new URL('../scripts/sweep-wake-race.ts', import.meta.url).href;
  writeFileSync(script, `
    import { runWakeRaceSweep } from ${JSON.stringify(sweep)};
    process.exitCode = await runWakeRaceSweep(${JSON.stringify(root)}, 17);
  `);
  const child = Bun.spawn(['bun', '--no-env-file', script], {
    cwd: root,
    env: {
      ...process.env,
      OPENAI_API_KEY: 'authored-inherited-fixture-value',
      GOODVIBES_WAKE_RACE_PROBE_MS: '999',
      GOODVIBES_TEST_STALL_MS: '3000',
      GOODVIBES_TEST_CEILING_MS: '6000',
    },
    stdout: 'pipe', stderr: 'pipe',
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const ceiling = setTimeout(() => { child.kill('SIGTERM'); }, 10_000);
  try {
    const code = await child.exited;
    return { code, output: `${await stdout}${await stderr}` };
  } finally {
    clearTimeout(ceiling);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    await child.exited;
  }
}

function expectCleaned(root: string, name: string): void {
  const paths = JSON.parse(readFileSync(join(root, name), 'utf8')) as {
    temp: string; home: string; leaked: string; pid: number;
  };
  expect(paths.temp).toContain('goodvibes-sdk-testrun-');
  expect(paths.home).not.toBe(process.env.HOME);
  expect(existsSync(paths.temp)).toBe(false);
  expect(existsSync(paths.home)).toBe(false);
  expect(existsSync(paths.leaked)).toBe(false);
  expect(() => process.kill(paths.pid, 0)).toThrow();
}

test('sweep preserves explicit perturbation, isolates children, and cleans a green run', async () => {
  const root = makeFixture();
  suite(root, 'a-pass', `
    expect(process.env.GOODVIBES_WAKE_RACE_PROBE_MS).toBe('17');
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(process.env.SWEEP_DOTENV_MARKER).toBeUndefined();
    expect(process.env.GOODVIBES_SDK_TEST_RUNNER).toBe('1');
    ${recordPaths(root, 'pass-paths')}
  `);
  const result = await run(root);
  expect(result.code, result.output).toBe(0);
  expect(result.output).toContain('every suite survives a 17 ms window');
  expectCleaned(root, 'pass-paths');
}, 15_000);

test('sweep keeps complete failure evidence, remains red, and finishes other ordinary suites', async () => {
  const root = makeFixture();
  suite(root, 'a-failure', `
    ${recordPaths(root, 'fail-paths')}
    console.log('fixture stdout context: the first IDLE was never reached');
    console.error('fixture stderr context: setup failed before perturbation');
    throw new Error('intentional setup failure, not a diagnosed lost wake');
  `);
  suite(root, 'b-after', recordPaths(root, 'after-paths'));
  const result = await run(root);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('fixture stdout context: the first IDLE was never reached');
  expect(result.output).toContain('fixture stderr context: setup failed before perturbation');
  expect(result.output).toContain('intentional setup failure, not a diagnosed lost wake');
  expect(result.output).toContain('a-failure.test.ts:');
  expect(result.output).toContain('1 suite(s) failed under the 17 ms probe');
  expect(result.output).not.toContain('carry the lost-wake race');
  expectCleaned(root, 'fail-paths');
  expectCleaned(root, 'after-paths');
}, 15_000);

test('sweep treats even a swallowed external request as a failure', async () => {
  const root = makeFixture();
  suite(root, 'blocked', `
    ${recordPaths(root, 'blocked-paths')}
    await fetch('https://outside.invalid/private-path?token=fixture').catch(() => undefined);
  `);
  const result = await run(root);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('unexpected external test I/O was blocked');
  expect(result.output).toContain('https://outside.invalid');
  expect(result.output).not.toContain('private-path');
  expectCleaned(root, 'blocked-paths');
}, 15_000);

test('a suite that cannot load remains a failure with its import diagnostic', async () => {
  const root = makeFixture();
  suite(root, 'cannot-load', '');
  const path = join(root, 'test/cannot-load.test.ts');
  writeFileSync(path, `${readFileSync(path, 'utf8')}\nimport './missing-authored-sweep-fixture.ts';\n`);
  const result = await run(root);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('missing-authored-sweep-fixture.ts');
  expect(result.output).toContain('FAIL  test/cannot-load.test.ts: exited with code 1');
  expect(result.output).not.toContain('every suite survives');
}, 15_000);

test('cancellation reaps the child and prevents the next suite even if it exits successfully', async () => {
  const root = makeFixture();
  suite(root, 'a-cancel', `
    ${recordPaths(root, 'cancel-paths')}
    process.on('SIGTERM', () => process.exit(0));
    process.kill(process.ppid, 'SIGTERM');
    await new Promise(() => {});
  `);
  suite(root, 'b-must-not-start', recordPaths(root, 'unexpected-paths'));
  const result = await run(root);
  expect(result.code, result.output).toBe(1);
  expect(result.output).toContain('interrupted by SIGTERM');
  expect(existsSync(join(root, 'unexpected-paths'))).toBe(false);
  expectCleaned(root, 'cancel-paths');
}, 15_000);
