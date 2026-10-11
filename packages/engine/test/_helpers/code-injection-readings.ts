/** Offline live code-source fixture for real provider-loop regressions. */
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexStore } from '../../sdk/src/platform/state/code-index-store.js';
import { MemoryEmbeddingProviderRegistry } from '../../sdk/src/platform/state/memory-embeddings.js';
import { ConfigManager } from '../../sdk/src/platform/config/manager.js';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
/** Real vector store and live file adapter, with only the provider and policy owner synthetic. */
export async function createCanonicalLiveCodeSource(nested = false) {
  const root = mkdtempSync(join(tmpdir(), 'canonical-live-code-'));
  const config = new ConfigManager({ configDir: join(root, '.goodvibes') });
  const registry = new MemoryEmbeddingProviderRegistry({ configManager: config });
  const embedSync = () => { const vector = new Float32Array(384); vector[0] = 1; return { vector, dimensions: 384 }; };
  registry.register({ id: 'offline-code-provider', label: 'Offline code fixture', dimensions: 384, embedSync, embed: async () => embedSync() }, { makeDefault: true });
  const directory = nested ? join(root, 'nested') : root;
  if (nested) mkdirSync(directory);
  const path = join(directory, 'backoff.ts'); writeFileSync(path, 'export async function backoff() { await sleep(base * 2 ** attempt); }\n');
  const store = new CodeIndexStore(root, ':memory:', registry);
  let allowed = true;
  // Index construction now uses the canonical directory reader. Answer only
  // this fixture's exact setup paths, separately from the relevance/policy port
  // whose calls and revocation the consuming tests observe.
  const directories = fakePort((key, question, state) => {
    const directory = (state as { directories: { id: string; name: string; relativePath: string }[] }).directories.find(entry => entry.id === key);
    if (question.type !== 'noul' || !directory) throw new Error('Unexpected fixture directory question');
    if (directory.name === '.goodvibes' && directory.relativePath === '.goodvibes') return noulAnswer(0.99);
    if (nested && directory.name === 'nested' && directory.relativePath === 'nested') return noulAnswer(0.01);
    throw new Error(`Unexpected fixture directory: ${directory.relativePath}`);
  });
  let previous: ReturnType<typeof installJudgmentPort>;
  previous = installJudgmentPort({ ...directories.port, ask(request) {
    if (request.context?.battery === 'engine.walk.skip-directory') return directories.port.ask(request);
    if (!previous) throw new Error(`Missing fixture setup port for ${request.context?.battery}`);
    return previous.ask(request);
  } });
  try { await store.init(); await store.buildFull(); }
  catch (error) { store.close(); rmSync(root, { recursive: true, force: true }); throw error; }
  finally { installJudgmentPort(previous); }
  return { store, path, directory, readAccessFilter: async () => allowed,
    deny: () => { allowed = false; }, mutate: () => writeFileSync(path, 'export const changed = true;\n'),
    dispose: () => { store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}
