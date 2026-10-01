/** A subprocess keeps a regressed synchronous FIFO open from hanging bun:test. */
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { AgentAccountRegistry } from '../../sdk/src/platform/google/account-registry.ts';
import { AsyncAgentAccountRegistry } from '../../sdk/src/platform/google/async-account-registry.ts';

const [mode, storePath] = process.argv.slice(2);
if (!mode || !storePath) throw new Error('Fixture mode and path required');
const input = {
  serviceDomain: 'example.test', serviceUrl: 'https://example.test/signup',
  aliasAddress: 'fixture+account@example.test', purpose: 'POSIX nonblocking registry fixture',
  credentialSecretKey: 'signup/fixture',
};
const controller = new AbortController();
let reads = 0;
let begin!: () => void;
let release!: () => void;
const started = new Promise<void>((resolve) => { begin = resolve; });
const held = new Promise<void>((resolve) => { release = resolve; });
const replacing = mode.startsWith('replace-');
if (replacing || mode === 'regular') {
  new AgentAccountRegistry({ storePath, containsSecretLikeText: () => false }).record(input);
}
const registry = new AsyncAgentAccountRegistry({ storePath, readSecretLikeText: async () => {
  reads++;
  if (replacing && reads === 1) { begin(); await held; }
  return false;
} });
const cancellationTimer = setTimeout(() => controller.abort(new Error('fixture cancellation deadline')), 100);
const mutation = mode.endsWith('-record') || mode === 'replace-cancel';
const pending = (mutation ? registry.record(input, { signal: controller.signal }) : registry.list({ signal: controller.signal }))
  .then(() => ({ rejected: false, reason: '' }), (error: unknown) => ({ rejected: true, reason: error instanceof Error ? error.message : 'unknown failure' }));
if (replacing) {
  await started;
  unlinkSync(storePath);
  const fifo = spawnSync('mkfifo', [storePath]);
  if (fifo.status !== 0) throw new Error('Fixture FIFO creation failed');
  if (mode === 'replace-cancel') controller.abort(new Error('fixture cancelled while reading'));
  release();
}
const result = await pending;
clearTimeout(cancellationTimer);
await new Promise<void>((resolve) => setTimeout(resolve, 0));
process.stdout.write(`${JSON.stringify({ ...result, reads, fifo: lstatSync(storePath).isFIFO(), files: readdirSync(dirname(storePath)).sort() })}\n`);
