/** SDK-owned platform module. This implementation is maintained in goodvibes-sdk. */

import { knownContentPartIsReasoning, readContentPartIsReasoning } from '../routing/provider-readings.js';

/**
 * The documented content-part type labels of OpenAI-compatible streams, an
 * exact wire table: these carry reasoning, these carry the answer. A label
 * outside the table is read once by routing.content-part-kind
 * (readStreamDeltaLabels) before the chunk is split; nothing is decided by a
 * substring of the label.
 */
const REASONING_PART_TYPES: ReadonlySet<string> = new Set([
  'reasoning', 'reasoning_text', 'reasoning_content', 'reasoning_summary', 'thinking', 'thinking_delta', 'redacted_thinking',
]);
const ANSWER_PART_TYPES: ReadonlySet<string> = new Set(['text', 'output_text', 'input_text', 'refusal']);

/** Whether a typed content part carries reasoning: the wire table, else the remembered reading. */
function partIsReasoning(type: string): boolean {
  if (REASONING_PART_TYPES.has(type)) return true;
  if (ANSWER_PART_TYPES.has(type)) return false;
  const read = knownContentPartIsReasoning(type);
  if (read === undefined) throw new Error(`Content part type '${type}' has not been read; await readStreamDeltaLabels(chunk) before extracting the chunk.`);
  return read;
}

/** The typed content-part labels a chunk carries. */
function contentPartTypes(rawChunk: unknown): string[] {
  const content = (rawChunk as { choices?: Array<{ delta?: Record<string, unknown> }> }).choices?.[0]?.delta?.content;
  if (!Array.isArray(content)) return [];
  return content
    .map((entry) => (entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).type === 'string' ? ((entry as Record<string, unknown>).type as string).toLowerCase() : ''))
    .filter((type) => type.length > 0);
}

/** Reads every unfamiliar content-part label in a chunk (once per label per process) so the chunk can be split. */
export async function readStreamDeltaLabels(rawChunk: unknown, site: string): Promise<void> {
  const unread = [...new Set(contentPartTypes(rawChunk))].filter(
    (type) => !REASONING_PART_TYPES.has(type) && !ANSWER_PART_TYPES.has(type) && knownContentPartIsReasoning(type) === undefined,
  );
  await Promise.all(unread.map((type) => readContentPartIsReasoning(type, site)));
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function collectTextFragments(value: unknown, keys: string[]): string[] {
  if (!Array.isArray(value)) return [];

  const fragments: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry.length > 0) fragments.push(entry);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.type === 'string') continue;
    for (const key of keys) {
      const found = asString(record[key]);
      if (found) {
        fragments.push(found);
        break;
      }
    }
  }
  return fragments;
}

function collectContentFragments(
  value: unknown,
  options: { includeTypedReasoning: boolean },
): string[] {
  if (!Array.isArray(value)) return [];

  const fragments: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry.length > 0) fragments.push(entry);
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    const text = asString(record.text)
      ?? asString(record.content)
      ?? asString(record.reasoning)
      ?? asString(record.thinking)
      ?? asString(record.delta);
    if (!text) continue;

    if (!type) {
      fragments.push(text);
      continue;
    }

    const isReasoning = partIsReasoning(type);
    if (!isReasoning || options.includeTypedReasoning) {
      fragments.push(text);
    }
  }
  return fragments;
}

function collectTypedContentFragments(value: unknown, kind: 'content' | 'reasoning'): string[] {
  if (!Array.isArray(value)) return [];
  const fragments: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    const text = asString(record.text)
      ?? asString(record.content)
      ?? asString(record.reasoning)
      ?? asString(record.thinking)
      ?? asString(record.delta);
    if (!text) continue;

    const isReasoning = partIsReasoning(type);
    if (kind === 'reasoning' && isReasoning) fragments.push(text);
    if (kind === 'content' && !isReasoning) fragments.push(text);
  }
  return fragments;
}

export interface OpenAIStreamTextDelta {
  content: string[];
  reasoning: string[];
}

export interface OpenAIStreamTextDeltaOptions {
  allowReasoning?: boolean | undefined;
}

/**
 * Normalize the wide variety of OpenAI-compatible streaming delta shapes into
 * plain content/reasoning text fragments. A chunk carrying an unfamiliar
 * content-part label must go through readStreamDeltaLabels first.
 */
export function extractOpenAIStreamTextDelta(
  rawChunk: unknown,
  options: OpenAIStreamTextDeltaOptions = {},
): OpenAIStreamTextDelta {
  const allowReasoning = options.allowReasoning ?? true;
  const raw = rawChunk as {
    choices?: Array<{
      delta?: Record<string, unknown> | undefined;
    }>;
    reasoning_summary?: string | undefined;
  };

  const delta = raw.choices?.[0]?.delta ?? {};
  const deltaContent = delta.content;
  const deltaReasoningContent = delta.reasoning_content;
  const stringContent = asString(deltaContent);
  const stringReasoning = asString(delta.reasoning);
  const stringReasoningContent = asString(deltaReasoningContent);
  const stringReasoningSummary = asString(raw.reasoning_summary);
  const content = [
    ...(stringContent ? [stringContent] : []),
    ...collectContentFragments(deltaContent, { includeTypedReasoning: !allowReasoning }),
    ...(!allowReasoning
      ? [
          ...(stringReasoning ? [stringReasoning] : []),
          ...(stringReasoningContent ? [stringReasoningContent] : []),
          ...(stringReasoningSummary ? [stringReasoningSummary] : []),
          ...collectTextFragments(deltaReasoningContent, ['text', 'content', 'reasoning', 'thinking', 'delta']),
        ]
      : []),
  ];
  const reasoning = allowReasoning
    ? [
        ...(stringReasoning ? [stringReasoning] : []),
        ...(stringReasoningContent ? [stringReasoningContent] : []),
        ...(stringReasoningSummary ? [stringReasoningSummary] : []),
        ...collectTypedContentFragments(deltaContent, 'reasoning'),
        ...collectTextFragments(deltaReasoningContent, ['text', 'content', 'reasoning', 'thinking', 'delta']),
      ]
    : [];

  return { content, reasoning };
}
