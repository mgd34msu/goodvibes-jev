import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { resolveScopedDirectory } from '../runtime/surface-root.js';
import type { ReadAccessFilter } from '../tools/shared/read-access.js';

/** Read saved observations without constructing an agent or restoring authority. */
export async function readAgentSessionHistory(input: {
  readonly projectRoot: string;
  readonly surfaceRoot?: string | undefined;
  readonly agentId: string;
  readonly readAccessFilter?: ReadAccessFilter | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent: () => void;
}): Promise<Record<string, unknown> | undefined> {
  const { projectRoot, surfaceRoot, agentId, readAccessFilter, signal, assertCurrent } = input;
  if (!/^[A-Za-z0-9_-]+$/.test(agentId)) return undefined;
  const current = () => {
    signal?.throwIfAborted(); assertCurrent();
    if (input.projectRoot !== projectRoot || input.surfaceRoot !== surfaceRoot || input.agentId !== agentId
      || input.readAccessFilter !== readAccessFilter || input.signal !== signal || input.assertCurrent !== assertCurrent)
      throw new Error('Historical worker lookup source changed');
  };
  current();
  let file: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const root = await realpath(projectRoot);
    const path = resolve(resolveScopedDirectory(root, surfaceRoot, 'sessions', 'agents'), `${agentId}.jsonl`);
    // Every component belongs to this surface; neither a journal symlink nor
    // a redirected directory may turn history lookup into an unrelated read.
    const parts = relative(root, path).split(sep);
    const directories = new Map<string, { dev: bigint; ino: bigint }>();
    let parent = root;
    for (const part of parts) {
      parent = join(parent, part);
      const entry = await lstat(parent, { bigint: true });
      current();
      if (entry.isSymbolicLink() || (parent === path ? !entry.isFile() : !entry.isDirectory())) return undefined;
      if (parent !== path) directories.set(parent, { dev: entry.dev, ino: entry.ino });
    }
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat({ bigint: true });
    current();
    if (readAccessFilter && !await readAccessFilter(path)) return undefined;
    current();
    for (const [directory, expected] of directories) {
      const actual = await lstat(directory, { bigint: true }); current();
      if (!actual.isDirectory() || actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino) return undefined;
    }
    const admitted = await lstat(path, { bigint: true });
    current();
    if (before.nlink !== 1n || !admitted.isFile() || admitted.isSymbolicLink()
      || before.dev !== admitted.dev || before.ino !== admitted.ino || before.ctimeNs !== admitted.ctimeNs) return undefined;
    const bytes = await file.readFile({ signal });
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) return undefined;
    const after = await file.stat({ bigint: true }), named = await lstat(path, { bigint: true });
    current();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.dev !== named.dev || after.ino !== named.ino || after.ctimeNs !== named.ctimeNs) return undefined;
    let metadataMatches = false, saved: Record<string, unknown> | undefined;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined;
      const entry = row as Record<string, unknown>;
      if (entry.type === 'meta') { metadataMatches = entry.agentId === agentId; saved = undefined; }
      if (entry.type !== 'agent_conversation') continue;
      if (!metadataMatches || entry.agentId !== agentId || entry.version !== 1 || !Array.isArray(entry.messages)
        || !Array.isArray(entry.archive) || !entry.messages.every((message: unknown) => message && typeof message === 'object'
          && 'role' in message && typeof message.role === 'string' && ['user', 'assistant', 'tool', 'system'].includes(message.role))) return undefined;
      saved = entry;
    }
    current();
    return saved ? { ...saved, kind: 'historical-agent-conversation', executionActive: false,
      meaning: 'Saved worker observations, not a live agent, new execution, current permission or completion approval. Preserve original scopes, versions and source roles.' } : undefined;
  } catch (error) {
    current();
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  } finally { await file?.close(); }
}
