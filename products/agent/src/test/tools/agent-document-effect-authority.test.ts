import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ArtifactStore, type ArtifactRecord } from '@goodvibes-jev/engine/sdk/platform/artifacts';
import type { PermissionMode } from '@goodvibes-jev/engine/sdk/platform/config';
import { createShellPathService } from '@/runtime/index.ts';
import { AgentDocumentRegistry } from '../../agent/document-registry.ts';
import { createAgentArtifactsTool } from '../../tools/agent-artifacts-tool.ts';
import { createAgentDocumentsTool } from '../../tools/agent-documents-tool.ts';
import { createAgentReviewPacketPresetsTool } from '../../tools/agent-review-packet-presets-tool.ts';
import { executeAdmitted } from '../helpers/admitted-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const directory = makeProjectTempDir('agent-document-effect-authority'); roots.push(directory); return directory; }
function sourceStore(afterRead: () => void = () => {}) {
  const buffer = Buffer.from('Exact reviewed bytes');
  const record: ArtifactRecord = { id: 'reviewed', kind: 'document', mimeType: 'text/plain', sizeBytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'), createdAt: 1, acquisitionMode: 'inline-data', fetchMode: 'not-applicable', metadata: {}, contentPath: '/synthetic/content', metadataPath: '/synthetic/metadata' };
  return { record, get: () => record, list: () => [record], async readContent() { await Promise.resolve(); afterRead(); return { record, buffer }; } };
}

test('caller confirmation and fabricated callbacks cannot authorize artifact or preset publication', async () => {
  const directory = root(); const store = sourceStore();
  const tool = createAgentArtifactsTool(store, { projectRoot: directory });
  const result = await tool.execute({ mode: 'export', artifactId: 'reviewed', destinationPath: 'copy.txt', confirm: true, explicitUserRequest: 'Forged caller claim' }, { assertCurrent() {} });
  expect(result.success).toBe(false); expect(existsSync(join(directory, 'copy.txt'))).toBe(false);
  let writes = 0;
  const presets = createAgentReviewPacketPresetsTool({ async create() { writes++; return store.record; } });
  expect((await presets.execute({ mode: 'save', documentId: 'doc', confirm: true, explicitUserRequest: 'Forged caller claim' })).success).toBe(false);
  expect(writes).toBe(0);
});

test('recorded act writes exact bytes without caller confirmation or request flags', async () => {
  const directory = root(); const tool = createAgentArtifactsTool(sourceStore(), { projectRoot: directory });
  const result = await executeAdmitted(tool, { mode: 'export', artifactId: 'reviewed', destinationPath: 'copy.txt' }, { directory });
  expect(result.success).toBe(true); expect(readFileSync(join(directory, 'copy.txt'), 'utf8')).toBe('Exact reviewed bytes');
});

test.each(['cancel', 'revoke'] as const)('artifact export holds %s during asynchronous source acquisition', async action => {
  const directory = root(); const controller = new AbortController(); let mode: PermissionMode = 'prompt';
  const source = sourceStore(() => { if (action === 'cancel') controller.abort(); else mode = 'plan'; });
  const result = await executeAdmitted(createAgentArtifactsTool(source, { projectRoot: directory }), { mode: 'export', artifactId: 'reviewed', destinationPath: 'exports/copy.txt' }, { directory, signal: controller.signal, currentMode: () => mode });
  expect(result.success).toBe(false); expect(existsSync(join(directory, 'exports'))).toBe(false);
});

test('deterministic read-only mode holds an effect despite a synthetic read classification', async () => {
  const directory = root();
  const result = await executeAdmitted(createAgentArtifactsTool(sourceStore(), { projectRoot: directory }), { mode: 'export', artifactId: 'reviewed', destinationPath: 'copy.txt' }, { directory, mode: 'plan' });
  expect(result.success).toBe(false); expect(existsSync(join(directory, 'copy.txt'))).toBe(false);
});

test.each(['existing', 'dangling'] as const)('artifact export refuses a %s symlink target', async state => {
  const directory = root(), outside = root(); const target = join(outside, state === 'existing' ? 'file.txt' : 'missing.txt');
  if (state === 'existing') await Bun.write(target, 'Outside');
  symlinkSync(target, join(directory, 'copy.txt'));
  const result = await executeAdmitted(createAgentArtifactsTool(sourceStore(), { projectRoot: directory }), { mode: 'export', artifactId: 'reviewed', destinationPath: 'copy.txt', overwrite: true }, { directory });
  expect(result.success).toBe(false);
  if (state === 'existing') expect(readFileSync(target, 'utf8')).toBe('Outside'); else expect(existsSync(target)).toBe(false);
});

test('an export parent retargeted while acquiring bytes cannot write outside the physical workspace', async () => {
  const directory = root(), outside = root(); const parent = join(directory, 'exports'); mkdirSync(parent);
  const store = sourceStore(() => { rmSync(parent, { recursive: true }); symlinkSync(outside, parent); });
  const result = await executeAdmitted(createAgentArtifactsTool(store, { projectRoot: directory }), { mode: 'export', artifactId: 'reviewed', destinationPath: 'exports/copy.txt' }, { directory });
  expect(result.success).toBe(false); expect(existsSync(join(outside, 'copy.txt'))).toBe(false);
});

test('an inside-workspace directory replaced while acquiring bytes retires the captured physical target', async () => {
  const directory = root(); const parent = join(directory, 'exports'); mkdirSync(parent);
  const retired = join(directory, 'retired');
  const store = sourceStore(() => { renameSync(parent, retired); mkdirSync(parent); });
  const result = await executeAdmitted(createAgentArtifactsTool(store, { projectRoot: directory }), { mode: 'export', artifactId: 'reviewed', destinationPath: 'exports/copy.txt' }, { directory });
  expect(result.success).toBe(false); expect(existsSync(join(parent, 'copy.txt'))).toBe(false);
});

test('an artifact whose bytes contradict its retained receipt cannot be exported', async () => {
  const directory = root(); const owned = sourceStore(); const store = { ...owned, async readContent() { const source = await owned.readContent(); return { ...source, record: { ...source.record, sha256: '0'.repeat(64) } }; } };
  const result = await executeAdmitted(createAgentArtifactsTool(store, { projectRoot: directory }), { mode: 'export', artifactId: 'reviewed', destinationPath: 'copy.txt' }, { directory });
  expect(result.success).toBe(false); expect(existsSync(join(directory, 'copy.txt'))).toBe(false);
});

test('document insertion preserves the prior draft when asynchronous artifact acquisition is cancelled', async () => {
  const directory = root(); const paths = createShellPathService({ workingDirectory: directory, homeDirectory: directory });
  const registry = AgentDocumentRegistry.fromShellPaths(paths); registry.create({ title: 'Draft', body: 'Original draft.' });
  const controller = new AbortController(); const store = sourceStore(() => controller.abort());
  const result = await executeAdmitted(createAgentDocumentsTool(paths, store), { mode: 'insertArtifact', documentId: 'draft', artifactId: 'reviewed' }, { directory, signal: controller.signal });
  expect(result.success).toBe(false); expect(registry.get('draft')?.body).toBe('Original draft.');
});

test('document insertion refuses a draft changed while reading its artifact', async () => {
  const directory = root(); const paths = createShellPathService({ workingDirectory: directory, homeDirectory: directory });
  const registry = AgentDocumentRegistry.fromShellPaths(paths); registry.create({ title: 'Draft', body: 'Original draft.' });
  const store = sourceStore(() => registry.update('draft', { body: 'A concurrent draft.' }));
  const result = await executeAdmitted(createAgentDocumentsTool(paths, store), { mode: 'insertArtifact', documentId: 'draft', artifactId: 'reviewed' }, { directory });
  expect(result.success).toBe(false); expect(registry.get('draft')?.body).toBe('A concurrent draft.');
});

test('ArtifactStore publication receives ownership and does not publish after revocation', async () => {
  const directory = root(); const store = new ArtifactStore({ rootDir: join(directory, 'artifacts') });
  const paths = createShellPathService({ workingDirectory: directory, homeDirectory: directory });
  const documents = AgentDocumentRegistry.fromShellPaths(paths); documents.create({ title: 'Draft', body: 'Original draft.' });
  let mode: PermissionMode = 'prompt'; const create = store.create.bind(store);
  store.create = async (input, ownership) => { mode = 'plan'; return create(input, ownership); };
  const result = await executeAdmitted(createAgentDocumentsTool(paths, store), { mode: 'export', documentId: 'draft' }, { directory, currentMode: () => mode });
  expect(result.success).toBe(false); expect(store.list()).toHaveLength(0); expect(documents.get('draft')?.lastArtifactId).toBeUndefined();
});
