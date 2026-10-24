import { execFile } from 'node:child_process';
import { readdir, lstat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { buildGlobMatcher } from '../utils/glob-to-regex.js';
import type { ContractView, ContractUnitView } from './types.js';
import type { JsonValue } from '@goodvibes-jev/judgment';

const executeFile = promisify(execFile);
const runtimeDirectories = new Set(['.git', '.goodvibes', '.plat', 'node_modules', '.venv']);

export interface ReviewInventory {
  readonly paths: readonly string[];
  readonly digest: string;
  readonly source: 'git' | 'filesystem';
  readonly errors: readonly string[];
}

/** Inventory filenames, without reading source bodies or asking a model. */
export async function captureReviewInventory(root: string, signal?: AbortSignal): Promise<ReviewInventory> {
  const paths = new Set<string>(), errors: string[] = [];
  let source: ReviewInventory['source'] = 'git';
  const included = (path: string) => !path.split('/').some(part => runtimeDirectories.has(part));
  try {
    const result = await executeFile('git', ['-c', 'core.fsmonitor=false', '-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...(signal ? { signal } : {}) });
    for (const path of result.stdout.split('\0')) if (path && included(path)) paths.add(path);
  } catch {
    signal?.throwIfAborted();
    source = 'filesystem';
    const walk = async (directory: string): Promise<void> => {
      signal?.throwIfAborted();
      try {
        for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
          const path = directory ? directory + '/' + entry.name : entry.name;
          if (!included(path)) continue;
          if (entry.isDirectory()) await walk(path);
          else if (entry.isFile() || entry.isSymbolicLink()) paths.add(path);
        }
      } catch (error) {
        signal?.throwIfAborted();
        errors.push(`${directory || '.'}: ${(error as NodeJS.ErrnoException).code ?? 'unavailable'}`);
      }
    };
    await walk('');
  }
  // Git also lists tracked deletions. They are changes, not present files.
  const present: string[] = [];
  for (const path of paths) {
    signal?.throwIfAborted();
    try { const entry = await lstat(resolve(root, path)); if (entry.isFile() || entry.isSymbolicLink()) present.push(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors.push(`${path}: ${(error as NodeJS.ErrnoException).code ?? 'unavailable'}`); }
  }
  present.sort();
  return { paths: present, digest: createHash('sha256').update(JSON.stringify(present)).digest('hex'), source, errors };
}

/**
 * A bounded planner presentation. Small inventories list every exact path;
 * large ones list directory groups with exact counts, so one planning request
 * never embeds hundreds of thousands of path characters. Host coverage checks
 * always compare exact paths, and repair messages name actual missed files.
 */
export function reviewInventoryPlannerView(inventory: ReviewInventory, budget = 60_000): JsonValue {
  const base = { digest: inventory.digest, source: inventory.source, errors: [...inventory.errors], totalFiles: inventory.paths.length };
  if (JSON.stringify(inventory.paths).length <= budget) return { ...base, paths: [...inventory.paths] };
  const group = (depth: number) => {
    const directories = new Map<string, { files: number; extensions: Map<string, number> }>();
    for (const path of inventory.paths) {
      const parts = path.split('/');
      const directory = parts.length === 1 ? '.' : parts.slice(0, Math.min(depth, parts.length - 1)).join('/');
      const name = parts.at(-1)!, dot = name.lastIndexOf('.');
      const extension = dot > 0 ? name.slice(dot) : '(none)';
      const entry = directories.get(directory) ?? { files: 0, extensions: new Map<string, number>() };
      entry.files++;
      entry.extensions.set(extension, (entry.extensions.get(extension) ?? 0) + 1);
      directories.set(directory, entry);
    }
    return [...directories.entries()].sort(([left], [right]) => left < right ? -1 : 1)
      .map(([directory, entry]) => ({ directory, files: entry.files, extensions: Object.fromEntries([...entry.extensions.entries()].sort(([, a], [, b]) => b - a)) }));
  };
  for (let depth = 6; depth >= 1; depth--) {
    const directories = group(depth);
    if (depth > 1 && JSON.stringify(directories).length > budget) continue;
    return { ...base, directories,
      meaning: 'The exact file list is too large for one request, so files are grouped by directory with exact counts. Assign scope with directory paths or globs; the host checks coverage against the exact inventory and names any actually unassigned files in repair feedback.' };
  }
  return base;
}

export function reviewProjectPath(root: string, path: string): string | undefined {
  const normalized = relative(root, resolve(root, path)).replaceAll('\\', '/');
  return normalized && normalized !== '..' && !normalized.startsWith('../') ? normalized : undefined;
}

export function assignedReviewPaths(inventory: ReviewInventory, patterns: readonly string[]): string[] {
  const matches = patterns.map(pattern => ({ path: pattern.replace(/\/$/, ''), match: buildGlobMatcher(pattern) }));
  return inventory.paths.filter(path => matches.some(pattern => pattern.path === '.' || path === pattern.path || path.startsWith(pattern.path + '/') || pattern.match(path)));
}

/** Reads and native accepted assessments are separate facts. A prior check
 * applies only to the exact file version it received, never a changed file. */
export function reviewInventoryObservation(contract: Pick<ContractView, 'projectRoot' | 'units' | 'reviewInventory'> & Partial<Pick<ContractView, 'reviewExclusions'>>,
  currentFiles: readonly JsonValue[] = []) {
  const inventory = contract.reviewInventory;
  if (!inventory) return undefined;
  const versions = new Map<string, string | null>();
  for (const value of currentFiles) if (value && typeof value === 'object' && !Array.isArray(value)
    && value['operation'] === 'read-current-file' && value['source'] === 'native-host-filesystem' && typeof value['path'] === 'string') {
    versions.set(value['path'], value['success'] === true && typeof value['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(value['sha256']) ? value['sha256'] : null);
  }
  const excluded = new Map<string, string[]>();
  for (const exclusion of contract.reviewExclusions ?? []) for (const path of assignedReviewPaths(inventory, exclusion.files)) {
    const reasons = excluded.get(path) ?? []; reasons.push(exclusion.reason); excluded.set(path, reasons);
  }
  const accepted = new Map<string, { unitId: string; checkId: string; sha256: string; criteria: string[]; state: string }[]>();
  for (const unit of contract.units) {
    const check = unit.checks.at(-1);
    if (unit.role !== 'research' || unit.status !== 'passed' || check?.result !== 'pass' || !check.decisionIds.length) continue;
    for (const file of check.reviewedFiles ?? []) {
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) continue;
      const records = accepted.get(file.path) ?? [];
      records.push({ unitId: unit.id, checkId: check.id, sha256: file.sha256, criteria: unit.criteria.map(criterion => criterion.id),
        state: versions.get(file.path) === file.sha256 ? 'current' : versions.has(file.path) ? 'changed' : 'version-unchecked' });
      accepted.set(file.path, records);
    }
  }
  const inspections = new Map<string, { unit: ContractUnitView; ranges: readonly string[] }[]>();
  for (const unit of contract.units) for (const read of unit.readEvidence ?? []) {
    const path = reviewProjectPath(contract.projectRoot, read.path);
    if (!path) continue;
    const records = inspections.get(path) ?? [];
    records.push({ unit, ranges: read.returnedRanges }); inspections.set(path, records);
  }
  const files = inventory.paths.map(path => {
    const exclusionReasons = excluded.get(path) ?? [];
    const reads = inspections.get(path) ?? [];
    const assessments = accepted.get(path) ?? [];
    return { path, scope: exclusionReasons.length ? 'excluded' : 'included', exclusionReasons, inspection: reads.length ? 'inspected' : 'uninspected',
      observations: reads.map(read => ({ unitId: read.unit.id, ranges: [...read.ranges] })),
      assessment: assessments.some(assessment => assessment.state === 'current') ? 'reviewed'
        : assessments.some(assessment => assessment.state === 'version-unchecked') ? 'version-unchecked' : assessments.length ? 'changed' : 'unreviewed', assessments };
  });
  return { inventoryDigest: inventory.digest, source: inventory.source, errors: [...inventory.errors],
    totalFiles: files.length, inspectedFiles: files.filter(file => file.inspection === 'inspected').length,
    reviewedFiles: files.filter(file => file.assessment === 'reviewed').length,
    remainingFiles: files.filter(file => file.scope === 'included' && ['unreviewed', 'changed'].includes(file.assessment)).map(file => file.path),
    versionChecksPending: files.filter(file => file.scope === 'included' && file.assessment === 'version-unchecked').map(file => file.path), files,
    meaning: 'Native project inventory compared with actual read observations and accepted scoped research checks. Inspected never means reviewed. A reviewed entry requires a passed native assessment and matching current file SHA256. Changed or unknown versions remain open. File inventory is not an instruction to review unrelated files: the original requested scope and any explicitly justified exclusions remain controlling. These facts never approve the final response.' };
}

/** Counting and matching identities are host bookkeeping. Keep the exact gap
 * list, without sending all completed file records through every Jev request. */
export function compactReviewInventory(observation: NonNullable<ReturnType<typeof reviewInventoryObservation>>) {
  const { files, ...summary } = observation;
  return { ...summary, manifestDigest: createHash('sha256').update(JSON.stringify(files)).digest('hex'),
    excludedFiles: files.filter(file => file.scope === 'excluded').map(file => ({ path: file.path, reasons: file.exclusionReasons })),
    acceptedAssessments: [...new Map(files.flatMap(file => file.assessments.map(assessment => [assessment.checkId, {
      unitId: assessment.unitId, checkId: assessment.checkId, criteria: assessment.criteria,
    }] as const))).values()],
    meaning: summary.meaning + ' This compact view preserves exact pending paths and explicit exclusions. Completed per-file records remain in the native inventory and unit checks under manifestDigest; counts and identity comparisons are computed by the host, never asserted by a model.' };
}
