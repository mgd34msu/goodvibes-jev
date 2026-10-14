import { screeningAnswers } from '../_helpers/screening-answers.js';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { evaluateSmokeOutput, runPostBuildSmoke, scanArtifactForEagerNamespaceReads, captureLogger, realExec } from '@goodvibes-jev/engine/toolchain';
import { scriptedExec } from './_helpers.ts';
import { readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import type { JudgmentPort } from '@goodvibes-jev/judgment';
import { createProtectedSourceOwner } from '../../sdk/src/platform/security/source-screening/owner.js';
import { smokeLoadFailure } from '../../toolchain/src/batteries/smoke-load-failure.js';
import { makeProjectTempDir } from '../_helpers/project-temp.js';

let previous: ReturnType<typeof installJudgmentPort>;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(async () => { installJudgmentPort(previous); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function protectedDiagnosticOwner(options: { readonly redactPart?: number; readonly screeningProbability?: number } = {}) {
  const requests: unknown[] = [];
  const lifetime = new AbortController();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body: unknown = await request.json(); requests.push(body);
    if (new URL(request.url).pathname === '/v1/chat/completions') {
      if (!body || typeof body !== 'object' || !('messages' in body) || !Array.isArray(body.messages)) throw new Error('Invalid screening fixture.');
      const message: unknown = body.messages[1];
      if (!message || typeof message !== 'object' || !('content' in message) || typeof message.content !== 'string') throw new Error('Invalid screening fixture.');
      const source: unknown = JSON.parse(message.content);
      if (!source || typeof source !== 'object' || !('revision' in source) || !('parts' in source) || !Array.isArray(source.parts)) throw new Error('Invalid screening fixture.');
      const part = options.redactPart;
      const text: unknown = part === undefined ? undefined : source.parts[part];
      const spans = part !== undefined && typeof text === 'string' ? [{ part, start: 0, end: text.length }] : [];
      return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ revision: source.revision, spans }) } }] });
    }
    return Response.json({ model: 'jev-1.13.0', answers: screeningAnswers(body, { complete: options.screeningProbability ?? 1, precise: 1 }), usage: { input_tokens: 10, output_tokens: 2 } });
  } });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const owner = createProtectedSourceOwner({
    authority: { ownerId: 'synthetic-smoke-owner', revision: '1', retention: 'ephemeral-no-log', signal: lifetime.signal, assertCurrent: () => {} },
    proposal: { endpoint, model: 'local-span-fixture' }, judgment: { endpoint, model: 'jev-1.13.0' }, timeoutMs: 1_000,
  });
  cleanups.push(async () => { await owner.close(); await server.stop(true); });
  return { owner, requests, lifetime };
}

function smokeFixture(stderr: string) {
  return { binary: 'fixture', config, logger: captureLogger(), readArtifact: () => CLEAN_ARTIFACT,
    exec: scriptedExec(() => ({ status: 0, stdout: 'goodvibes-agent 1.12.0\n', stderr })) };
}

const config = { bannerPrefix: 'goodvibes-agent ', binaryDefault: 'dist/goodvibes-agent' };

const CLEAN_ARTIFACT = [
  'var exports_bootstrap = {};',
  '__export(exports_bootstrap, {',
  '  saveSession: () => saveSession,',
  '});',
  'var init_thing = __esm(() => {',
  '  var lazy = exports_bootstrap.saveSession;', // indented: runs post-settle, safe
  '});',
].join('\n');

const TAINTED_ARTIFACT = `${CLEAN_ARTIFACT}\nvar saveSession2 = exports_bootstrap.saveSession;\nvar buildUrl2 = exports_transport.buildUrl;`;

describe('post-build-smoke', () => {
  test('passes on a correct banner', () => {
    expect(evaluateSmokeOutput({ status: 0, stdout: 'goodvibes-agent 1.12.0\n', stderr: '' }, config).ok).toBe(true);
  });
  test('fails on a non-zero exit', () => {
    expect(evaluateSmokeOutput({ status: 1, stdout: '', stderr: 'boom' }, config).ok).toBe(false);
  });
  test('withholds unexpected diagnostics without a source-bound reading', () => {
    const r = evaluateSmokeOutput({ status: 0, stdout: 'goodvibes-agent 1.0.0', stderr: 'cannot find sqlite-vec' }, config);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('requires a current load-failure reading');
  });
  test('fails on a wrong banner prefix', () => {
    expect(evaluateSmokeOutput({ status: 0, stdout: 'v1.0.0', stderr: '' }, config).ok).toBe(false);
  });
  test('runPostBuildSmoke wires exec + banner check', async () => {
    const exec = scriptedExec(() => ({ status: 0, stdout: 'goodvibes-agent 1.12.0\n' }));
    expect((await runPostBuildSmoke({ binary: 'dist/goodvibes-agent', config, exec, logger: captureLogger(), readArtifact: () => CLEAN_ARTIFACT })).ok).toBe(true);
  });
  test('scan flags only column-0 eager namespace reads', () => {
    expect(scanArtifactForEagerNamespaceReads(CLEAN_ARTIFACT)).toEqual([]);
    expect(scanArtifactForEagerNamespaceReads(TAINTED_ARTIFACT)).toEqual([
      'var saveSession2 = exports_bootstrap.saveSession',
      'var buildUrl2 = exports_transport.buildUrl',
    ]);
  });
  test('scan caps its report at the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => `var alias${i} = exports_shell.member${i};`).join('\n');
    expect(scanArtifactForEagerNamespaceReads(many)).toHaveLength(8);
  });
  test('a booting binary still fails when the artifact carries eager reads', async () => {
    const exec = scriptedExec(() => ({ status: 0, stdout: 'goodvibes-agent 1.12.0\n' }));
    const logger = captureLogger();
    const r = await runPostBuildSmoke({ binary: 'dist/goodvibes-agent', config, exec, logger, readArtifact: () => TAINTED_ARTIFACT });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('eager namespace read');
    expect(r.detail).toContain('exports_bootstrap.saveSession');
  });
  test('an unreadable artifact fails the smoke rather than skipping the scan', async () => {
    const exec = scriptedExec(() => ({ status: 0, stdout: 'goodvibes-agent 1.12.0\n' }));
    const r = await runPostBuildSmoke({ binary: 'dist/goodvibes-agent', config, exec, logger: captureLogger(), readArtifact: () => { throw new Error('EACCES'); } });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('artifact scan could not read');
  });
});

test('reserved module names in an ordinary version banner are protocol data', () => {
  expect(evaluateSmokeOutput({ status: 0, stdout: 'sqlite-vec-cli 1.2.3\n', stderr: '' }, { bannerPrefix: 'sqlite-vec-cli ' }).ok).toBe(true);
  expect(evaluateSmokeOutput({ status: 0, stdout: 'goodvibes-agent 1.2.3+sqlite-vec\n', stderr: '' }, config).ok).toBe(true);
});

test.each(['goodvibes-agent garbage\n', 'goodvibes-agent 1.2\n', 'goodvibes-agent 1.2.3 failed\n'])('invalid banner remains a deterministic refusal: %s', stdout => {
  expect(evaluateSmokeOutput({ status: 0, stdout, stderr: '' }, config).ok).toBe(false);
});

test('clean version smoke works offline and never invokes diagnostic privacy or Jev', async () => {
  const privacy = protectedDiagnosticOwner();
  expect((await runPostBuildSmoke({ ...smokeFixture(''), diagnosticSourceOwner: privacy.owner })).ok).toBe(true);
  expect(privacy.requests).toEqual([]);
});

test('unrecognized diagnostics withhold offline without guessing or exposing their text', async () => {
  const fake = fakePort(() => noulAnswer(0.01)); installJudgmentPort(fake.port);
  const options = smokeFixture('synthetic private diagnostic tail');
  expect((await runPostBuildSmoke(options)).ok).toBe(false);
  expect(fake.requests).toEqual([]);
  expect(options.logger.lines.join('\n')).not.toContain('synthetic private');
});

test('complete projected streams reach the named canonical reader, including their tail', async () => {
  const fake = fakePort(() => noulAnswer(0.01)); installJudgmentPort(fake.port);
  const stderr = `${'Successful startup diagnostic.\n'.repeat(120)}Quoted example: cannot find sqlite-vec. All modules loaded successfully.`;
  const privacy = protectedDiagnosticOwner();
  expect((await runPostBuildSmoke({ ...smokeFixture(stderr), diagnosticSourceOwner: privacy.owner })).ok).toBe(true);
  expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]?.context).toMatchObject({ battery: smokeLoadFailure.name, site: smokeLoadFailure.name });
  expect(fake.requests[0]?.state).toEqual({ stdout: 'goodvibes-agent 1.12.0\n', stderr });
});

test('private diagnostic spans remain local and only the actual screened projection reaches Jev', async () => {
  const fake = fakePort(() => noulAnswer(0.01)); installJudgmentPort(fake.port);
  const privacy = protectedDiagnosticOwner({ redactPart: 1 });
  expect((await runPostBuildSmoke({ ...smokeFixture('synthetic private person name'), diagnosticSourceOwner: privacy.owner })).ok).toBe(true);
  expect(fake.requests[0]?.state).toEqual({ stdout: 'goodvibes-agent 1.12.0\n', stderr: '[redacted]' });
});

test.each([0.99, 0.5])('actual failure or uncertainty refuses qualification (%s)', async probability => {
  const fake = fakePort(() => noulAnswer(probability)); installJudgmentPort(fake.port);
  const privacy = protectedDiagnosticOwner();
  expect((await runPostBuildSmoke({ ...smokeFixture('The native library could not be loaded.'), diagnosticSourceOwner: privacy.owner })).ok).toBe(false);
  expect(fake.requests).toHaveLength(1);
});

test('unsettled privacy screening and known credential material never reach the load reader', async () => {
  const fake = fakePort(() => noulAnswer(0.01)); installJudgmentPort(fake.port);
  const privacy = protectedDiagnosticOwner({ screeningProbability: 0.5 });
  expect((await runPostBuildSmoke({ ...smokeFixture('ordinary diagnostic'), diagnosticSourceOwner: privacy.owner })).ok).toBe(false);
  expect(fake.requests).toHaveLength(0);
  const blocked = protectedDiagnosticOwner();
  expect((await runPostBuildSmoke({ ...smokeFixture('password=synthetic-value'), diagnosticSourceOwner: blocked.owner })).ok).toBe(false);
  expect(blocked.requests).toHaveLength(0);
  expect(fake.requests).toHaveLength(0);
});

test('oversized output is withheld whole rather than clipping a trailing load failure', async () => {
  const fake = fakePort(() => noulAnswer(0.01)); installJudgmentPort(fake.port);
  const privacy = protectedDiagnosticOwner();
  expect((await runPostBuildSmoke({ ...smokeFixture(`${'ordinary diagnostic '.repeat(3_000)}The native library could not be loaded.`), diagnosticSourceOwner: privacy.owner })).ok).toBe(false);
  expect(privacy.requests).toHaveLength(0); expect(fake.requests).toHaveLength(0);
});

test('an unavailable canonical reader cannot reuse a favorable privacy reading as load approval', async () => {
  const privacy = protectedDiagnosticOwner();
  expect((await runPostBuildSmoke({ ...smokeFixture('ordinary diagnostic'), diagnosticSourceOwner: privacy.owner })).ok).toBe(false);
  expect(privacy.requests).toHaveLength(2);
});

test.each(['port replacement', 'caller cancellation'])('%s consumes a late result and prevents battery attachments', async retirement => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
  const fake = fakePort(() => noulAnswer(0.01)); const records: string[] = [];
  const port: JudgmentPort = { model: fake.port.model, async ask(request) {
    entered.resolve(); await release.promise;
    try { return { ...await fake.port.ask(request), decisionId: 'synthetic-smoke' }; } finally { finished.resolve(); }
  }, recorder: { recordReadings() { records.push('readings'); }, recordAction() { records.push('action'); } } };
  installJudgmentPort(port); const privacy = protectedDiagnosticOwner(); const operation = new AbortController();
  const pending = runPostBuildSmoke({ ...smokeFixture('ordinary diagnostic'), diagnosticSourceOwner: privacy.owner, signal: operation.signal });
  await entered.promise;
  if (retirement === 'port replacement') installJudgmentPort(fakePort(() => noulAnswer(0.01)).port);
  else operation.abort();
  expect((await pending).ok).toBe(false); release.resolve(); await finished.promise;
  expect(records).toEqual([]);
});

test('artifact replacement during the reading prevents result publication', async () => {
  let artifact = CLEAN_ARTIFACT;
  const fake = fakePort(() => { artifact = TAINTED_ARTIFACT; return noulAnswer(0.01); }); installJudgmentPort(fake.port);
  const privacy = protectedDiagnosticOwner();
  expect((await runPostBuildSmoke({ ...smokeFixture('ordinary diagnostic'), readArtifact: () => artifact, diagnosticSourceOwner: privacy.owner })).ok).toBe(false);
  expect(fake.requests).toHaveLength(1);
});

test('default filesystem ownership detects artifact bytes changed and restored during the reading', async () => {
  const binary = join(makeProjectTempDir('smoke-artifact-identity'), 'artifact');
  writeFileSync(binary, CLEAN_ARTIFACT); const original = statSync(binary);
  const fake = fakePort(() => {
    writeFileSync(binary, TAINTED_ARTIFACT); writeFileSync(binary, CLEAN_ARTIFACT);
    utimesSync(binary, original.atime, original.mtime);
    return noulAnswer(0.01);
  }); installJudgmentPort(fake.port);
  const privacy = protectedDiagnosticOwner();
  const result = await runPostBuildSmoke({ binary, config, logger: captureLogger(),
    exec: scriptedExec(() => ({ status: 0, stdout: 'goodvibes-agent 1.12.0\n', stderr: 'ordinary diagnostic' })), diagnosticSourceOwner: privacy.owner });
  expect(readFileSync(binary, 'utf8')).toBe(CLEAN_ARTIFACT);
  expect(result.ok).toBe(false); expect(fake.requests).toHaveLength(1);
});

test('retirement of the private source owner prevents publication of a favorable late reading', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const fake = fakePort(() => noulAnswer(0.01));
  const port: JudgmentPort = { model: fake.port.model, async ask(request) { entered.resolve(); await release.promise; return fake.port.ask(request); } };
  installJudgmentPort(port); const privacy = protectedDiagnosticOwner();
  const pending = runPostBuildSmoke({ ...smokeFixture('ordinary diagnostic'), diagnosticSourceOwner: privacy.owner });
  await entered.promise; privacy.lifetime.abort(); release.resolve();
  expect((await pending).ok).toBe(false);
});

test('original malformed responses and a changed observed model are refused before attachments', async () => {
  const fake = fakePort(() => noulAnswer(0.01)); const records: string[] = [];
  const port: JudgmentPort = { model: fake.port.model, async ask(request) {
    return { ...await fake.port.ask(request), model: 'other-model', decisionId: 'synthetic-smoke' };
  }, recorder: { recordReadings() { records.push('readings'); }, recordAction() { records.push('action'); } } };
  installJudgmentPort(port); const privacy = protectedDiagnosticOwner();
  expect((await runPostBuildSmoke({ ...smokeFixture('ordinary diagnostic'), diagnosticSourceOwner: privacy.owner })).ok).toBe(false);
  expect(records).toEqual([]);
  let getters = 0;
  installJudgmentPort({ ...port, async ask(request) {
    return Object.defineProperty(await fake.port.ask(request), 'hidden', { get() { getters++; return 'synthetic-private'; } });
  } });
  expect((await runPostBuildSmoke({ ...smokeFixture('ordinary diagnostic'), diagnosticSourceOwner: privacy.owner })).ok).toBe(false);
  expect(getters).toBe(0); expect(records).toEqual([]);
});

test('real subprocess success captures stderr and signal/spawn/timeout failures remain failures', () => {
  const output = realExec(process.execPath, ['-e', 'process.stdout.write("banner\\n"); process.stderr.write("diagnostic\\n");']);
  expect(output).toEqual({ status: 0, stdout: 'banner\n', stderr: 'diagnostic\n' });
  expect(realExec(process.execPath, ['-e', 'process.kill(process.pid,"SIGTERM");']).status).toBe(1);
  expect(realExec('/nonexistent-smoke-executable', []).status).toBe(1);
  const started = performance.now();
  expect(realExec(process.execPath, ['-e', 'process.on("SIGTERM",()=>{}); setInterval(()=>{},100);'], { timeoutMs: 150 }).status).toBe(1);
  expect(performance.now() - started).toBeLessThan(5_000);
});
