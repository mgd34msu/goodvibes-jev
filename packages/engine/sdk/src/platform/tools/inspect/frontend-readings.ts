/**
 * The frontend analyzers whose findings are read by Jev
 * (`engine.tools.frontend-finding`, tools/batteries/frontend-finding.ts).
 * Code finds each candidate from syntax (an element start, a hook call, an
 * overflow or fixed-size utility, an import specifier); the reading decides
 * whether it is an issue. A candidate is reported unless the reading is a
 * no, so an uncertain one is shown with `reading: 'uncertain'`.
 */
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { frontendFinding, frontendLineView, MAX_JUDGED_HOOK_LINES } from '../batteries/frontend-finding.js';
import type { A11yIssue, ClientBoundaryInfo, HookDep, HooksInfo, OverflowInfo, OverflowIssue, SizingInfo, SizingItem } from './schema.js';

const SITE = 'tools.inspect.frontend-finding';
const READ_CONCURRENCY = 8;

type Question = 'a11y_violation' | 'omits_dependency' | 'overflow_problem' | 'fixed_size_problem' | 'server_only';
export type FindingReading = 'real' | 'uncertain';

/** A yes is real, a no dismisses, anything else is shown as uncertain. */
function findingReading(reading: YesNoReading): FindingReading | 'dismissed' {
  if (reading.verdict === 'yes') return 'real';
  return reading.verdict === 'no' ? 'dismissed' : 'uncertain';
}

async function read(question: Question, state: Record<string, unknown>): Promise<FindingReading | 'dismissed'> {
  const run = await frontendFinding.run(judgmentPort(SITE), state as never, { site: SITE, only: [question] });
  const reading = findingReading(run.readings[question]);
  run.recordAction(`${question}: ${reading}`);
  return reading;
}

// ── Accessibility ─────────────────────────────────────────────────────────────

/** The WCAG rule each element kind is read against. */
const A11Y_RULES = {
  'img-alt': { rule: 'img-alt: images need an alt attribute', message: 'img element is missing an alt attribute', wcag: 'WCAG 1.1.1 (Level A)' },
  'button-name': { rule: 'button-name: buttons need an accessible name', message: 'button element is missing an accessible name', wcag: 'WCAG 4.1.2 (Level A)' },
  'click-events-have-key-events': { rule: 'click-events-have-key-events: clickable non-interactive elements need a role and keyboard handling', message: 'Non-interactive element has onClick without a role or keyboard handling', wcag: 'WCAG 4.1.2 (Level A)' },
  label: { rule: 'label: form fields need a label', message: 'input element is missing an associated label', wcag: 'WCAG 1.3.1 (Level A)' },
} as const;
type A11yCode = keyof typeof A11Y_RULES;

/** Lines an element may span before its opening tag closes. */
const MAX_ELEMENT_LINES = 8;

function openingTag(lines: readonly string[], index: number): string {
  const parts: string[] = [];
  for (let j = index; j < Math.min(lines.length, index + MAX_ELEMENT_LINES); j++) {
    parts.push(lines[j]!);
    if (lines[j]!.includes('>')) break;
  }
  return parts.join(' ');
}

/** Which rule an element starting on this line is read against, from its tag (syntax only). */
function a11yCandidate(lines: readonly string[], index: number): A11yCode | null {
  const line = lines[index]!;
  if (/<img\b/i.test(line)) return 'img-alt';
  if (/<button\b/i.test(line)) return 'button-name';
  if (/<input\b/i.test(line)) {
    // A hidden input is not shown, so it takes no label (HTML).
    return /type=['"]hidden['"]/.test(openingTag(lines, index)) ? null : 'label';
  }
  if (/<(?:div|span)\b/i.test(line) && /\bonClick\b/.test(openingTag(lines, index))) return 'click-events-have-key-events';
  return null;
}

export async function inspectAccessibility(content: string, file = ''): Promise<Array<A11yIssue & { reading: FindingReading }>> {
  const lines = content.split('\n');
  const candidates = lines.flatMap((_, index) => {
    const code = a11yCandidate(lines, index);
    return code === null ? [] : [{ index, code }];
  });
  const readings = await mapWithConcurrency(candidates, READ_CONCURRENCY, ({ index, code }) =>
    read('a11y_violation', frontendLineView(file, lines, index, { rule: A11Y_RULES[code].rule })));
  return candidates.flatMap(({ index, code }, i) => {
    const reading = readings[i]!;
    if (reading === 'dismissed') return [];
    const { message, wcag } = A11Y_RULES[code];
    return [{ line: index + 1, code, message, wcag, reading }];
  });
}

// ── Hooks ─────────────────────────────────────────────────────────────────────

/** The hook call starting at `index`, up to its closing parenthesis (bounded). */
function hookCall(lines: readonly string[], index: number, start: number): string {
  let depth = 0;
  const parts: string[] = [];
  for (let j = index; j < Math.min(lines.length, index + MAX_JUDGED_HOOK_LINES); j++) {
    const text = j === index ? lines[j]!.slice(start) : lines[j]!;
    parts.push(j === index ? lines[j]! : text);
    for (const ch of text) {
      if (ch === '(') depth++;
      else if (ch === ')' && --depth === 0) return parts.join('\n');
    }
  }
  return parts.join('\n');
}

export async function inspectHooks(content: string, file: string): Promise<HooksInfo> {
  const lines = content.split('\n');
  const hookRe = /\b(useEffect|useMemo|useCallback)\s*\(/;
  const calls = lines.flatMap((line, index) => {
    const m = hookRe.exec(line);
    return m ? [{ index, kind: m[1] as HookDep['hookKind'], code: hookCall(lines, index, m.index) }] : [];
  });
  const readings = await mapWithConcurrency(calls, READ_CONCURRENCY, ({ code }) => read('omits_dependency', { file, code }));
  const hooks: HookDep[] = calls.map(({ index, kind, code }, i) => {
    // The dependency array is the last array literal before the call closes (syntax).
    const deps = /\[([^\]]*)\]\s*\)\s*;?\s*$/.exec(code)?.[1]?.split(',').map((dep) => dep.trim()).filter(Boolean) ?? [];
    const reading = readings[i]!;
    return { hookKind: kind, line: index + 1, deps, omitsDependency: reading === 'dismissed' ? 'no' : reading === 'real' ? 'yes' : 'uncertain' };
  });
  return { file, hooks, missingDepsCount: hooks.filter((hook) => hook.omitsDependency === 'yes').length };
}

// ── Overflow ──────────────────────────────────────────────────────────────────

export async function inspectOverflow(content: string, file: string): Promise<OverflowInfo> {
  const lines = content.split('\n');
  const candidates = lines.flatMap((line, index): Array<{ index: number; kind: OverflowIssue['kind'] }> => {
    if (/\boverflow-hidden\b/.test(line) || /overflow\s*:\s*hidden/.test(line)) return [{ index, kind: 'hidden_clip' }];
    if (/\boverflow-(?:x-|y-)?(?:scroll|auto)\b/.test(line) || /overflow(?:-y|-x)?\s*:\s*(?:scroll|auto)/.test(line)) return [{ index, kind: 'scroll_no_height' }];
    return [];
  });
  const readings = await mapWithConcurrency(candidates, READ_CONCURRENCY, ({ index }) => read('overflow_problem', frontendLineView(file, lines, index)));
  const issues: Array<OverflowIssue & { reading: FindingReading }> = candidates.flatMap(({ index, kind }, i) => {
    const reading = readings[i]!;
    return reading === 'dismissed' ? [] : [{ line: index + 1, kind, snippet: lines[index]!.trim().slice(0, 80), reading }];
  });
  return { file, issues, count: issues.length };
}

// ── Sizing ────────────────────────────────────────────────────────────────────

export async function inspectSizing(content: string, file: string): Promise<SizingInfo> {
  const lines = content.split('\n');
  const items: SizingItem[] = [];
  const patterns: ReadonlyArray<readonly [RegExp, SizingItem['kind']]> = [
    [/\b(?:w|h|min-w|max-w|min-h|max-h)-(?:\d+|\[\d+(?:px|rem)\])(?=[\s"'`]|$)/g, 'fixed_px'],
    [/\b(?:w|h)-(?:\d+\/\d+|full|screen)\b/g, 'percentage'],
    [/\bflex-(?:1|auto|none|initial|grow|shrink)\b/g, 'flex'],
    [/\bgrid-cols-\d+\b/g, 'grid'],
    [/\b(?:w|h)-(?:screen|lvh|svh|dvh)\b/g, 'viewport'],
    [/(?:width|height|min-width|max-width|min-height|max-height)\s*:\s*\d+px/g, 'fixed_px'],
    [/(?:width|height)\s*:\s*\d+%/g, 'percentage'],
  ];
  lines.forEach((line, index) => {
    for (const [re, kind] of patterns) {
      for (const m of line.matchAll(re)) items.push({ line: index + 1, kind, value: m[0], flagged: false });
    }
  });
  // Each line holding a fixed size is read once; its fixed items are flagged unless the reading is a no.
  const fixedLines = [...new Set(items.filter((item) => item.kind === 'fixed_px').map((item) => item.line))];
  const readings = await mapWithConcurrency(fixedLines, READ_CONCURRENCY, (line) => read('fixed_size_problem', frontendLineView(file, lines, line - 1)));
  const flaggedLines = new Set(fixedLines.filter((_, i) => readings[i] !== 'dismissed'));
  for (const item of items) item.flagged = item.kind === 'fixed_px' && flaggedLines.has(item.line);
  return { file, items, hardcodedCount: items.filter((item) => item.flagged).length };
}

// ── Client boundary ───────────────────────────────────────────────────────────

/** Server-only readings by module specifier; a module's nature does not change within a process. */
const serverOnlyReadings = new Map<string, Promise<FindingReading | 'dismissed'>>();

function readServerOnly(module: string): Promise<FindingReading | 'dismissed'> {
  const known = serverOnlyReadings.get(module);
  if (known !== undefined) return known;
  const reading = read('server_only', { module });
  serverOnlyReadings.set(module, reading);
  reading.catch(() => serverOnlyReadings.delete(module));
  return reading;
}

/** Forgets remembered server-only readings; for tests that swap the judgment port. */
export function forgetServerOnlyReadings(): void {
  serverOnlyReadings.clear();
}

/**
 * The file's directive is its first statement, after any comments (React's
 * rule); its imports are listed from syntax and each module is read for
 * whether it can only run on the server.
 */
export async function inspectClientBoundary(content: string, file: string): Promise<ClientBoundaryInfo> {
  const code = content.replace(/^(?:\s*(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/))*\s*/, '');
  const directive = /^(['"])use (client|server)\1\s*;?/.exec(code);
  const modules = [...new Set([...content.matchAll(/import\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]!))];
  const readings = await mapWithConcurrency(modules, READ_CONCURRENCY, readServerOnly);
  const serverOnlyImports = modules.filter((_, i) => readings[i] !== 'dismissed');
  return {
    file,
    directive: directive ? (`use ${directive[2]}` as ClientBoundaryInfo['directive']) : null,
    importsServerOnly: serverOnlyImports.length > 0,
    serverOnlyImports,
  };
}
