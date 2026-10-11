import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OwnerProfileStore } from '../sdk/src/platform/owner-profile/store.ts';
import { captureProfileDelegation, bindProfileMutationOptionsToInvocation, type ProfileMutationOptions } from '../sdk/src/platform/owner-profile/delegation.ts';
import { parseProfileDocument } from '../sdk/src/platform/owner-profile/document.ts';
import type { ProfilePersistIo } from '../sdk/src/platform/owner-profile/writer.ts';
import { OccasionStateStore } from '../sdk/src/platform/occasions/state-store.ts';
import { OccasionsService } from '../sdk/src/platform/occasions/service.ts';
import type { OccasionMutationOptions } from '../sdk/src/platform/occasions/operation.ts';
import { registerOccasionsGatewayMethods } from '../sdk/src/platform/control-plane/routes/occasions.ts';
import { GatewayMethodCatalog } from '../sdk/src/platform/control-plane/method-catalog.ts';
import { assertCurrentToolEffect } from '../sdk/src/platform/tools/registry.ts';
import { captureFileMutation, type MutationPublication } from '../sdk/src/platform/utils/file-mutation.ts';
import { resetProcessUntrustedContentLedgerForTests } from '../sdk/src/platform/security/untrusted-content.ts';
import { admitLocalState } from './helpers/local-state-admission.ts';
import { useSecurityReadings } from './helpers/security-readings.ts';
import type { ToolRegistry } from '../sdk/src/platform/tools/registry.ts';
import type { PermissionMode } from '../sdk/src/platform/config/index.ts';

useSecurityReadings(); beforeEach(() => { resetProcessUntrustedContentLedgerForTests(); });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(persistIo?: ProfilePersistIo, withPublication?: MutationPublication) {
  const root = mkdtempSync(join(tmpdir(), 'gv-delegated-profile-')); roots.push(root);
  const profilePath = join(root, 'profile.md'), statePath = join(root, 'occasions.json');
  writeFileSync(profilePath, '# Owner profile\n\n## Important dates\n');
  const profile = new OwnerProfileStore({ path: profilePath, persistIo }); profile.loadSync();
  const state = new OccasionStateStore(statePath);
  const config = { get: (key: string) => key === 'daemon.timezone' ? 'UTC' : undefined, set() {} };
  const service = new OccasionsService({ profile, writer: profile, state, config, now: () => Date.parse('2026-03-01T10:00:00Z') });
  const catalog = new GatewayMethodCatalog(); registerOccasionsGatewayMethods(catalog, service);
  let retained: ProfileMutationOptions | undefined;
  const register = (registry: ToolRegistry) => registry.register({
    definition: { name: 'native_occasion_fixture', description: 'Recorded isolated native occasion request', parameters: { type: 'object', properties: {}, additionalProperties: true }, sideEffects: ['state'], concurrency: 'serial' },
    async execute(args, options) {
      const assertCurrent = () => { options?.signal?.throwIfAborted(); if (!assertCurrentToolEffect(args, options, 'write')) throw new Error('Held'); current?.(); };
      assertCurrent();
      const reading: OccasionMutationOptions = { ...receipts, signal: options?.signal, assertCurrent,
        ...(args.action === 'confirm' ? { delegation: captureProfileDelegation(args, options) } : {}) };
      retained = reading;
      const invocation = { body: args.action === 'confirm'
        ? { title: 'Family day', date: '03-14', kind: 'remember-only', surface: 'agent', authority: 'autonomous', said: '' }
        : { interviewId: 'gift-interview', stepId: 'step-1', text: 'A class' }, signal: options?.signal, isAuthorized: () => { assertCurrent(); return true; } };
      bindProfileMutationOptionsToInvocation(reading, invocation);
      const result = await catalog.invoke(args.action === 'confirm' ? 'occasions.confirm' : 'occasions.interview.answer', invocation);
      assertCurrent();
      return { success: true, output: JSON.stringify(result) };
    },
  }, { inputProjection: { async project(request) {
    const profileFile = captureFileMutation(profilePath), stateFile = captureFileMutation(statePath);
    const profileLease = profile.captureRead(), stateLease = state.captureRead();
    let profileIntent = false, stateIntent = false;
    current = () => { request.assertCurrent(); request.signal?.throwIfAborted(); profileFile.assertCurrent(); stateFile.assertCurrent();
      if (!profileIntent) profileLease.assertCurrent(); if (!stateIntent) stateLease.assertCurrent(); };
    receipts = {
      withPublication,
      onWriteIntent() { current?.(); profileIntent = true; }, onEffect(published) { profileFile.onEffect(published); stateFile.onEffect(); },
      onStateWriteIntent() { current?.(); stateIntent = true; }, onStateEffect(published) { stateFile.onEffect(published); profileFile.onEffect(); },
    };
    current(); return { status: 'projected', args: request.args, assertCurrent: current };
  } } });
  let current: (() => void) | undefined, receipts: OccasionMutationOptions = {};
  return { root, profile, state, profilePath, statePath, register, get retained() { return retained; } };
}

test('recorded native relay confirms an actual occasion with truthful autonomous provenance', async () => {
  const f = fixture();
  const result = await admitLocalState(f.register, 'native_occasion_fixture', { action: 'confirm' }, { directory: f.root });
  expect(result.success).toBe(true); expect(result.output).toContain('"ok":true');
  const text = readFileSync(f.profilePath, 'utf8'); expect(text).toContain('Family day · 03-14');
  const provenance = parseProfileDocument({ path: f.profilePath, text, exists: true }).sections.find(section => section.heading === 'Important dates')?.prose[0]?.provenance;
  expect(provenance?.origin).toBe('autonomous'); expect(provenance?.said).toBe('');
});

test('actual recorded profile publication retains its native final restriction exactly once', async () => {
  let publications = 0, checks = 0;
  const f = fixture(undefined, async operation => {
    publications += 1;
    return operation(() => { checks += 1; });
  });
  const result = await admitLocalState(f.register, 'native_occasion_fixture', { action: 'confirm' }, { directory: f.root });
  expect(result.success).toBe(true); expect(result.output).toContain('"ok":true');
  expect(publications).toBe(1); expect(checks).toBeGreaterThan(0);
  expect(readFileSync(f.profilePath, 'utf8')).toContain('Family day · 03-14');
});

test('native profile provenance evidence retires with its real registry invocation', async () => {
  const f = fixture(); expect((await admitLocalState(f.register, 'native_occasion_fixture', { action: 'confirm' }, { directory: f.root })).success).toBe(true);
  const before = readFileSync(f.profilePath, 'utf8');
  await expect(f.profile.append({ authority: 'autonomous', surface: 'agent', said: '', section: 'Notes', text: 'After retirement' }, f.retained)).rejects.toThrow();
  expect(readFileSync(f.profilePath, 'utf8')).toBe(before);
});

test.each(['file', 'parent'] as const)('native pre-admission profile %s ABA is refused', async kind => {
  const f = fixture(), before = readFileSync(f.profilePath, 'utf8');
  const result = await admitLocalState(f.register, 'native_occasion_fixture', { action: 'confirm' }, { directory: f.root,
    afterCapture() { const path = kind === 'file' ? f.profilePath : f.root, saved = `${path}.saved`; renameSync(path, saved); renameSync(saved, path); } });
  expect(result.success).toBe(false); expect(readFileSync(f.profilePath, 'utf8')).toBe(before);
});

test.each(['cancel', 'revoke'] as const)('actual native state write holds %s across its read await', async action => {
  const f = fixture(), controller = new AbortController(); let mode: PermissionMode = 'prompt';
  await f.state.putInterview({ id: 'gift-interview', occasionId: 'family-day', occurrence: '2026-03-14', startedAt: 1,
    steps: [{ id: 'step-1', prompt: 'What did you choose?', opensFrom: '' }], answers: [] });
  const before = readFileSync(f.statePath, 'utf8'), read = f.state.interview.bind(f.state);
  f.state.interview = async id => { const value = await read(id); if (action === 'cancel') controller.abort(); else mode = 'plan'; return value; };
  const result = await admitLocalState(f.register, 'native_occasion_fixture', { action: 'interview_answer' }, { directory: f.root, signal: controller.signal, currentMode: () => mode });
  expect(result.success).toBe(false); expect(readFileSync(f.statePath, 'utf8')).toBe(before);
});

test.each([
  ['mkdir', 'cancel'], ['mkdir', 'revoke'], ['writeFile', 'cancel'], ['writeFile', 'revoke'],
] as const)('native profile publication holds after %s await on %s', async (stage, action) => {
  const controller = new AbortController(); let mode: PermissionMode = 'prompt', publications = 0, reached = false;
  const interrupt = (completed: 'mkdir' | 'writeFile') => {
    if (stage !== completed) return;
    reached = true;
    if (action === 'cancel') controller.abort(); else mode = 'plan';
  };
  const io: ProfilePersistIo = {
    async mkdir(path) { await mkdir(path, { recursive: true }); interrupt('mkdir'); },
    async writeFile(path, text) { await writeFile(path, text, 'utf8'); interrupt('writeFile'); },
    async rename(from, to) { publications += 1; await rename(from, to); },
    async remove(path) { await rm(path, { force: true }); },
  };
  const f = fixture(io), before = readFileSync(f.profilePath, 'utf8');
  const result = await admitLocalState(f.register, 'native_occasion_fixture', { action: 'confirm' }, {
    directory: f.root, signal: controller.signal, currentMode: () => mode,
  });
  expect(reached).toBe(true); expect(result.success).toBe(false); expect(publications).toBe(0);
  expect(readFileSync(f.profilePath, 'utf8')).toBe(before);
});

test('recorded profile publication cannot adopt an external replacement across rename await', async () => {
  const foreign = '# External profile edit\n';
  const f = fixture({
    async mkdir(path) { await mkdir(path, { recursive: true }); },
    async writeFile(path, text) { await writeFile(path, text, 'utf8'); },
    async rename(from, to) { await rename(from, to); await writeFile(to, foreign, 'utf8'); },
    async remove(path) { await rm(path, { force: true }); },
  });
  const result = await admitLocalState(f.register, 'native_occasion_fixture', { action: 'confirm' }, { directory: f.root });
  expect(readFileSync(f.profilePath, 'utf8')).toBe(foreign);
  expect(result.success).toBe(false);
  expect(f.profile.importantDates().some(line => line.text.includes('Family day'))).toBe(false);
});
