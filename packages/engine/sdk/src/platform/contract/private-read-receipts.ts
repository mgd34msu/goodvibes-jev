import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../utils/atomic-json-store.js';
import type { ContractView } from './types.js';

type ArchiveOwner = Pick<ContractView, 'id'> & Partial<Pick<ContractView, 'projectRoot' | 'inputSnapshot' | 'units'>>;

function archivePath(contract: ArchiveOwner): string | undefined {
  if (!contract.projectRoot || !/^ctr-[a-f0-9]{8}$/.test(contract.id)) return undefined;
  let parent = contract.projectRoot;
  for (const part of ['.goodvibes', 'reviews', contract.id]) {
    parent = join(parent, part);
    if (existsSync(parent) && (!lstatSync(parent).isDirectory() || lstatSync(parent).isSymbolicLink())) throw new Error('Private receipt archive directory is redirected');
  }
  const path = join(parent, 'source-receipts.json');
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).nlink !== 1)) throw new Error('Private receipt archive is not an owned regular file');
  return path;
}

/** Actual private host storage, never a worker grant to reserved runtime state. */
export function preserveDeclaredReadReceipts(contract: ArchiveOwner): void {
  const relativePath = `.goodvibes/reviews/${contract.id}/source-receipts.json`;
  if (!contract.units?.some(unit => unit.files.includes(relativePath))) return;
  const path = archivePath(contract);
  if (!path) return;
  if (existsSync(path)) { readPrivateReceiptArchives(contract); return; }
  const archive = { version: 1, kind: 'contract-read-receipts', contractId: contract.id,
    inputId: contract.inputSnapshot?.id ?? null,
    meaning: 'Exact host-retained observations and reference contents from accepted units, preserved privately before public receipt ledgers are removed. This is storage, not approval or a new source inspection.',
    units: contract.units.filter(unit => unit.status === 'passed' && (unit.readEvidence?.length ?? 0) > 0).map(unit => ({
      id: unit.id, latestCheckId: unit.checks.at(-1)?.id ?? null,
      observations: unit.readEvidence ?? [],
    })),
  };
  mkdirSync(join(contract.projectRoot!, '.goodvibes', 'reviews', contract.id), { recursive: true, mode: 0o700 });
  // Recheck ancestry after creating it; no runtime/credential namespace is writable by the worker.
  if (archivePath(contract) !== path) throw new Error('Private receipt archive destination changed');
  writeFileAtomic(path, JSON.stringify(archive, null, 2) + '\n', { mode: 0o600 });
}

/** Freshly read file metadata for both worker context and mandatory Jev checks.
 * Full archived source contents never enter this projection. */
export function readPrivateReceiptArchives(contract: ArchiveOwner) {
  if (!contract.units?.some(unit => unit.files.includes(`.goodvibes/reviews/${contract.id}/source-receipts.json`))) return [];
  const path = archivePath(contract);
  if (!path || !existsSync(path)) return [];
  const bytes = readFileSync(path);
  const archive = JSON.parse(bytes.toString('utf8')) as { version?: unknown; kind?: unknown; contractId?: unknown; inputId?: unknown;
    units?: { id: string; observations: { path: string; returnedRanges: string[]; returnedContent?: string; contentKind?: string }[] }[] };
  if (archive.version !== 1 || archive.kind !== 'contract-read-receipts' || archive.contractId !== contract.id
    || archive.inputId !== (contract.inputSnapshot?.id ?? null) || !Array.isArray(archive.units)) throw new Error('Private receipt archive has an unrecognized owner or format');
  return [{ kind: 'contract-read-receipts', path: `.goodvibes/reviews/${contract.id}/source-receipts.json`,
    digest: `sha256-base64url:${createHash('sha256').update(bytes).digest('base64url')}`, bytes: bytes.length,
    archivedUnits: archive.units.map(unit => ({ id: unit.id, observations: unit.observations.length,
      retainedReferences: unit.observations.filter(read => read.contentKind === 'declared-reference' && read.returnedContent !== undefined).map(read => read.path) })),
    meaning: 'The native host has preserved these actual earlier read observations and complete retained reference contents in private storage outside the disposable worktree. Reserved .goodvibes writes and reads remain unavailable to captured workers. Use this storage receipt and the supplied host records to remove public raw ledgers; do not try to write reserved state. Substantive findings and citations remain public. This is not acceptance of this unit or final answer.',
  }];
}

/** Only a native check of the private-storage obligation receives relevant
 * primary contents. Worker prompts keep the metadata-only projection above. */
export function readNativePrivateReceiptArchives(contract: ArchiveOwner, files: readonly string[]) {
  const receipts = readPrivateReceiptArchives(contract);
  if (!receipts.length || !files.includes(`.goodvibes/reviews/${contract.id}/source-receipts.json`)) return receipts;
  const bytes = readFileSync(archivePath(contract)!);
  const digest = `sha256-base64url:${createHash('sha256').update(bytes).digest('base64url')}`;
  if (digest !== receipts[0]!.digest) throw new Error('Private receipt archive changed while preparing native evidence');
  const archive = JSON.parse(bytes.toString('utf8')) as { units: { id: string; latestCheckId: string | null;
    observations: { path: string; returnedRanges: string[]; returnedLines: number; contentKind?: string; returnedContent?: string }[] }[] };
  const references = new Map<string, { unitId: string; checkedAt: string | null; path: string; returnedRanges: string[]; returnedLines: number; returnedContent: string }>();
  for (const unit of archive.units) for (const read of unit.observations) {
    if (read.contentKind !== 'declared-reference' || read.returnedContent === undefined) continue;
    const path = files.find(path => !path.startsWith('.goodvibes/') && (read.path === path || read.path.endsWith('/' + path)));
    if (path) references.set(path, { unitId: unit.id, checkedAt: unit.latestCheckId, path: read.path,
      returnedRanges: read.returnedRanges, returnedLines: read.returnedLines, returnedContent: read.returnedContent });
  }
  return receipts.map(receipt => ({ ...receipt, retainedPrivateReferences: [...references.values()],
    nativeEvidenceMeaning: 'Actual primary reference contents freshly loaded from the private archive whose bytes match this storage receipt. Compare the removed public ledger and attribution with these retained snapshots. They establish what was preserved, not a new source inspection or approval of this candidate. These private contents are supplied only to this native check, never worker prompts or public delivery artifacts.',
  }));
}
