/**
 * The analyze modes whose findings are read by Jev: `security` (secrets,
 * env files, world-writable files) and `permissions` (dangerous calls). Shape
 * patterns only shortlist candidate lines; `engine.tools.secret-finding` and
 * `engine.tools.dangerous-call` decide what is reported and how severe it is.
 * The env-file list and the world-writable mode bit are facts about the file
 * system (a file exists, a permission bit is set), reported as they are.
 */
import { stat } from 'node:fs/promises';
import { relative } from 'node:path';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { scanCandidateView, secretFinding } from '../batteries/secret-finding.js';
import { dangerousCall, type DangerSeverity } from '../batteries/dangerous-call.js';
import type { AnalyzeInput } from './types.js';
import {
  MAX_SCAN_FILES,
  MAX_SCAN_MS,
  collectExistingPaths,
  collectTextFiles,
  readTextFile,
  resolveScanRoot,
} from './shared.js';

/**
 * Shape patterns that choose which lines the secret reading looks at (the
 * shortlist). They never decide what is reported: every candidate is read by
 * `engine.tools.secret-finding`.
 */
const SECRET_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'api_key_prefix', regex: /['"](?:sk-|pk_|ak_|AKIA)[a-zA-Z0-9]{20,}['"]/ },
  { name: 'token_assignment', regex: /(?:token|secret|password|api_key)\s*[:=]\s*['"][^'"]{8,}['"]/i },
  { name: 'aws_access_key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'private_key', regex: /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/ },
];

const SECRET_SITE = 'tools.analyze.secret-finding';
const DANGER_SITE = 'tools.analyze.dangerous-call';
/** Candidates read at once during a scan. */
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
  readonly pattern: string;
  readonly match: string;
}

export async function runSecurity(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const scope = input.securityScope ?? 'all';
  const results: Record<string, unknown> = {};
  const scanRoot = resolveScanRoot(input, projectRoot);

  if (scope === 'secrets' || scope === 'all') {
    const candidates: ScanCandidate[] = [];
    const files = await collectTextFiles(scanRoot);

    for (const file of files) {
      const content = await readTextFile(file);
      if (content === null) continue;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const hit = SECRET_PATTERNS.map(({ name, regex }) => ({ name, m: (lines[i] ?? '').match(regex) })).find(({ m }) => m !== null);
        if (hit?.m) candidates.push({ file: relative(projectRoot, file), lines, index: i, pattern: hit.name, match: hit.m[0].slice(0, 60) });
      }
    }

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
        : [{ file: candidate.file, line: candidate.index + 1, pattern: candidate.pattern, match: candidate.match, reading }];
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

/**
 * Call-shape patterns that choose which lines the danger reading looks at
 * (the shortlist). Whether a match is risky and how severe it is are read by
 * `engine.tools.dangerous-call`, never assigned per pattern.
 */
const DANGEROUS_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'eval', regex: /\beval\s*\(/ },
  { name: 'new_Function', regex: /\bnew\s+Function\s*\(/ },
  { name: 'child_process_exec', regex: /\bexec\s*\(|\bexecSync\s*\(|\bspawn\s*\(/ },
  { name: 'fs_chmod_777', regex: /chmod\s*\([^)]*0?777/ },
  { name: 'dangerouslySetInnerHTML', regex: /dangerouslySetInnerHTML/ },
  { name: 'document_write', regex: /\bdocument\.write\s*\(/ },
  { name: 'innerHTML_assign', regex: /\.innerHTML\s*=(?!=)/ },
  { name: 'unsafe_regex', regex: /new\s+RegExp\s*\(\s*[^"'`]/ },
];

export async function runPermissions(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const scanRoot = resolveScanRoot(input, projectRoot);
  const deadline = Date.now() + MAX_SCAN_MS;
  const files = await collectTextFiles(scanRoot, MAX_SCAN_FILES, deadline);
  const candidates: ScanCandidate[] = [];

  for (const file of files) {
    if (Date.now() > deadline) break;
    let content: string;
    try {
      content = await Bun.file(file).text();
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const hit = DANGEROUS_PATTERNS.find(({ regex }) => regex.test(lines[i] ?? ''));
      if (hit) {
        candidates.push({ file: relative(projectRoot, file), lines, index: i, pattern: hit.name, match: (lines[i] ?? '').trim().slice(0, 100) });
      }
    }
  }

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
      : [{ file: candidate.file, line: candidate.index + 1, pattern: candidate.pattern, severity, reading, match: candidate.match }];
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

