import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GitService } from '../../git/service.js';
import type { ToolLLM } from '../../config/tool-llm.js';
import type { AnalyzeInput, SemanticDiffSummary } from './types.js';
import { summarizeError } from '../../utils/error-display.js';
import {
  isBreakingUpgrade,
  loadDependencyVersions,
  parseDiffStats,
  parseSemver,
  readJsonFile,
  truncateDiffAtBoundary,
  validateGitRefs,
} from './shared.js';
import { instrumentedFetch } from '../../utils/fetch-with-timeout.js';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { MAX_JUDGED_DIFF_CHARS, semanticDiff, semanticDiffView } from '../batteries/semantic-diff.js';
import { exportBreak, exportBreakView } from '../batteries/export-break.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';

const SEMANTIC_DIFF_SITE = 'tools.analyze.semantic-diff';
const EXPORT_BREAK_SITE = 'tools.analyze.export-break';
/** Changed exports read at once during a breaking-change check. */
const EXPORT_READ_CONCURRENCY = 8;

// 1.2 s, warm `git status` cache response budget; keeps the semantic-diff summary probe non-blocking
const GIT_PROBE_TIMEOUT_MS = 1200;

type SemanticDiffRisk = SemanticDiffSummary['risk'];

/**
 * The risk tier, composed from the two facts Jev read about the diff
 * (tools/batteries/semantic-diff.ts): breaking a caller is high, changing
 * what existing code does is medium, neither is low. A fact the reading is
 * not confident is absent (verdict uncertain) counts toward the higher tier,
 * so doubt shows as risk rather than hiding it.
 */
export function semanticDiffRisk(readings: {
  readonly breaks_callers: YesNoReading;
  readonly changes_behavior: YesNoReading;
}): SemanticDiffRisk {
  const present = (reading: YesNoReading): boolean => reading.verdict !== 'no';
  if (present(readings.breaks_callers)) return 'high';
  if (present(readings.changes_behavior)) return 'medium';
  return 'low';
}

/**
 * Whether a changed export breaks its callers, composed from the two facts
 * Jev read about it (tools/batteries/export-break.ts): either yes is
 * breaking, both no is safe, anything else is uncertain.
 */
export function exportBreakVerdict(readings: {
  readonly inputs_break: YesNoReading;
  readonly output_breaks: YesNoReading;
}): 'breaking' | 'safe' | 'uncertain' {
  const facts = [readings.inputs_break.verdict, readings.output_breaks.verdict];
  if (facts.includes('yes')) return 'breaking';
  return facts.every((verdict) => verdict === 'no') ? 'safe' : 'uncertain';
}

/** Summary prose built from the readings when the helper model wrote none. */
function summaryFromReadings(changedFiles: readonly string[], risk: SemanticDiffRisk): string {
  const files = changedFiles.length === 0
    ? 'No changed files were detected in the requested diff.'
    : changedFiles.length === 1 ? `Changed ${changedFiles[0]}.` : `Changed ${changedFiles.length} files.`;
  const effect = risk === 'high'
    ? 'Callers of the changed code may have to change too.'
    : risk === 'medium'
      ? 'Existing code behaves differently after this change.'
      : 'The change neither breaks callers nor changes existing behavior.';
  return `${files} ${effect}`;
}

/**
 * The helper model's summary and impact list. Only the prose is taken from
 * its reply; the risk tier is never parsed from it.
 */
function parseSemanticDiffProse(reply: string): { summary?: string; impact?: string[] } {
  try {
    const cleaned = reply.replace(/^```(?:json)?\s*/m, '').replace(/\s*```$/m, '').trim();
    const parsed = JSON.parse(cleaned) as { summary?: unknown; impact?: unknown };
    return {
      ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
      ...(Array.isArray(parsed.impact) ? { impact: parsed.impact.map((item) => String(item)) } : {}),
    };
  } catch {
    return { summary: reply.slice(0, 500) };
  }
}

async function trySemanticDiffLlm(
  toolLLM: Pick<ToolLLM, 'chat'>,
  prompt: string,
): Promise<string> {
  try {
    return await Promise.race([
      toolLLM.chat(prompt, { maxTokens: 512 }),
      new Promise<string>((resolve) => {
        const timer = setTimeout(() => resolve(''), GIT_PROBE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch {
    return '';
  }
}

export async function runDiff(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const before = input.before ?? 'HEAD~1';
  const after = input.after ?? 'HEAD';

  const refError = validateGitRefs(before, after);
  if (refError) return refError;

  const git = new GitService(projectRoot);

  let statOutput: string;
  try {
    statOutput = await git.diffStat(before, after);
  } catch (err) {
    return { error: `git diff failed: ${summarizeError(err)}`, before, after };
  }

  let fullDiff: string;
  try {
    fullDiff = await git.diffBetween(before, after, input.files);
  } catch {
    fullDiff = '';
  }

  return {
    before,
    after,
    stat: statOutput.trim(),
    files: parseDiffStats(statOutput),
    diff: fullDiff.slice(0, 10000),
  };
}

function extractSignaturesFromDiff(diff: string): {
  before: Map<string, string>;
  after: Map<string, string>;
} {
  const before = new Map<string, string>();
  const after = new Map<string, string>();

  const lines = diff.split('\n');
  const exportLinePattern =
    /^([+-])\s*export\s+(?:(?:async|default|declare)\s+)*(?:function\*?|class|const|let|var|type|interface|enum)\s+(\w+)(.*)/;

  for (let i = 0; i < lines.length; i++) {
    const m = (lines[i] ?? '').match(exportLinePattern);
    if (!m) continue;

    const marker = (m[1] ?? '+') as '-' | '+'; // regex group 1 is always present when m matches
    const name = m[2] ?? '';
    let rest = m[3];

    if (!rest?.includes('{') && !rest?.includes(';')) {
      for (let j = i + 1; j < lines.length; j++) {
        const contLine = lines[j] ?? '';
        if (!contLine.startsWith(marker) && !contLine.startsWith(' ')) break;
        const stripped = contLine.startsWith(marker)
          ? contLine.slice(1)
          : contLine.slice(1);
        rest += ' ' + stripped.trim();
        if (stripped.includes('{') || stripped.includes(';')) break;
      }
    }

    const braceIdx = rest?.indexOf('{') ?? -1;
    const sig = `${name}${braceIdx >= 0 ? (rest ?? '').slice(0, braceIdx).trimEnd() : (rest ?? '').replace(/;.*$/, '').trimEnd()}`;

    if (marker === '-') {
      before.set(name, sig);
    } else {
      after.set(name, sig);
    }
  }

  return { before, after };
}

export async function runBreaking(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  const before = input.before ?? 'HEAD~1';
  const after = input.after ?? 'HEAD';

  const refError = validateGitRefs(before, after);
  if (refError) return refError;

  const git = new GitService(projectRoot);

  let fullDiff: string;
  try {
    fullDiff = await git.diffBetween(before, after, input.files);
  } catch (err) {
    return { error: `git diff failed: ${summarizeError(err)}`, before, after };
  }

  const { before: beforeSigs, after: afterSigs } = extractSignaturesFromDiff(fullDiff);
  const breaking_changes: Array<{ name: string; before: string; after: string; reason: string; reading?: 'uncertain' }> = [];
  const additions: Array<{ name: string; signature: string }> = [];
  const safe_modifications: Array<{ name: string; before: string; after: string }> = [];
  const changed: Array<{ name: string; before: string; after: string }> = [];

  for (const [name, sig] of beforeSigs) {
    const newSig = afterSigs.get(name);
    if (newSig === undefined) {
      // The name is gone from the diff, so every caller that names it must change.
      breaking_changes.push({ name, before: sig, after: '(removed)', reason: 'export removed' });
    } else if (sig === newSig) {
      safe_modifications.push({ name, before: sig, after: newSig });
    } else {
      changed.push({ name, before: sig, after: newSig });
    }
  }

  // Whether a changed declaration breaks its callers is read per export; safe is listed as safe, anything else as breaking.
  const verdicts = await mapWithConcurrency(changed, EXPORT_READ_CONCURRENCY, async (change) => {
    const run = await exportBreak.run(judgmentPort(EXPORT_BREAK_SITE), exportBreakView(change.name, change.before, change.after), { site: EXPORT_BREAK_SITE });
    const verdict = exportBreakVerdict(run.readings);
    run.recordAction(`listed as ${verdict}`);
    return verdict;
  });
  changed.forEach((change, index) => {
    const verdict = verdicts[index]!;
    if (verdict === 'safe') safe_modifications.push(change);
    else if (verdict === 'breaking') breaking_changes.push({ ...change, reason: 'callers must change' });
    else breaking_changes.push({ ...change, reason: 'callers may have to change', reading: 'uncertain' });
  });

  for (const [name, sig] of afterSigs) {
    if (!beforeSigs.has(name)) {
      additions.push({ name, signature: sig });
    }
  }

  return {
    before,
    after,
    breaking_changes,
    additions,
    safe_modifications,
    total_breaking: breaking_changes.length,
    total_additions: additions.length,
  };
}

export async function runSemanticDiff(
  input: AnalyzeInput,
  projectRoot: string,
  toolLLM: Pick<ToolLLM, 'chat'>,
): Promise<Record<string, unknown>> {
  const before = input.before ?? 'HEAD~1';
  const after = input.after ?? 'HEAD';

  const refError = validateGitRefs(before, after);
  if (refError) return refError;

  const git = new GitService(projectRoot);

  let fullDiff: string;
  let statOutput: string;
  try {
    fullDiff = await git.diffBetween(before, after, input.files);
    statOutput = await git.diffStat(before, after);
  } catch (err) {
    return { error: `git diff failed: ${summarizeError(err)}`, before, after };
  }

  const changedFiles = parseDiffStats(statOutput).map((file) => file.file);
  const range = `${before}..${after}`;
  const judgedDiff = truncateDiffAtBoundary(fullDiff, MAX_JUDGED_DIFF_CHARS);
  const run = await semanticDiff.run(
    judgmentPort(SEMANTIC_DIFF_SITE),
    semanticDiffView(range, changedFiles, judgedDiff),
    { site: SEMANTIC_DIFF_SITE },
  );
  const risk = semanticDiffRisk(run.readings);
  run.recordAction(`reported risk ${risk}`);

  const prompt =
    `You are a code reviewer. Analyze the following git diff and provide:
1. A concise summary of what changed and why (2-4 sentences)
2. Impact analysis: list the downstream functions/modules/callers that may be affected

Respond in JSON with fields: summary (string), impact (array of strings)

Diff (${range}):
${truncateDiffAtBoundary(fullDiff, 6000)}`;

  const reply = await trySemanticDiffLlm(toolLLM, prompt);
  const prose = reply ? parseSemanticDiffProse(reply) : {};

  return {
    before,
    after,
    summary: prose.summary ?? summaryFromReadings(changedFiles, risk),
    impact: prose.impact ?? changedFiles.map((file) => `Changed file: ${file}`),
    risk,
    risk_readings: {
      breaks_callers: run.readings.breaks_callers.verdict,
      changes_behavior: run.readings.changes_behavior.verdict,
    },
    summary_source: prose.summary !== undefined ? 'llm' : 'readings',
    changed_files: changedFiles,
  };
}

export async function runUpgrade(
  input: AnalyzeInput,
  projectRoot: string,
): Promise<Record<string, unknown>> {
  let packageNames: string[];

  if (input.packages && input.packages.length > 0) {
    packageNames = input.packages;
  } else {
    const pkgPath = join(projectRoot, 'package.json');
    if (!existsSync(pkgPath)) {
      return { error: 'No package.json found and no packages specified', projectRoot };
    }
    const pkgJson = await readJsonFile(pkgPath);
    if (pkgJson === null) {
      return { error: 'Failed to parse package.json' };
    }
    const deps = loadDependencyVersions(pkgJson);
    packageNames = Object.keys(deps);
    if (packageNames.length === 0) {
      return { packages: [], total: 0, outdated: 0, breaking: 0 };
    }
  }

  const currentVersions: Record<string, string> = {};
  const pkgPath = join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkgJson = await readJsonFile(pkgPath);
      if (pkgJson === null) {
        throw new Error('Failed to parse package.json');
      }
      const allDeps = loadDependencyVersions(pkgJson);
      for (const [name, ver] of Object.entries(allDeps)) {
        currentVersions[name] = ver;
      }
    } catch {
      // Ignore parse errors
    }
  }

  const BATCH_SIZE = 20;
  const batch = packageNames.slice(0, BATCH_SIZE);
  const results: Array<{ name: string; current: string; latest: string; breaking: boolean }> = [];

  await Promise.all(
    batch.map(async (name) => {
      const current = currentVersions[name]! ?? 'unknown';
      try {
        const res = await instrumentedFetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
          signal: AbortSignal.timeout(8000),
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) {
          results.push({ name, current, latest: 'unknown', breaking: false });
          return;
        }
        const data = await res.json() as { version?: string };
        const latest = data.version ?? 'unknown';
        const breaking = current !== 'unknown' && latest !== 'unknown'
          ? isBreakingUpgrade(current, latest)
          : false;
        results.push({ name, current, latest, breaking });
      } catch {
        results.push({ name, current, latest: 'fetch_failed', breaking: false });
      }
    }),
  );

  results.sort((a, b) => {
    if (a.breaking !== b.breaking) return a.breaking ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    packages: results,
    total: results.length,
    outdated: results.filter((r) => r.latest !== 'unknown' && r.latest !== r.current && r.latest !== 'fetch_failed').length,
    breaking: results.filter((r) => r.breaking).length,
  };
}
