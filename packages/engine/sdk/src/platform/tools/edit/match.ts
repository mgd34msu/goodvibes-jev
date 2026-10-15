import { assertCapturedToolAccessCurrent } from '../shared/captured-input-tools.js';
import { extname } from 'node:path';
import { logger } from '../../utils/logger.js';
import { CodeIntelligence } from '../../intelligence/index.js';
import type { EditItem, OccurrenceSpec, EditResult, EditResultStatus } from './types.js';
import { summarizeError } from '../../utils/error-display.js';
import { assertSafeRegexInput, compileSafeRegExp, createSafeRegex, safeRegExpExec } from '../../utils/safe-regex.js';
import { judgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
import { editWindow } from '../batteries/edit-window.js';
import { assertJudgmentInput } from '../../gate/judgment-input.js';
import { requireActingReading, JudgmentHeldError } from '../../types/judgment-held.js';
import { editTarget, editTargetView } from '../batteries/edit-target.js';

type AstGrepModule = typeof import('@ast-grep/napi');
type EditComputationResult =
  | { newContent: string; occurrencesReplaced: number; warning?: string | undefined }
  | { error: string };

function withExactFallbackWarning(
  result: { newContent: string; occurrencesReplaced: number } | { error: string },
  warning: string,
): EditComputationResult {
  return 'error' in result ? result : { ...result, warning };
}

export function decodeBase64(value: string): string {
  return Buffer.from(value, 'base64').toString('utf-8');
}

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineNumberAt(content: string, offset: number): number {
  return content.slice(0, offset).split('\n').length;
}


/** The decision site the edit-target reading is logged under. */
export const EDIT_TARGET_SITE = 'tools.edit-fuzzy-line';

export function findAllPositions(
  content: string,
  find: string,
  mode: 'exact' | 'fuzzy' | 'regex',
  caseSensitive: boolean,
  whitespaceSensitive: boolean = true,
  multiline: boolean = false,
): { start: number; end: number }[] {
  const positions: { start: number; end: number }[] = [];

  if (mode === 'regex') {
    let flags = caseSensitive ? 'g' : 'gi';
    if (multiline) {
      if (!flags.includes('s')) flags += 's';
      if (!flags.includes('m')) flags += 'm';
    }
    assertSafeRegexInput(content, { operation: 'edit regex search' });
    const re = compileSafeRegExp(find, flags, { operation: 'edit regex search' });
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      positions.push({ start: m.index, end: m.index + m[0].length });
      if (m[0].length === 0) re.lastIndex++;
    }
    return positions;
  }

  if (mode === 'fuzzy') {
    const normalizedFind = normalizeWhitespace(caseSensitive ? find : find.toLowerCase());
    if (!normalizedFind) return [];

    const tokens: { norm: string; origStart: number; origEnd: number }[] = [];
    const tokenRe = /\S+/g;
    let tm: RegExpExecArray | null;
    const compareContent = caseSensitive ? content : content.toLowerCase();
    while ((tm = tokenRe.exec(content)) !== null) {
      tokens.push({
        norm: compareContent.slice(tm.index, tm.index + tm[0].length),
        origStart: tm.index,
        origEnd: tm.index + tm[0].length,
      });
    }

    const findTokens = normalizedFind.split(' ').filter(Boolean);
    if (findTokens.length === 0) return [];

    for (let i = 0; i <= tokens.length - findTokens.length; i++) {
      let match = true;
      for (let j = 0; j < findTokens.length; j++) {
        if ((tokens[i + j]?.norm ?? '') !== findTokens[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        positions.push({
          start: tokens[i]?.origStart ?? 0,
          end: tokens[i + findTokens.length - 1]?.origEnd ?? 0,
        });
      }
    }
    return positions;
  }

  if (!whitespaceSensitive) {
    return findAllPositions(content, find, 'fuzzy', caseSensitive, true);
  }
  const needle = caseSensitive ? find : find.toLowerCase();
  const haystack = caseSensitive ? content : content.toLowerCase();
  let idx = 0;
  while (true) {
    const pos = haystack.indexOf(needle, idx);
    if (pos === -1) break;
    positions.push({ start: pos, end: pos + find.length });
    idx = pos + 1;
  }
  return positions;
}

export function applyHints(
  content: string,
  positions: { start: number; end: number }[],
  hints: EditItem['hints'],
  nearLine?: number,
): { positions: { start: number; end: number }[]; warning?: string | undefined } {
  if (!hints) return { positions };

  let filtered = positions;
  let warning: string | undefined;

  if (hints.after) {
    const anchorIdx = content.indexOf(hints.after);
    if (anchorIdx === -1) {
      return { positions: [], warning: `after anchor "${hints.after}" not found in file` };
    }
    const afterOffset = anchorIdx + hints.after.length;
    filtered = filtered.filter((pos) => pos.start >= afterOffset);
  }

  if (hints.before) {
    const anchorIdx = content.indexOf(hints.before);
    if (anchorIdx === -1) {
      return { positions: [], warning: `before anchor "${hints.before}" not found in file` };
    }
    filtered = filtered.filter((pos) => pos.end <= anchorIdx);
  }

  if (hints.in_function) {
    const name = hints.in_function;
    const scopeRe = new RegExp(
      `(?:function\\s+${escapeRegex(name)}\\s*\\(|(?:const|let|var)\\s+${escapeRegex(name)}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|\\w+)\\s*=>|${escapeRegex(name)}\\s*\\()`,
      'g',
    );
    filtered = filterByScope(content, filtered, scopeRe);
  }

  if (hints.in_class) {
    const name = hints.in_class;
    const scopeRe = new RegExp(`class\\s+${escapeRegex(name)}\\s*(?:extends[^{]+)?\\{`, 'g');
    filtered = filterByScope(content, filtered, scopeRe);
  }

  if (nearLine !== undefined && filtered.length > 1) {
    let best = filtered[0]!;
    let bestDist = Math.abs(lineNumberAt(content, best.start) - nearLine);
    for (const pos of filtered.slice(1)) {
      const dist = Math.abs(lineNumberAt(content, pos.start) - nearLine);
      if (dist < bestDist) {
        bestDist = dist;
        best = pos;
      }
    }
    filtered = [best];
  }

  return { positions: filtered, warning };
}

function filterByScope(
  content: string,
  positions: { start: number; end: number }[],
  scopeRe: RegExp,
): { start: number; end: number }[] {
  const scopes: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = scopeRe.exec(content)) !== null) {
    const scopeStart = m.index;
    let braceStart = content.indexOf('{', m.index + m[0].length - 1);
    if (braceStart === -1) continue;
    let depth = 0;
    let i = braceStart;
    for (; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
    }
    scopes.push({ start: scopeStart, end: i });
  }

  if (scopes.length === 0) return [];
  return positions.filter((pos) => scopes.some((scope) => pos.start >= scope.start && pos.end <= scope.end));
}

export function selectOccurrences(
  positions: { start: number; end: number }[],
  occurrence: OccurrenceSpec | undefined,
): { selected: { start: number; end: number }[] } | { error: string; hint?: string } {
  if (positions.length === 0) {
    return {
      error: 'Find string not found in file',
      hint: 'Check that the find string matches the file content exactly, including whitespace and line endings.',
    };
  }

  if (occurrence === undefined) {
    if (positions.length > 1) {
      return {
        error: `Ambiguous match: find string appears ${positions.length} times. Specify occurrence: 'first', 'last', 'all', or a number.`,
        hint: `Pattern matched ${positions.length} times, use occurrence: 'first', 'last', 'all', or a number (1-${positions.length}) to disambiguate.`,
      };
    }
    return { selected: positions };
  }

  if (occurrence === 'first') return { selected: [positions[0]!] };
  if (occurrence === 'last') return { selected: [positions[positions.length - 1]!] };
  if (occurrence === 'all') return { selected: positions };
  const n = occurrence as number;
  if (n < 1 || n > positions.length) {
    return { error: `Occurrence ${n} out of range: file has ${positions.length} match(es)` };
  }
  return { selected: [positions[n - 1]!] };
}

/** @deprecated Synchronous compatibility; production regex edits use applyReplacementsAsync. */
export function applyReplacements(
  content: string,
  selections: { start: number; end: number }[],
  find: string,
  replace: string,
  mode: 'exact' | 'fuzzy' | 'regex',
  caseSensitive: boolean,
): string {
  const sorted = [...selections].sort((a, b) => b.start - a.start);
  let result = content;
  for (const { start, end } of sorted) {
    let replacement = replace;
    if (mode === 'regex') {
      try {
        const flags = caseSensitive ? '' : 'i';
        const re = compileSafeRegExp(find, flags, { operation: 'edit regex replacement' });
        const m = safeRegExpExec(re, content.slice(start, end), { operation: 'edit regex replacement' });
        if (m) {
          replacement = replace.replace(/\$(\d+)/g, (_full, digit) => m[parseInt(digit)] ?? '');
        }
      } catch {
        // ignore
      }
    }
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  return result;
}

async function findAllPositionsAsync(
  content: string, find: string, mode: 'exact' | 'fuzzy' | 'regex',
  caseSensitive: boolean, whitespaceSensitive: boolean, multiline: boolean, options: JudgmentReadingOptions,
): Promise<{ start: number; end: number }[]> {
  if (mode !== 'regex') return findAllPositions(content, find, mode, caseSensitive, whitespaceSensitive, multiline);
  await assertCapturedToolAccessCurrent();
  const flags = `${caseSensitive ? 'g' : 'gi'}${multiline ? 'sm' : ''}`;
  await using pattern = await createSafeRegex(find, flags, { ...options, operation: 'edit regex search' });
  const positions = await pattern.positions(content);
  await assertCapturedToolAccessCurrent();
  pattern.assertCurrent();
  return [...positions];
}

async function applyReplacementsAsync(
  content: string, selections: { start: number; end: number }[], find: string, replace: string,
  mode: 'exact' | 'fuzzy' | 'regex', caseSensitive: boolean, options: JudgmentReadingOptions,
): Promise<string> {
  if (mode !== 'regex') return applyReplacements(content, selections, find, replace, mode, caseSensitive);
  await assertCapturedToolAccessCurrent();
  await using pattern = await createSafeRegex(find, caseSensitive ? '' : 'i', { ...options, operation: 'edit regex replacement' });
  let result = content;
  for (const { start, end } of [...selections].sort((a, b) => b.start - a.start)) {
    const match = await pattern.exec(content.slice(start, end));
    // Preserve the edit API's historical numeric-capture substitution (not
    // String.replace's full replacement language, used by find preview).
    const parts: string[] = [];
    let cursor = 0;
    const append = (part: string) => {
      if (part.length) parts.push(part);
    };
    if (match) {
      const tokens = /\$(\d+)/g;
      let token: RegExpExecArray | null;
      while ((token = tokens.exec(replace)) !== null) {
        append(replace.slice(cursor, token.index));
        append(match.captures[parseInt(token[1]!)] ?? '');
        cursor = token.index + token[0].length;
      }
    }
    append(replace.slice(cursor));
    const replacement = parts.join('');
    result = result.slice(0, start) + replacement + result.slice(end);
  }
  await assertCapturedToolAccessCurrent();
  pattern.assertCurrent();
  return result;
}

type AstGrepNode = {
  text(): string;
  range(): {
    start: { line: number; column: number; index: number };
    end: { line: number; column: number; index: number };
  };
  getMatch(name: string): AstGrepNode | null;
  getMultipleMatches(name: string): AstGrepNode[];
};
type AstGrepParser = { parse: (src: string) => { root(): { findAll(pat: string): AstGrepNode[] } } };

let astGrepModulePromise: Promise<AstGrepModule> | null = null;

async function loadAstGrep(): Promise<AstGrepModule> {
  astGrepModulePromise ??= import('@ast-grep/napi');
  return astGrepModulePromise;
}

function getAstGrepLang(astGrep: AstGrepModule, filePath: string): AstGrepParser | null {
  const lang = extname(filePath).slice(1).toLowerCase();
  switch (lang) {
    case 'ts':
      return astGrep.ts as unknown as AstGrepParser;
    case 'tsx':
      return astGrep.tsx as unknown as AstGrepParser;
    case 'js':
    case 'mjs':
    case 'cjs':
      return astGrep.js as unknown as AstGrepParser;
    case 'jsx':
      return astGrep.jsx as unknown as AstGrepParser;
    case 'css':
      return astGrep.css as unknown as AstGrepParser;
    case 'html':
      return astGrep.html as unknown as AstGrepParser;
    default:
      return null;
  }
}

export function computeExactEdit(
  fileContent: string,
  item: EditItem,
): { newContent: string; occurrencesReplaced: number } | { error: string } {
  const findStr = item.find_base64 ? decodeBase64(item.find_base64) : item.find;
  const replaceStr = item.replace_base64 ? decodeBase64(item.replace_base64) : item.replace;

  const positions = findAllPositions(fileContent, findStr, 'exact', true, true);
  if (positions.length === 0) {
    return { error: `No match found for '${findStr}'` };
  }

  const selResult = selectOccurrences(positions, item.occurrence);
  if ('error' in selResult) return selResult;

  const newContent = applyReplacements(fileContent, selResult.selected, findStr, replaceStr, 'exact', true);
  return { newContent, occurrencesReplaced: selResult.selected.length };
}

export function computeAstEdit(fileContent: string, item: EditItem, filePath: string): Promise<EditComputationResult> {
  const findStr = item.find_base64 ? decodeBase64(item.find_base64) : item.find;
  const replaceStr = item.replace_base64 ? decodeBase64(item.replace_base64) : item.replace;
  let intel: CodeIntelligence;
  try {
    intel = new CodeIntelligence({});
  } catch (e) {
    logger.debug('CodeIntelligence instance not available', { error: summarizeError(e) });
    return Promise.resolve(
      withExactFallbackWarning(computeExactEdit(fileContent, item), 'AST match unavailable; used exact match instead.'),
    );
  }

  if (!intel.hasTreeSitter(filePath)) {
    return Promise.resolve(
      withExactFallbackWarning(
        computeExactEdit(fileContent, item),
        'AST match unavailable for this file type; used exact match instead.',
      ),
    );
  }

  return intel
    .getSymbols(filePath, fileContent)
    .then((symbols) => {
      const normalizedFind = findStr.replace(/\s+/g, ' ').trim();
      const positions: { start: number; end: number }[] = [];
      const lines = fileContent.split('\n');

      for (const symbol of symbols) {
        const sig = (symbol.signature ?? symbol.name ?? '').replace(/\s+/g, ' ').trim();
        if (sig.includes(normalizedFind) || normalizedFind.includes(sig)) {
          let lineOffset = 0;
          for (let i = 0; i < symbol.line - 1 && i < lines.length; i++) {
            lineOffset += (lines[i]?.length ?? 0) + 1;
          }
          const lineText = lines[symbol.line - 1] ?? '';
          const col = lineText.indexOf(findStr);
          if (col >= 0) {
            positions.push({ start: lineOffset + col, end: lineOffset + col + findStr.length });
          }
        }
      }

      if (positions.length === 0) {
        return withExactFallbackWarning(
          computeExactEdit(fileContent, item),
          'AST match found no symbols; used exact match instead.',
        );
      }

      const selResult = selectOccurrences(positions, item.occurrence);
      if ('error' in selResult) return selResult;

      const newContent = applyReplacements(fileContent, selResult.selected, findStr, replaceStr, 'exact', true);
      return { newContent, occurrencesReplaced: selResult.selected.length };
    })
    .catch((err) =>
      withExactFallbackWarning(
        computeExactEdit(fileContent, item),
        `AST match failed (${summarizeError(err)}); used exact match instead.`,
      ),
    );
}

export async function computeAstPatternEdit(
  fileContent: string,
  item: EditItem,
  filePath: string,
): Promise<EditComputationResult> {
  const findStr = item.find_base64 ? decodeBase64(item.find_base64) : item.find;
  const replaceStr = item.replace_base64 ? decodeBase64(item.replace_base64) : item.replace;

  let astGrep: AstGrepModule;
  try {
    astGrep = await loadAstGrep();
  } catch (err) {
    return withExactFallbackWarning(
      computeExactEdit(fileContent, item),
      `ast_pattern unavailable (${summarizeError(err)}); used exact match instead.`,
    );
  }

  const parser = getAstGrepLang(astGrep, filePath);
  if (!parser) {
    return withExactFallbackWarning(
      computeExactEdit(fileContent, item),
      'ast_pattern unavailable for this file type; used exact match instead.',
    );
  }

  let root: ReturnType<AstGrepParser['parse']>;
  try {
    root = parser.parse(fileContent);
  } catch (e) {
    logger.debug('AST pattern parse failed', { error: summarizeError(e) });
    return withExactFallbackWarning(
      computeExactEdit(fileContent, item),
      `ast_pattern parse failed (${summarizeError(e)}); used exact match instead.`,
    );
  }

  let matches: AstGrepNode[];
  try {
    matches = root.root().findAll(findStr);
  } catch (err) {
    return { error: `ast_pattern: invalid pattern '${findStr}': ${summarizeError(err)}` };
  }

  if (matches.length === 0) {
    return { error: `ast_pattern: no matches found for pattern '${findStr}'` };
  }

  const positions = matches.map((m) => ({
    start: m.range().start.index,
    end: m.range().end.index,
    text: m.text(),
    node: m,
  }));
  const occSpec = item.occurrence;
  let selected: typeof positions;
  if (occSpec === undefined) {
    if (positions.length > 1) {
      return {
        error: `ast_pattern: ${positions.length} matches found, set occurrence to 'first', 'last', 'all', or N to disambiguate`,
      };
    }
    selected = positions;
  } else if (occSpec === 'all') {
    selected = positions;
  } else if (occSpec === 'first') {
    selected = positions.slice(0, 1);
  } else if (occSpec === 'last') {
    selected = positions.slice(-1);
  } else if (typeof occSpec === 'number') {
    if (occSpec < 1 || occSpec > positions.length) {
      return { error: `ast_pattern: occurrence ${occSpec} out of range (found ${positions.length} matches)` };
    }
    selected = [positions[occSpec - 1]!];
  } else {
    selected = positions;
  }

  const sorted = [...selected].sort((a, b) => b.start - a.start);
  let newContent = fileContent;
  for (const pos of sorted) {
    let replacement = replaceStr;
    replacement = replacement.replace(/\$\$\$([A-Z_][A-Z0-9_]*)/g, (_, varName: string) => {
      const nodes = pos.node.getMultipleMatches(varName);
      return nodes.map((n) => n.text()).join(', ');
    });
    replacement = replacement.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, varName: string) => {
      const node = pos.node.getMatch(varName);
      return node ? node.text() : _;
    });
    newContent = newContent.slice(0, pos.start) + replacement + newContent.slice(pos.end);
  }

  return { newContent, occurrencesReplaced: selected.length };
}

/** Decode only this edit module’s emitted diagnostic prefixes; foreign prose stays failed. */
export function classifyEditFailure(message: string): EditResultStatus {
  if (message.startsWith('File not found or unreadable:') || message.startsWith('Find string not found') || message.startsWith('No match found for ')) return 'not_found';
  if (message.startsWith('Ambiguous') || message.startsWith('ambiguous')) return 'ambiguous';
  if (message.startsWith('OCC conflict:')) return 'conflict';
  return 'failed';
}

/**
 * Classify a successful edit's warning string into which lenient fallback the
 * matcher used to land it, or null for a warning that is not a fallback notice.
 * Co-located with the warning phrases produced by computeSingleEdit (see
 * `usedFallback` above) so the classifier and the strings it reads stay in one
 * file. Used by tool-format telemetry to count fallback-mode edits per model.
 */
export function classifyEditFallbackWarning(warning: string): 'whitespace' | 'fuzzy-lines' | null {
  if (warning.includes('whitespace-normalized match')) return 'whitespace';
  if (warning.includes('fuzzy line match')) return 'fuzzy-lines';
  return null;
}

export function buildFailedEditResult(item: EditItem, error: string, status: EditResultStatus): EditResult {
  return {
    id: item.id,
    path: item.path,
    success: false,
    status,
    error,
  };
}

/** All structurally possible windows participate; similarity never hides a target. */
async function selectEditWindow(file: string, find: string) {
  const lines = file.split('\n'), size = find.split('\n').length;
  // Each reading sees the complete candidate and its neighboring lines. Do not
  // send the whole file with every candidate or reject files by line count.
  const context = { find, totalLines: lines.length, scope: 'Candidates include neighboring lines; other file locations are evaluated in separate batches.' };
  if (JSON.stringify(context).length > 160_000) return null;
  assertJudgmentInput(context);
  type Window = { id: string; content: { startLine: number; text: string; before: string; after: string }; start: number; end: number; candidateLines: string[] };
  const port = judgmentPort(EDIT_TARGET_SITE), model = port.model;
  const current = () => { if (judgmentPort(EDIT_TARGET_SITE) !== port || port.model !== model) throw new JudgmentHeldError(); };
  const matches: Window[] = [];
  const evaluate = async (candidates: Window[]) => {
    await assertCapturedToolAccessCurrent(); current();
    const selection = await editWindow.select(port, context, candidates, { site: EDIT_TARGET_SITE, beforeAttempt: current, beforeAsyncAttempt: assertCapturedToolAccessCurrent });
    current(); await assertCapturedToolAccessCurrent();
    requireActingReading(selection);
    for (const candidate of candidates) {
      const fit = requireActingReading(selection.fits[candidate.id]!);
      if (fit.verdict === 'yes') matches.push(candidate);
    }
    selection.recordAction('Evaluate candidate locations; only one unambiguous target may proceed.');
  };
  let offset = 0;
  let batch: Window[] = [];
  let batchChars = JSON.stringify(context).length;
  for (let i = 0; i + size <= lines.length; i++) {
    const start = offset; offset += lines[i]!.length + 1;
    const candidateLines = lines.slice(i, i + size), text = candidateLines.join('\n');
    const candidate = { id: `line-${i + 1}`, content: { startLine: i + 1, text,
      before: lines.slice(Math.max(0, i - 2), i).join('\n'), after: lines.slice(i + size, i + size + 2).join('\n') }, start, end: start + text.length, candidateLines };
    const chars = JSON.stringify(candidate).length;
    // An oversized individual target cannot be safely inferred by a bounded
    // model request. Exact replacement remains available for the entire file.
    if (JSON.stringify(context).length + chars > 160_000) return null;
    if (batch.length && (batch.length >= 64 || batchChars + chars > 160_000)) {
      await evaluate(batch);
      if (matches.length > 1) return null;
      batch = []; batchChars = JSON.stringify(context).length;
    }
    batch.push(candidate); batchChars += chars;
  }
  if (batch.length) await evaluate(batch);
  if (matches.length !== 1) return null;
  const match = matches[0]!;
  // A separate same-target reading independently verifies the selected bytes.
  const run = await editTarget.run(port, editTargetView(find, match.candidateLines), { site: EDIT_TARGET_SITE,
    beforeAttempt: current, beforeAsyncAttempt: assertCapturedToolAccessCurrent });
  current(); await assertCapturedToolAccessCurrent();
  const target = requireActingReading(run.readings.same_target);
  run.recordAction(target.verdict === 'yes' ? 'Apply the unique verified edit target.' : 'Hold the proposed edit target.');
  return target.verdict === 'yes' ? { ...match, probability: target.probability } : null;
}

export async function computeSingleEdit(
  fileContent: string,
  item: EditItem,
  mode: 'exact' | 'fuzzy' | 'regex',
  caseSensitive: boolean,
  whitespaceSensitive: boolean = true,
  multiline: boolean = false,
  options: JudgmentReadingOptions = {},
): Promise<
  | { newContent: string; occurrencesReplaced: number; warning?: string | undefined }
  | { error: string; hint?: string | undefined }
> {
  const before = JSON.stringify(item);
  const current = () => {
    options.signal?.throwIfAborted(); options.assertCurrent?.();
    if (JSON.stringify(item) !== before) throw new Error('Edit regex request changed');
  };
  current();
  const readingOptions = { ...options, assertCurrent: current };
  const findStr = item.find_base64 ? decodeBase64(item.find_base64) : item.find;
  const replaceStr = item.replace_base64 ? decodeBase64(item.replace_base64) : item.replace;

  let positions: { start: number; end: number }[];
  try {
    positions = await findAllPositionsAsync(fileContent, findStr, mode, caseSensitive, whitespaceSensitive, multiline, readingOptions);
  } catch (err) {
    return { error: `Invalid find pattern: ${summarizeError(err)}` };
  }

  let hintsWarning: string | undefined;
  if (item.hints) {
    const hintsResult = applyHints(fileContent, positions, item.hints, item.hints.near_line);
    positions = hintsResult.positions;
    hintsWarning = hintsResult.warning;
  }

  let usedFallback: 'whitespace' | 'fuzzy-lines' | null = null;
  if (positions.length === 0 && mode === 'exact') {
    const wsPositions = findAllPositions(fileContent, findStr, 'fuzzy', caseSensitive, true);
    if (wsPositions.length > 0) {
      positions = wsPositions;
      usedFallback = 'whitespace';
    } else {
      const fuzzyMatch = await selectEditWindow(fileContent, findStr);
      if (fuzzyMatch) {
        positions = [{ start: fuzzyMatch.start, end: fuzzyMatch.end }];
        usedFallback = 'fuzzy-lines';
        logger.warn('[edit] Fuzzy line match used', { probability: fuzzyMatch.probability, file: item.path });
      } else {
        return { error: 'Find string not found unambiguously in file', hint: 'Read the file and provide the exact replacement target.' };
      }
    }
  }

  const selResult = selectOccurrences(positions, item.occurrence);
  if ('error' in selResult) return selResult;

  const newContent = await applyReplacementsAsync(fileContent, selResult.selected, findStr, replaceStr, mode, caseSensitive, readingOptions);

  let warning: string | undefined = hintsWarning;
  if (usedFallback === 'whitespace') {
    warning = 'Exact match failed; used whitespace-normalized match instead.';
  } else if (usedFallback === 'fuzzy-lines') {
    warning = 'Exact match failed; used fuzzy line match (content may differ slightly, verify the edit).';
  }

  return { newContent, occurrencesReplaced: selResult.selected.length, warning };
}
