import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** Agent and TUI must use this same canonical workspace/project slot. */
export function resolveLegacyImportJournalLocation(input: { workspace: string; projectId: string; stateDirectory: string }) {
  if (!input.projectId.trim()) throw new Error('Project identity required');
  const workspace = realpathSync(input.workspace);
  const key = createHash('sha256').update(JSON.stringify([workspace, input.projectId])).digest('hex');
  const oldPath = join(input.stateDirectory, 'agent', 'legacy-import', `${key}.sqlite`);
  try {
    lstatSync(oldPath);
    throw new Error('An earlier Agent import journal exists; reconcile it before selecting the shared journal');
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return { workspace, journalPath: join(input.stateDirectory, 'shared', 'legacy-import', `${key}.sqlite`) };
}
