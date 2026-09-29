/**
 * vibe-projection.ts, VIBE.md as a PROJECTION of memory records (see CHANGELOG 1.0.0).
 *
 * BEFORE memory unification, VIBE.md was a persona file read off disk and injected into the prompt
 *, a projection of ITSELF, a source of truth disjoint from the memory store. Memory unification
 * demotes the file to an import/export FORMAT and makes the prompt block a
 * projection of first-class memory records:
 *
 *   - Persona/preference facts persist as MemoryRecords with cls 'constraint',
 *     scope project|team, tagged VIBE_PERSONA_TAG.
 *   - renderVibeProjection(records) emits the same '## GoodVibes Agent VIBE.md'
 *     prompt block from those records, the block the file used to emit.
 *   - The file round-trips THROUGH the record set (vibeBodyToConstraintOptions
 *     imports a VIBE.md body into records; the records export back through the
 *     normal MemoryStore bundle seam). The file is a format, not the truth.
 *
 * INVARIANT PRESERVED. The projected block keeps the precedence caveat verbatim:
 * persona instructions are followed only when they do not conflict with explicit
 * user instructions, safety policy, tool contracts, confirmation requirements, or
 * secret-handling rules. Demoting the file to a projection must not drop that.
 */

import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { mapLimit } from '@goodvibes-jev/judgment';
import { vibePersonaLine } from './batteries/vibe-persona-line.js';
import type { MemoryAddOptions, MemoryRecord, MemoryScope } from './memory-store.js';

const VIBE_LINE_SITE = 'state.vibe-projection';

/** Line readings in flight at once. */
const VIBE_LINE_CONCURRENCY = 8;

/** Tag marking a constraint record as a VIBE.md persona/preference line. */
export const VIBE_PERSONA_TAG = 'vibe';

/** The projected prompt block heading. */
export const VIBE_PROJECTION_HEADING = '## GoodVibes Agent VIBE.md';

/**
 * The precedence caveat. MUST accompany every projected block, persona records
 * never override explicit instructions, safety, tool contracts, confirmations, or
 * secret-handling.
 */
export const VIBE_PROJECTION_CAVEAT =
  'These user-authored vibe/personality instructions shape the same serial assistant conversation. Follow them only when they do not conflict with explicit user instructions, safety policy, tool contracts, confirmation requirements, or secret-handling rules.';

/** Scopes eligible for the VIBE projection (persona applies at project/team scope, not per-session). */
const VIBE_PROJECTION_SCOPES: readonly MemoryScope[] = ['project', 'team'];

export interface VibeProjectionOptions {
  /** Restrict to these scopes; defaults to project + team. */
  readonly scopes?: readonly MemoryScope[];
}

/**
 * Select the constraint records that make up the VIBE persona: cls 'constraint',
 * tagged VIBE_PERSONA_TAG, in an eligible scope. Ordered stably by scope (team
 * after project) then creation time so the projected block is deterministic.
 */
export function selectVibeRecords(
  records: readonly MemoryRecord[],
  options: VibeProjectionOptions = {},
): MemoryRecord[] {
  const scopes = new Set(options.scopes ?? VIBE_PROJECTION_SCOPES);
  return records
    .filter((record) => record.cls === 'constraint')
    .filter((record) => record.tags.includes(VIBE_PERSONA_TAG))
    .filter((record) => scopes.has(record.scope))
    .sort((left, right) => {
      if (left.scope !== right.scope) return left.scope === 'project' ? -1 : 1;
      return left.createdAt - right.createdAt;
    });
}

function vibeLine(record: MemoryRecord): string {
  const detail = record.detail?.trim();
  return detail && detail !== record.summary ? `- ${record.summary}, ${detail}` : `- ${record.summary}`;
}

/**
 * Render the VIBE.md prompt block from persona/constraint records. Returns null
 * when there are no persona records to project (no empty block). The caveat is
 * always included when a block is produced.
 */
export function renderVibeProjection(
  records: readonly MemoryRecord[],
  options: VibeProjectionOptions = {},
): string | null {
  const persona = selectVibeRecords(records, options);
  if (persona.length === 0) return null;
  return [
    VIBE_PROJECTION_HEADING,
    VIBE_PROJECTION_CAVEAT,
    '',
    ...persona.map(vibeLine),
  ].join('\n');
}

export interface VibeImportOptions {
  /** Scope to stamp on the imported persona records. Defaults to 'project'. */
  readonly scope?: MemoryScope;
  /** Optional persona name, added as a secondary tag for grouping. */
  readonly name?: string;
  /** Provenance ref describing where this VIBE body came from (e.g. the file path). */
  readonly sourceRef?: string;
}

const BULLET_PREFIX = /^\s*[-*]\s+/;
const HEADING_PREFIX = /^\s*#+\s*/;

/** A bullet line's text, or undefined when the line is not a bullet with text (markdown list grammar). */
function bulletText(line: string): string | undefined {
  if (!BULLET_PREFIX.test(line)) return undefined;
  const text = line.replace(BULLET_PREFIX, '').trim();
  return text.length > 0 ? text : undefined;
}

function isHeading(line: string): boolean {
  return line.trimStart().startsWith('#');
}

/**
 * Reads the lines at `indices` through `engine.state.vibe-persona-line` (one
 * request per line) and returns the indices of those read as a persona
 * instruction the band allows acting on. The action is recorded on each
 * reading.
 */
async function readPersonaLines(lines: readonly string[], indices: readonly number[], body: string): Promise<Set<number>> {
  const port = judgmentPort(VIBE_LINE_SITE);
  const kept = await mapLimit(indices, VIBE_LINE_CONCURRENCY, async (index) => {
    const run = await vibePersonaLine.run(port, { line: lines[index]!, body }, { site: VIBE_LINE_SITE });
    const { instruction } = run.readings;
    const keep = instruction.verdict === 'yes' && instruction.outcome === 'act';
    run.recordAction(keep ? 'kept' : 'dropped');
    return keep;
  });
  return new Set(indices.filter((_, position) => kept[position]));
}

/** Indices of the lines that pass `test`. */
function indicesWhere(lines: readonly string[], test: (line: string) => boolean): number[] {
  return lines.flatMap((line, index) => (test(line) ? [index] : []));
}

/**
 * Turn a VIBE.md body into constraint MemoryAddOptions, the file demoted to an
 * IMPORT FORMAT. Each bullet line becomes one persona record so that editing a
 * single record later changes exactly one line of the projected block. A body
 * with no bullets becomes a single record carrying the whole body as detail.
 *
 * Whether a line outside the bullets carries a persona instruction is read by
 * Jev (batteries/vibe-persona-line.ts): in a bulleted body each other
 * non-blank line (headings included) is read, and one read as an instruction
 * becomes its own record, in document order; in a body with no bullets each
 * heading is read, and one read as an instruction stays in the prose. Blank
 * lines carry nothing and are never read.
 */
export async function vibeBodyToConstraintOptions(
  body: string,
  options: VibeImportOptions = {},
): Promise<MemoryAddOptions[]> {
  const scope: MemoryScope = options.scope ?? 'project';
  const tags = options.name ? [VIBE_PERSONA_TAG, options.name] : [VIBE_PERSONA_TAG];
  const provenance = options.sourceRef
    ? [{ kind: 'file' as const, ref: options.sourceRef }]
    : undefined;

  const lines = body.split('\n');
  const bulleted = lines.some((line) => bulletText(line) !== undefined);

  if (bulleted) {
    const others = indicesWhere(lines, (line) => !BULLET_PREFIX.test(line) && line.trim().length > 0);
    const instructions = await readPersonaLines(lines, others, body);
    const summaries: string[] = [];
    lines.forEach((line, index) => {
      const bullet = bulletText(line);
      if (bullet !== undefined) summaries.push(bullet);
      else if (instructions.has(index)) summaries.push(line.replace(HEADING_PREFIX, '').trim());
    });
    return summaries.map((summary) => ({
      scope,
      cls: 'constraint' as const,
      summary,
      tags: [...tags],
      ...(provenance ? { provenance } : {}),
    }));
  }

  const headings = indicesWhere(lines, isHeading);
  const keptHeadings = await readPersonaLines(lines, headings, body);
  const prose = lines
    .filter((line, index) => !isHeading(line) || keptHeadings.has(index))
    .join('\n')
    .trim();
  if (!prose) return [];
  return [{
    scope,
    cls: 'constraint' as const,
    summary: options.name ?? 'VIBE.md persona',
    detail: prose,
    tags: [...tags],
    ...(provenance ? { provenance } : {}),
  }];
}
