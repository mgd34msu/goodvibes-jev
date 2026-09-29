/**
 * The analyze modes whose findings are read by Jev: `security` (secrets,
 * env files, world-writable files) and `permissions` (dangerous calls). Each
 * file's lines are read in blocks by an existence check
 * (`engine.tools.secret-line`, `engine.tools.dangerous-line`; see
 * scan-lines.ts) that finds the lines to look at; `engine.tools.secret-finding`
 * and `engine.tools.dangerous-call` then decide what is reported and how
 * severe it is. The env-file list and the world-writable mode bit are facts
 * about the file system (a file exists, a permission bit is set), reported as
 * they are.
 */
import { stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { Existence, YesNoReading } from '@goodvibes-jev/judgment';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { scanCandidateView, secretFinding } from '../batteries/secret-finding.js';
import { dangerousCall, type DangerSeverity } from '../batteries/dangerous-call.js';
import { secretLine, secretLineQuery } from '../batteries/secret-line.js';
import { dangerousLine, dangerousLineQuery } from '../batteries/dangerous-line.js';
import { findScanLines, scanBlocks } from './scan-lines.js';
import type { AnalyzeInput } from './types.js';
import {
  MAX_SCAN_FILES,
  MAX_SCAN_MS,
  collectExistingPaths,
  collectTextFiles,
  readTextFile,
  resolveScanRoot,
} from './shared.js';

const SECRET_SITE = 'tools.analyze.secret-finding';
const DANGER_SITE = 'tools.analyze.dangerous-call';
const SECRET_LINE_SITE = 'tools.analyze.secret-line';
const DANGER_LINE_SITE = 'tools.analyze.dangerous-line';
/** Blocks and candidates read at once during a scan. */
const SCAN_READ_CONCURRENCY = 8;

/** How a reported finding's reading stands: a yes, or a reading that is neither yes nor no. */
type FindingReading = 'real' | 'uncertain';

/** A yes reports the candidate as real, a no dismisses it, anything else reports it as needing review. */
function findingReading(reading: YesNoReading): FindingReading | 'dismissed' {
  if (reading.verdict === 'yes') return 'real';
  return reading.verdict === 'no' ? 'dismissed' : 'uncertain';
}

interface ScanCandidate {
  readonly file: string;
  readonly lines: readonly string[];
  readonly index: number;
}

interface ScannedFile {
  readonly file: string;
  readonly lines: readonly string[];
}

/** The candidate lines of every file: the lines the existence check finds in each block. */
async function scanCandidates(files: readonly ScannedFile[], existence: Existence, site: string, query: (file: string) => string): Promise<ScanCandidate[]> {
  const blocks = files.flatMap((scanned) => scanBlocks(scanned.lines).map((block) => ({ scanned, block })));
  const found = await mapWithConcurrency(blocks, SCAN_READ_CONCURRENCY, ({ scanned, block }) => findScanLines(existence, site, query(scanned.file), block));
  return blocks.flatMap(({ scanned }, index) => found[index]!.map((line) => ({ file: scanned.file, lines: scanned.lines, index: line })));
}

/** The matched line as the report shows it. */
const matchText = (candidate: ScanCandidate, max: number): string => (candidate.lines[candidate.index] ?? '').trim().slice(0, max);

export async function runSecurity(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const scope = input.securityScope ?? 'all';
  const results: Record<string, unknown> = {};
  const scanRoot = resolveScanRoot(input, projectRoot);

  if (scope === 'secrets' || scope === 'all') {
    const scanned: ScannedFile[] = [];
    for (const file of await collectTextFiles(scanRoot)) {
      const content = await readTextFile(file);
      if (content !== null) scanned.push({ file: relative(projectRoot, file), lines: content.split('\n') });
    }
    const candidates = await scanCandidates(scanned, secretLine, SECRET_LINE_SITE, secretLineQuery);

    const readings = await mapWithConcurrency(candidates, SCAN_READ_CONCURRENCY, async (candidate) => {
      const run = await secretFinding.run(judgmentPort(SECRET_SITE), scanCandidateView(candidate.file, candidate.lines, candidate.index), { site: SECRET_SITE });
      const reading = findingReading(run.readings.real_secret);
      run.recordAction(reading === 'dismissed' ? 'dismissed' : `reported as ${reading}`);
      return reading;
    });
    const findings = candidates.flatMap((candidate, index) => {
      const reading = readings[index]!;
      return reading === 'dismissed'
        ? []
        : [{ file: candidate.file, line: candidate.index + 1, match: matchText(candidate, 60), reading }];
    });

    results.secrets = { findings, count: findings.length, dismissed: candidates.length - findings.length };
  }

  if (scope === 'env' || scope === 'all') {
    results.env = {
      files_found: collectExistingPaths(projectRoot, ['.env', '.env.local', '.env.development', '.env.production']),
    };
  }

  if (scope === 'permissions' || scope === 'all') {
    const suspicious: string[] = [];
    const files = await collectTextFiles(scanRoot);
    for (const file of files) {
      try {
        const info = await stat(file);
        if ((info.mode & 0o002) !== 0) {
          suspicious.push(relative(projectRoot, file));
        }
      } catch {
        continue;
      }
    }
    results.permissions = { world_writable: suspicious, count: suspicious.length };
  }

  return results;
}

export async function runPermissions(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const scanRoot = resolveScanRoot(input, projectRoot);
  const deadline = Date.now() + MAX_SCAN_MS;
  const files = await collectTextFiles(scanRoot, MAX_SCAN_FILES, deadline);
  const scanned: ScannedFile[] = [];

  for (const file of files) {
    if (Date.now() > deadline) break;
    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      continue;
    }
    scanned.push({ file: relative(projectRoot, file), lines: content.split('\n') });
  }
  const candidates = await scanCandidates(scanned, dangerousLine, DANGER_LINE_SITE, dangerousLineQuery);

  const readings = await mapWithConcurrency(candidates, SCAN_READ_CONCURRENCY, async (candidate) => {
    const run = await dangerousCall.run(judgmentPort(DANGER_SITE), scanCandidateView(candidate.file, candidate.lines, candidate.index), { site: DANGER_SITE });
    const reading = findingReading(run.readings.risky);
    const rated = run.readings.severity.outcome !== 'escalate';
    const severity: DangerSeverity | 'unrated' = rated ? run.readings.severity.choice : 'unrated';
    run.recordAction(reading === 'dismissed' ? 'dismissed' : `reported as ${reading}, ${severity}`);
    return { reading, severity };
  });
  const findings = candidates.flatMap((candidate, index) => {
    const { reading, severity } = readings[index]!;
    return reading === 'dismissed'
      ? []
      : [{ file: candidate.file, line: candidate.index + 1, severity, reading, match: matchText(candidate, 100) }];
  });

  const byFile: Record<string, number> = {};
  for (const f of findings) {
    byFile[f.file] = (byFile[f.file] ?? 0) + 1;
  }

  return {
    findings,
    total: findings.length,
    dismissed: candidates.length - findings.length,
    files_affected: Object.keys(byFile).length,
    by_severity: {
      high: findings.filter((f) => f.severity === 'high').length,
      medium: findings.filter((f) => f.severity === 'medium').length,
      low: findings.filter((f) => f.severity === 'low').length,
      unrated: findings.filter((f) => f.severity === 'unrated').length,
    },
  };
}

