/** Pairing-fixture readiness evidence, read only from its isolated home. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { WORKSPACE_REGISTRATION_QUESTION } from '../../shell/workspace-registration-question.ts';

interface Home { readonly home: string; readonly workspace: string }
export function observeOwnedWorkspaceDecline(home: Home) {
  const path = join(home.home, '.goodvibes/shared/workspace-registrations.json');
  let bytes: Buffer;
  try { bytes = readFileSync(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw error;
    return { present: false, byteCount: 0, sha256: null, readable: false, ownedDecline: false };
  }
  const evidence = { present: true, byteCount: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  let record: { version?: unknown; declines?: unknown };
  try { record = JSON.parse(bytes.toString('utf8')); }
  catch { return { ...evidence, readable: false, ownedDecline: false }; }
  const readable = record !== null && typeof record === 'object' && (record.version === 1 || record.version === 2) && Array.isArray(record.declines);
  const root = realpathSync(home.workspace);
  const ownedDecline = readable && (record.declines as unknown[]).some(value => value !== null && typeof value === 'object'
    && 'root' in value && value.root === root && 'declinedAt' in value && typeof value.declinedAt === 'string' && Number.isFinite(Date.parse(value.declinedAt)));
  return { ...evidence, readable, ownedDecline };
}

export function ownerWorkspaceStartupReadiness(screen: string, home: Home) {
  const registration = observeOwnedWorkspaceDecline(home);
  const canEcho = registration.ownedDecline && !screen.includes(WORKSPACE_REGISTRATION_QUESTION);
  return { registration, canEcho, ready: canEcho && screen.includes('┃  x') };
}
