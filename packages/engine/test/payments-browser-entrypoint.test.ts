import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'bun:test';
import { withTestTimeout } from './_helpers/test-timeout.ts';
import * as browserPolicy from '../sdk/src/platform/payments/browser.js';

const ENGINE_ROOT = resolve(import.meta.dir, '..');
const PUBLIC_ENTRY = '@goodvibes-jev/engine/sdk/platform/payments/browser';
const BUNDLE_CEILING_MS = 30_000;

/** Bundle an installed-package consumer without aliases, externals or host shims. */
async function bundleConsumer(source: boolean): Promise<typeof browserPolicy> {
  const dir = mkdtempSync(join(tmpdir(), 'gv-payments-browser-'));
  try {
    const scope = join(dir, 'node_modules', '@goodvibes-jev');
    mkdirSync(scope, { recursive: true });
    symlinkSync(ENGINE_ROOT, join(scope, 'engine'), 'dir');
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}\n');
    const entry = join(dir, 'consumer.ts');
    writeFileSync(entry, `import * as paymentPolicy from '${PUBLIC_ENTRY}';\nglobalThis.paymentPolicy = paymentPolicy;\n`);
    const output = join(dir, 'consumer.js');
    const child = Bun.spawn([
      process.execPath, 'build', entry, '--target=browser', '--format=iife',
      `--outfile=${output}`, ...(source ? ['--conditions=bun'] : []),
    ], { cwd: dir, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const stdout = new Response(child.stdout).text().catch(() => '');
    const stderr = new Response(child.stderr).text().catch(() => '');
    try {
      const code = await withTestTimeout(child.exited, BUNDLE_CEILING_MS, 'payment browser bundle timed out');
      const diagnostics = `${await stdout}\n${await stderr}`;
      expect(code, diagnostics).toBe(0);
      // A plain JavaScript realm supplies no process, Bun, require, fetch, or
      // storage APIs. The complete bundle must load and run its real exports.
      return runInNewContext(`${readFileSync(output, 'utf8')}\npaymentPolicy;`, Object.create(null), {
        timeout: 5_000,
      }) as typeof browserPolicy;
    } finally {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      await child.exited.catch(() => undefined);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const source of [true, false]) {
  describe(`payment browser policy through the ${source ? 'Bun source' : 'published import'} condition`, () => {
    test('bundles the four UI helpers and fails closed for remote or unknown surfaces', async () => {
      const policy = await bundleConsumer(source);
      expect(Object.keys(policy).sort()).toEqual([
        'CVV_PROMPT_TRADEOFF_WARNING', 'describeCardEntryRefusal',
        'mayEnterCardDetails', 'mayOfferCardEntryFlow',
      ]);
      for (const surface of ['tui', 'agent-terminal', 'webui', ' WEBUI ']) {
        expect(policy.mayEnterCardDetails(surface)).toBe(true);
        expect(policy.mayOfferCardEntryFlow(surface)).toBe(true);
      }
      for (const surface of ['telegram', 'slack', 'email', 'unknown', '', 'webui.evil']) {
        expect(policy.mayEnterCardDetails(surface)).toBe(false);
        expect(policy.mayOfferCardEntryFlow(surface)).toBe(false);
      }
      expect(policy.CVV_PROMPT_TRADEOFF_WARNING).toBe(browserPolicy.CVV_PROMPT_TRADEOFF_WARNING);
      expect(policy.CVV_PROMPT_TRADEOFF_WARNING.length).toBeGreaterThan(0);
      expect(policy.describeCardEntryRefusal('slack')).toBe(browserPolicy.describeCardEntryRefusal('slack'));
      // An unknown surface identifier is never reflected back into the refusal.
      expect(policy.describeCardEntryRefusal('untrusted-4242424242424242'))
        .toBe(policy.describeCardEntryRefusal('unknown'));
    }, 40_000);
  });
}

test('the existing host entry keeps the same policy functions and warning', async () => {
  const host = await import('../sdk/src/platform/payments/index.js');
  expect(host.mayEnterCardDetails).toBe(browserPolicy.mayEnterCardDetails);
  expect(host.mayOfferCardEntryFlow).toBe(browserPolicy.mayOfferCardEntryFlow);
  expect(host.describeCardEntryRefusal).toBe(browserPolicy.describeCardEntryRefusal);
  expect(host.CVV_PROMPT_TRADEOFF_WARNING).toBe(browserPolicy.CVV_PROMPT_TRADEOFF_WARNING);
  expect(typeof host.scanForCardDetails).toBe('function');
  expect(typeof host.evaluateCardEntry).toBe('function');
});
