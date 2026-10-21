import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeFileAtomic } from '../utils/atomic-json-store.js';
import type { ContractView } from './types.js';
import type { QualityGateResult } from './gates.js';
import type { JsonValue } from '@goodvibes-jev/judgment';
import { ownerEvidenceIdentity } from './owner-evidence.js';

type ArchiveOwner = Pick<ContractView, 'id'> & Partial<Pick<ContractView, 'projectRoot' | 'inputSnapshot' | 'units' | 'groups'>>;

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
export function preserveDeclaredReadReceipts(contract: ArchiveOwner, ownerEvidence?: JsonValue): void {
  const relativePath = `.goodvibes/reviews/${contract.id}/source-receipts.json`;
  if (!contract.units?.some(unit => unit.files.includes(relativePath)
    && (unit.dependsOn ?? []).every(id => contract.units?.some(source => source.id === id && source.status === 'passed'))
    && (contract.groups?.find(group => group.id === unit.groupId)?.dependsOn ?? []).every(id => contract.groups?.some(group => group.id === id && group.status === 'passed')))) return;
  const path = archivePath(contract);
  if (!path) return;
  let previous: { units: { id: string; latestCheckId: string | null; observations: NonNullable<ContractView['units'][number]['readEvidence']> }[]; ownerObservations?: JsonValue[] } | undefined;
  if (existsSync(path)) {
    readPrivateReceiptArchives(contract);
    previous = JSON.parse(readFileSync(path, 'utf8')) as NonNullable<typeof previous>;
  }
  const accepted = contract.units.filter(unit => unit.status === 'passed' && (unit.readEvidence?.length ?? 0) > 0);
  if (accepted.length === 0) return;
  const additions = accepted.filter(unit => !previous?.units.some(saved => saved.id === unit.id));
  const owners = previous?.ownerObservations ?? [];
  const newOwner = ownerEvidence !== undefined && !owners.some(saved => JSON.stringify(ownerEvidenceIdentity(saved)) === JSON.stringify(ownerEvidenceIdentity(ownerEvidence)));
  if (previous && additions.length === 0 && !newOwner) return;
  const archive = { version: 1, kind: 'contract-read-receipts', contractId: contract.id,
    inputId: contract.inputSnapshot?.id ?? null,
    meaning: 'Exact host-retained observations and reference contents from accepted units, preserved privately before public receipt ledgers are removed. This is storage, not approval or a new source inspection.',
    units: [...(previous?.units ?? []), ...additions.map(unit => ({
      id: unit.id, latestCheckId: unit.checks.at(-1)?.id ?? null,
      observations: unit.readEvidence ?? [],
    }))],
    ...(owners.length || newOwner ? { ownerObservations: [...owners, ...(newOwner ? [ownerEvidence!] : [])] } : {}),
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
    hostFileRead: { operation: 'read-file', source: 'native-host-filesystem', success: true,
      ownerProjectRoot: contract.projectRoot!, absolutePath: path, bytes: bytes.length,
      digest: `sha256-base64url:${createHash('sha256').update(bytes).digest('base64url')}`,
      modifiedAt: new Date(lstatSync(path).mtimeMs).toISOString(), mode: (lstatSync(path).mode & 0o777).toString(8),
      meaning: 'Actual successful host filesystem read of the private archive outside the disposable worker tree. The returned file passed owner/input binding validation. It establishes stored contents and file identity; it is not a worker write, test execution, native acceptance or permission to alter runtime state.',
    },
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
    archivedReadObservations: archive.units.map(unit => ({ unitId: unit.id, checkedAt: unit.latestCheckId,
      observations: unit.observations.map(read => ({ path: read.path, returnedRanges: read.returnedRanges, returnedLines: read.returnedLines })) })),
    nativeEvidenceMeaning: 'Actual primary reference contents freshly loaded from the private archive whose bytes match this storage receipt. Compare the removed public ledger and attribution with these retained snapshots. They establish what was preserved, not a new source inspection or approval of this candidate. These private contents are supplied only to this native check, never worker prompts or public delivery artifacts.',
  }));
}

/** Factual preservation is a byte/provenance check, not a model judgment. */
export function verifyPrivateReceiptPreservation(contract: ArchiveOwner, unit: Pick<ContractView['units'][number], 'files' | 'baseline'>, cwd: string): QualityGateResult | undefined {
  if (!unit.files.includes(`.goodvibes/reviews/${contract.id}/source-receipts.json`)) return undefined;
  const start = performance.now();
  try {
    const receipt = readPrivateReceiptArchives(contract)[0];
    if (!receipt) throw new Error('Declared private receipt archive is missing');
    if (receipt.hostFileRead.mode !== '600') throw new Error('Private receipt archive permissions are not owner-only');
    const archive = JSON.parse(readFileSync(archivePath(contract)!, 'utf8')) as { units: { id: string; latestCheckId: string | null; observations: { path: string; contentKind?: string; returnedContent?: string }[] }[] };
    if (!archive.units.some(unit => unit.observations.length > 0)) throw new Error('Private archive contains no accepted read observations');
    for (const saved of archive.units) {
      const actual = contract.units?.find(unit => unit.id === saved.id);
      if (!actual || actual.status !== 'passed' || !actual.checks.some(check => check.id === saved.latestCheckId && check.result === 'pass')
        || JSON.stringify(actual.readEvidence ?? []) !== JSON.stringify(saved.observations)) throw new Error('Archived observations differ from their original accepted host records');
    }
    const referenceChecks: { path: string; sourceUnitId: string; baselineDigest: string; archivedDigest: string; identical: boolean }[] = [];
    if (unit.baseline?.head) {
      for (const path of unit.files.filter(path => !path.startsWith('.goodvibes/') && /(?:\.md|\.json|\.txt|SHA256SUMS)$/.test(path))) {
        const result = spawnSync('git', ['-C', cwd, 'show', `${unit.baseline.head}:${path}`], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
        if (result.status !== 0) continue; // A newly created file held no previous public ledger.
        const original = result.stdout.replace(/\r\n/g, '\n').replace(/\n$/, '');
        let matched: { id: string; text: string } | undefined;
        for (const saved of archive.units) for (const read of saved.observations) {
          if (read.contentKind !== 'declared-reference' || read.returnedContent === undefined || !(read.path === path || read.path.endsWith('/' + path))) continue;
          const text = read.returnedContent.split('\n').map(line => line.replace(/^\s*\d+\s*\| ?/, '')).join('\n').replace(/\r\n/g, '\n').replace(/\n$/, '');
          if (text === original) matched = { id: saved.id, text };
        }
        if (!matched) throw new Error(`The original public reference ${path} has no exact preserved private snapshot`);
        const digest = (text: string) => `sha256-base64url:${createHash('sha256').update(text).digest('base64url')}`;
        referenceChecks.push({ path, sourceUnitId: matched.id, baselineDigest: digest(original), archivedDigest: digest(matched.text), identical: true });
      }
    }
    return { gate: 'private-read-receipt-preservation', passed: true, durationMs: performance.now() - start,
      output: JSON.stringify({ operation: 'native-host-private-preservation-check', success: true,
        privateFileRead: receipt.hostFileRead, acceptedSourceUnitsVerified: archive.units.length,
        originalReadRecordsIdentical: true, baseline: unit.baseline?.head ?? null, referenceChecks,
        meaning: 'Actual filesystem/provenance comparisons passed. Original declared public reference text is preserved exactly after removing read-tool line-number prefixes and normalizing line endings and one terminal newline. This proves retention, not a new inspection or semantic acceptance. Public edits, citations and final output still require native Jev review.' }) };
  } catch (error) {
    return { gate: 'private-read-receipt-preservation', passed: false, durationMs: performance.now() - start,
      output: error instanceof Error ? error.message : 'Private receipt preservation could not be verified' };
  }
}
