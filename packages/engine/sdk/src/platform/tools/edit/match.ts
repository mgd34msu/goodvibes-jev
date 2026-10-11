import { assertCapturedToolAccessCurrent } from '../shared/captured-input-tools.js';
import { extname } from 'node:path';
import { logger } from '../../utils/logger.js';
import { CodeIntelligence } from '../../intelligence/index.js';
import type { EditItem, OccurrenceSpec, EditResult, EditResultStatus } from './types.js';
import { summarizeError } from '../../utils/error-display.js';
import { assertSafeRegexInput, compileSafeRegExp, createSafeRegex, safeRegExpExec } from '../../utils/safe-regex.js';
import { judgmentPort, type JudgmentReadingOptions } from '@goodvibes-jev/engine/errors';
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

const MAX_FUZZY_FILE_LINES = 5000;

/** The decision site the edit-target reading is logged under. */
export const EDIT_TARGET_SITE = 'tools.edit-fuzzy-line';

/**
 * The shortlist for a fuzzy line match (arithmetic, no acceptance): slides a
 * window of the find text's line count over the file and returns the window
 * with the largest share of lines equal to the find text's lines after
 * whitespace normalization. Null when the file is too large or no window
 * shares a single line with the find text. Whether the window is edited is
 * the `engine.tools.edit-target` reading's call (see computeSingleEdit).
 */
export function findFuzzyLineMatch(
  content: string,
  findStr: string,
): { start: number; end: number; similarity: number; candidateLines: string[] } | null {
  const findLines = findStr.split('\n');
  const contentLines = content.split('\n');

  if (findLines.length === 0 || contentLines.length === 0) return null;
  if (contentLines.length > MAX_FUZZY_FILE_LINES) return null;

  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of contentLines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }

  const normalizedFind = findLines.map(normalizeWhitespace);
  const normalizedContent = contentLines.map(normalizeWhitespace);
  const windowSize = findLines.length;

  let bestSimilarity = -1;
  let bestStart = 0;
  let bestEnd = 0;
  let bestCandidateLines: string[] = [];

  const limit = contentLines.length - windowSize + 1;
  for (let i = 0; i < limit; i++) {
    let matchingLines = 0;
    for (let j = 0; j < windowSize; j++) {
      if (normalizedContent[i + j] === normalizedFind[j]) {
        matchingLines++;
      }
    }
    const similarity = matchingLines / windowSize;
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestStart = lineOffsets[i]!;
      // The window ends where its last line's text ends, so the newline after it is kept.
      const lastLineIdx = i + windowSize - 1;
      bestEnd = lineOffsets[lastLineIdx]! + contentLines[lastLineIdx]!.length;
      bestCandidateLines = contentLines.slice(i, i + windowSize);
      if (similarity === 1.0) break;
    }
  }

  if (bestSimilarity <= 0) return null;
  return { start: bestStart, end: bestEnd, similarity: bestSimilarity, candidateLines: bestCandidateLines };
}

/** @deprecated Synchronous compatibility; production regex edits use findAllPositionsAsync. */
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
    assertSafeRegexInput(content, { operation: 'edit regex search', maxInputChars: 500_000 });
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
  await using pattern = await createSafeRegex(find, flags, { ...options, operation: 'edit regex search', maxInputChars: 500_000 });
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
    const budget = 2_000_000 - (result.length - (end - start));
    if (budget < 0 || replace.length > 2_000_000) throw new Error('edit regex replacement output exceeds 2000000 characters');
    const parts: string[] = [];
    let size = 0, cursor = 0;
    const append = (part: string) => {
      if (size + part.length > budget) throw new Error('edit regex replacement output exceeds 2000000 characters');
      size += part.length; if (part.length) parts.push(part);
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

export function classifyEditFailure(message: string): EditResultStatus {
  if (message.includes('not found') || message.includes('No match')) return 'not_found';
  if (message.includes('Ambiguous') || message.includes('ambiguous')) return 'ambiguous';
  if (message.includes('OCC conflict') || message.includes('modified externally')) return 'conflict';
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

/**
 * Whether the fuzzy line window may be edited: the edit-target reading must
 * say yes with enough confidence to act. A yes that would only confirm is
 * refused and shown back as a "Did you mean this?" hint, so the caller
 * confirms by resending the corrected find text.
 */
async function acceptsEditTarget(
  findStr: string,
  windowLines: readonly string[],
): Promise<{ accepted: boolean; probability: number }> {
  await assertCapturedToolAccessCurrent();
  const run = await editTarget.run(judgmentPort(EDIT_TARGET_SITE), editTargetView(findStr, windowLines), {
    site: EDIT_TARGET_SITE,
  });
  const reading = run.readings.same_target;
  const accepted = reading.verdict === 'yes' && reading.outcome === 'act';
  run.recordAction(accepted ? 'applied fuzzy line match' : 'refused fuzzy line match');
  return { accepted, probability: reading.probability };
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
      const fuzzyMatch = findFuzzyLineMatch(fileContent, findStr);
      const target = fuzzyMatch === null ? null : await acceptsEditTarget(findStr, fuzzyMatch.candidateLines);
      if (fuzzyMatch !== null && target?.accepted) {
        positions = [{ start: fuzzyMatch.start, end: fuzzyMatch.end }];
        usedFallback = 'fuzzy-lines';
        logger.warn('[edit] Fuzzy line match used', {
          similarity: fuzzyMatch.similarity,
          probability: target.probability,
          file: item.path,
          findPreview: findStr.split('\n').slice(0, 2).join('\n'),
        });
      } else if (fuzzyMatch !== null) {
        const candidatePreview = fuzzyMatch.candidateLines.slice(0, 3).join('\n');
        const startLine = lineNumberAt(fileContent, fuzzyMatch.start);
        return {
          error:
            `Find string not found in file (the closest lines, from line ${startLine}, were not read as the same edit target).\n` +
            `Closest candidate (first 3 lines):\n${candidatePreview}\n` +
            `Tip: correct the find string to match the file content exactly.`,
          hint: `Did you mean this? (from line ${startLine}):\n${candidatePreview}`,
        };
      } else {
        return {
          error: 'Find string not found in file',
          hint: 'The find string was not found. Check spelling, whitespace, and that the file has been read recently.',
        };
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
