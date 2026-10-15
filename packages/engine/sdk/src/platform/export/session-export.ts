import { join } from 'node:path';
import type { ContentPart } from '../providers/interface.js';
import { exportToMarkdown, extractText, type ExportMessage, type ExportMetadata } from './markdown.js';
import { redactSensitiveDataAsync, redactStructuredDataAsync, type RedactionOptions } from '../utils/redaction.js';
import { captureOwnedJson } from '../gate/judgment-input.js';
import { types } from 'node:util';

// ── Public Types ─────────────────────────────────────────────────────────────

export type { ExportMessage, ExportMetadata };

export interface ExportOptions extends RedactionOptions {
  /** Redact API keys, absolute file paths, and other sensitive data. */
  redact?: boolean | undefined;
}

export interface SessionExportData {
  messages: ExportMessage[];
  metadata?: ExportMetadata | undefined;
  /** Cost in USD, if tracked. */
  cost?: number | undefined;
  /** ISO timestamp of export. */
  exportedAt?: string | undefined;
}

// ── Message redaction helper ─────────────────────────────────────────────────

/**
 * redactMessage - Deep-clone a message and redact all string fields that may
 * contain sensitive data (content, reasoning, tool arguments).
 */
export async function redactMessage(msg: ExportMessage, options: RedactionOptions = {}): Promise<ExportMessage> {
  const source = captureExportSource(msg, options);
  const captured = source.value;
  const reading = { ...options, purpose: 'export' as const, assertCurrent: source.assertCurrent };
  const clone: ExportMessage = { role: captured.role, content: typeof captured.content === 'string'
    ? await redactSensitiveDataAsync(captured.content, reading)
    : await Promise.all(captured.content.map(async (part): Promise<ContentPart> => ({ type: 'text',
      text: part.type === 'text' ? await redactSensitiveDataAsync(part.text, reading) : '[REDACTED_ATTACHMENT]',
    }))) };
  if (captured.reasoningContent !== undefined) clone.reasoningContent = await redactSensitiveDataAsync(captured.reasoningContent, reading);
  if (captured.reasoningSummary !== undefined) clone.reasoningSummary = await redactSensitiveDataAsync(captured.reasoningSummary, reading);
  if (captured.toolName !== undefined) clone.toolName = await redactSensitiveDataAsync(captured.toolName, reading);
  if (captured.callId !== undefined) clone.callId = await redactSensitiveDataAsync(captured.callId, reading);
  if (captured.toolCalls) clone.toolCalls = await Promise.all(captured.toolCalls.map(async (tc) => ({
    id: await redactSensitiveDataAsync(tc.id, reading), name: await redactSensitiveDataAsync(tc.name, reading),
    arguments: await redactArgs(tc.arguments, reading),
  })));
  if (captured.usage) clone.usage = {
    inputTokens: captured.usage.inputTokens, outputTokens: captured.usage.outputTokens,
    ...(captured.usage.cacheReadTokens !== undefined ? { cacheReadTokens: captured.usage.cacheReadTokens } : {}),
    ...(captured.usage.cacheWriteTokens !== undefined ? { cacheWriteTokens: captured.usage.cacheWriteTokens } : {}),
  };
  if (captured.cancelled !== undefined) clone.cancelled = captured.cancelled;
  source.assertCurrent();
  return clone;
}

/** Capture every consumed field before awaiting, and bind reads to that exact source. */
function captureExportSource<T>(input: T, options: RedactionOptions) {
  const original = JSON.stringify(captureOwnedJson(input, types.isProxy));
  const value = structuredClone(input);
  if (JSON.stringify(captureOwnedJson(value, types.isProxy)) !== original) throw new Error('Export source changed during capture');
  const signal = options.signal, ownerCurrent = options.assertCurrent;
  const purpose = options.purpose, secrets = JSON.stringify(captureOwnedJson(options.secretValues ?? []));
  const assertCurrent = () => {
    if (signal?.aborted || options.signal !== signal || options.assertCurrent !== ownerCurrent
      || options.purpose !== purpose || JSON.stringify(captureOwnedJson(options.secretValues ?? [])) !== secrets
      || JSON.stringify(captureOwnedJson(input, types.isProxy)) !== original) throw new Error('Export source is no longer current');
    ownerCurrent?.();
  };
  assertCurrent();
  return { value, assertCurrent };
}

// ── JSON export ───────────────────────────────────────────────────────────────

/**
 * exportToJSON - Serialize a session to machine-readable JSON.
 *
 * Output includes metadata (model, provider, session ID, timestamp, token
 * usage totals, cost), then the message array. Redacted messages contain only
 * declared export fields; undeclared source properties are withheld.
 */
export async function exportToJSON(
  messages: ExportMessage[],
  metadata?: ExportMetadata,
  options: ExportOptions & { cost?: number } = {},
): Promise<string> {
  const source = captureExportSource({ messages, metadata }, options);
  messages = source.value.messages; metadata = source.value.metadata;
  const reading = { ...options, purpose: 'export' as const, assertCurrent: source.assertCurrent };
  const { redact = false, cost } = options;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  const processedMessages = await Promise.all(messages.map(async (msg) => {
    if (msg.usage) {
      totalInput     += msg.usage.inputTokens  ?? 0;
      totalOutput    += msg.usage.outputTokens ?? 0;
      totalCacheRead  += msg.usage.cacheReadTokens  ?? 0;
      totalCacheWrite += msg.usage.cacheWriteTokens ?? 0;
    }

    if (!redact) return msg;
    return redactMessage(msg, reading);
  }));

  const usage = {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    ...(totalCacheRead  > 0 ? { cacheReadTokens: totalCacheRead }   : {}),
    ...(totalCacheWrite > 0 ? { cacheWriteTokens: totalCacheWrite } : {}),
  };

  const payload: Record<string, unknown> = {
    version: 1,
    exportedAt: new Date().toISOString(),
    redacted: redact,
    metadata: {
      ...((redact ? await redactMetadata(metadata, reading) : metadata) ?? {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
    },
    tokenUsage: usage,
    messages: processedMessages,
  };

  source.assertCurrent();
  return JSON.stringify(payload, null, 2);
}

/** The shared helper owns field-role reading, structure and protection. */
async function redactArgs(args: Record<string, unknown>, options: RedactionOptions): Promise<Record<string, unknown>> {
  const result = await redactStructuredDataAsync(args, options);
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return { withheld: '[REDACTED_ARGUMENTS]' };
  return Object.fromEntries(Object.entries(result));
}

/** Every metadata string is outgoing source text. */
async function redactMetadata(metadata: ExportMetadata | undefined, options: RedactionOptions): Promise<ExportMetadata | undefined> {
  if (metadata === undefined) return undefined;
  const output: ExportMetadata = {};
  for (const key of ['model', 'provider', 'sessionId', 'title'] as const) {
    const value = metadata[key];
    if (value !== undefined) output[key] = await redactSensitiveDataAsync(value, options);
  }
  return output;
}

// ── Markdown export (extended wrapper) ───────────────────────────────────────

/**
 * exportToMarkdownExtended - Wrapper around markdown.ts exportToMarkdown that
 * adds cost information and optional redaction.
 */
export async function exportToMarkdownExtended(
  messages: ExportMessage[],
  metadata?: ExportMetadata,
  options: ExportOptions & { cost?: number } = {},
): Promise<string> {
  const source = captureExportSource({ messages, metadata }, options);
  messages = source.value.messages; metadata = source.value.metadata;
  const reading = { ...options, purpose: 'export' as const, assertCurrent: source.assertCurrent };
  const { redact = false, cost } = options;

  const processedMessages = redact ? await Promise.all(messages.map((message) => redactMessage(message, reading))) : messages;

  const md = exportToMarkdown(processedMessages, redact ? await redactMetadata(metadata, reading) : metadata);
  source.assertCurrent();

  // Append cost if provided
  if (cost !== undefined && cost > 0) {
    const costLines: string[] = [
      '',
      '## Cost',
      '',
      `| Metric | Value |`,
      `|--------|-------|`,
      `| Estimated cost | $${cost.toFixed(6)} USD |`,
      '',
    ];
    return md + costLines.join('\n');
  }

  return md;
}

// ── HTML export ───────────────────────────────────────────────────────────────

/** Maximum characters of tool result content to include in the HTML export. */

/**
 * exportToHTML - Generate a self-contained, styled HTML document from a
 * conversation. Features:
 *
 * - Embedded CSS (dark theme, readable typography)
 * - Syntax-highlighted fenced code blocks (language class on <code>)
 * - Collapsible <details> sections for tool calls and tool results
 * - Metadata table in the header
 * - Token usage and cost summary at the foot
 */
export async function exportToHTML(
  messages: ExportMessage[],
  metadata?: ExportMetadata,
  options: ExportOptions & { cost?: number } = {},
): Promise<string> {
  const source = captureExportSource({ messages, metadata }, options);
  messages = source.value.messages; metadata = source.value.metadata;
  const reading = { ...options, purpose: 'export' as const, assertCurrent: source.assertCurrent };
  const { redact = false, cost } = options;

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;

  const now = new Date();
  const dateStr = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const shown = redact ? await redactMetadata(metadata, reading) : metadata;
  const title = shown?.title || shown?.sessionId || 'Conversation';

  const sections: string[] = [];
  const processedMessages = redact ? await Promise.all(messages.map((message) => redactMessage(message, reading))) : messages;

  for (const msg of processedMessages) {
    if (msg.role === 'system') continue; // skip system messages in HTML

    if (msg.role === 'user') {
      const rawContent = extractText(msg.content);
      const content = rawContent;
      const images: Array<{ type: 'image'; data: string; mediaType: string }> = Array.isArray(msg.content)
        ? (msg.content as ContentPart[]).filter((p): p is { type: 'image'; data: string; mediaType: string } => p.type === 'image')
        : [];

      let html = `<div class="message user">`;
      html += `<div class="message-header"><span class="role">User</span></div>`;
      html += `<div class="message-body">${renderMarkdownToHtml(content)}</div>`;
      if (images.length > 0) {
        html += `<div class="attachments">`;
        for (const img of images) {
          html += `<img src="data:${escapeHtml(img.mediaType)};base64,${img.data}" alt="attachment" class="attachment-image" />`;
        }
        html += `</div>`;
      }
      html += `</div>`;
      sections.push(html);
      continue;
    }

    if (msg.role === 'assistant') {
      const rawContent = extractText(msg.content);
      const content = rawContent;

      if (msg.usage) {
        totalInput     += msg.usage.inputTokens  ?? 0;
        totalOutput    += msg.usage.outputTokens ?? 0;
        totalCacheRead  += msg.usage.cacheReadTokens  ?? 0;
        totalCacheWrite += msg.usage.cacheWriteTokens ?? 0;
      }

      let html = `<div class="message assistant">`;
      html += `<div class="message-header"><span class="role">Assistant</span></div>`;
      html += `<div class="message-body">`;

      if (msg.reasoningSummary) {
        const summary = msg.reasoningSummary;
        html += `<details class="reasoning">`;
        html += `<summary>Reasoning summary</summary>`;
        html += `<div class="details-body">${escapeHtml(summary)}</div>`;
        html += `</details>`;
      }

      if (content.trim()) {
        html += renderMarkdownToHtml(content);
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          let args: string;
          try {
            const processedArgs = tc.arguments;
            args = JSON.stringify(processedArgs, null, 2);
          } catch {
            args = '[REDACTED_ARGUMENTS]';
          }
          html += `<details class="tool-call">`;
          html += `<summary>Tool call: <code>${escapeHtml(tc.name)}</code></summary>`;
          html += `<div class="details-body"><pre><code class="language-json">${escapeHtml(args)}</code></pre></div>`;
          html += `</details>`;
        }
      }

      html += `</div></div>`;
      sections.push(html);
      continue;
    }

    if (msg.role === 'tool') {
      const rawContent = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
      const content = rawContent;
      const toolLabel = msg.toolName ? `Tool result: ${escapeHtml(msg.toolName)}` : 'Tool result';
      const truncated = content;

      let html = `<div class="message tool">`;
      html += `<details class="tool-result">`;
      html += `<summary>${toolLabel}</summary>`;
      html += `<div class="details-body"><pre><code>${escapeHtml(truncated)}</code></pre></div>`;
      html += `</details>`;
      html += `</div>`;
      sections.push(html);
      continue;
    }
  }

  // Build metadata rows
  const metaRows: string[] = [
    `<tr><th>Date</th><td>${escapeHtml(dateStr)}</td></tr>`,
  ];
  if (shown?.model)     metaRows.push(`<tr><th>Model</th><td>${escapeHtml(shown.model)}</td></tr>`);
  if (shown?.provider)  metaRows.push(`<tr><th>Provider</th><td>${escapeHtml(shown.provider)}</td></tr>`);
  if (shown?.sessionId) metaRows.push(`<tr><th>Session</th><td>${escapeHtml(shown.sessionId)}</td></tr>`);
  if (redact)              metaRows.push(`<tr><th>Redacted</th><td>Yes</td></tr>`);

  // Build usage rows
  const usageRows: string[] = [];
  if (totalInput > 0 || totalOutput > 0) {
    usageRows.push(
      `<tr><th>Input tokens</th><td>${totalInput.toLocaleString()}</td></tr>`,
      `<tr><th>Output tokens</th><td>${totalOutput.toLocaleString()}</td></tr>`,
    );
    if (totalCacheRead  > 0) usageRows.push(`<tr><th>Cache read tokens</th><td>${totalCacheRead.toLocaleString()}</td></tr>`);
    if (totalCacheWrite > 0) usageRows.push(`<tr><th>Cache write tokens</th><td>${totalCacheWrite.toLocaleString()}</td></tr>`);
  }
  if (cost !== undefined && cost > 0) {
    usageRows.push(`<tr><th>Estimated cost</th><td>$${cost.toFixed(6)} USD</td></tr>`);
  }

  const usageSection = usageRows.length > 0
    ? `<section class="usage"><h2>Usage</h2><table>${usageRows.join('')}</table></section>`
    : '';

  source.assertCurrent();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
${CSS}
</style>
</head>
<body>
<article class="session">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <table class="meta">${metaRows.join('')}</table>
  </header>
  <div class="messages">
${sections.map(s => '    ' + s).join('\n')}
  </div>
${usageSection}
</article>
</body>
</html>`;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

/** Escape characters that are special in HTML. */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

/** Minimal Markdown-to-HTML renderer (bold, italic, code, fenced blocks, headers, paragraphs). */
function renderMarkdownToHtml(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let inFence = false;
  let fenceLang = '';
  let fenceLines: string[] = [];
  let inParagraph = false;

  const flushParagraph = () => {
    if (inParagraph) {
      out.push('</p>');
      inParagraph = false;
    }
  };

  const flushFence = () => {
    const langClass = fenceLang ? ` class="language-${escapeHtml(fenceLang)}"` : '';
    out.push(`<pre><code${langClass}>${fenceLines.map(escapeHtml).join('\n')}</code></pre>`);
    fenceLines = [];
    fenceLang = '';
    inFence = false;
  };

  for (const line of lines) {
    if (inFence) {
      if (line.trimStart().startsWith('```')) {
        flushParagraph();
        flushFence();
      } else {
        fenceLines.push(line);
      }
      continue;
    }

    // Fenced code block start
    const fenceMatch = line.match(/^(`{3,})(\w*)/);
    if (fenceMatch) {
      flushParagraph();
      inFence = true;
      fenceLang = fenceMatch[2]! ?? '';
      continue;
    }

    // ATX headings
    const h3 = line.match(/^#{3,6}\s+(.*)/);
    if (h3) { flushParagraph(); out.push(`<h3>${inlineMarkdown(h3[1]!)}</h3>`); continue; }
    const h2 = line.match(/^##\s+(.*)/);
    if (h2) { flushParagraph(); out.push(`<h2>${inlineMarkdown(h2[1]!)}</h2>`); continue; }
    const h1 = line.match(/^#\s+(.*)/);
    if (h1) { flushParagraph(); out.push(`<h1>${inlineMarkdown(h1[1]!)}</h1>`); continue; }

    // Blank line ends paragraph
    if (line.trim() === '') {
      flushParagraph();
      continue;
    }

    // Inline content, wrap in paragraph
    if (!inParagraph) {
      out.push('<p>');
      inParagraph = true;
    } else {
      out.push('<br />');
    }
    out.push(inlineMarkdown(line));
  }

  if (inFence) flushFence();
  flushParagraph();

  return out.join('\n');
}

/** Apply inline Markdown: bold, italic, inline code. */
function inlineMarkdown(text: string): string {
  return escapeHtml(text)
    // Bold before italic so **word** is processed before *word*
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}



// ── Embedded CSS ──────────────────────────────────────────────────────────────

const CSS = `
*, *::before, *::after { box-sizing: border-box; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
  font-size: 15px;
  line-height: 1.6;
  background: #0d1117;
  color: #c9d1d9;
  margin: 0;
  padding: 24px 16px;
}

article.session {
  max-width: 860px;
  margin: 0 auto;
}

header h1 {
  font-size: 1.4em;
  font-weight: 600;
  color: #f0f6fc;
  margin: 0 0 12px;
}

table.meta, table {
  border-collapse: collapse;
  margin-bottom: 24px;
  width: 100%;
}

table.meta th, table.meta td,
table th, table td {
  padding: 6px 12px;
  border: 1px solid #30363d;
  text-align: left;
}

table.meta th, table th {
  color: #8b949e;
  font-weight: normal;
  background: #161b22;
  width: 140px;
}

.messages { display: flex; flex-direction: column; gap: 16px; }

.message {
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #30363d;
}

.message.user { border-color: #1f6feb; }
.message.assistant { border-color: #388bfd33; }
.message.tool { border-color: #30363d; }

.message-header {
  padding: 6px 14px;
  font-size: 0.78em;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.message.user    .message-header { background: #1f6feb22; color: #58a6ff; }
.message.assistant .message-header { background: #388bfd11; color: #79c0ff; }

.message-body { padding: 14px; }

p { margin: 0 0 10px; }
p:last-child { margin-bottom: 0; }

pre {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 14px;
  overflow-x: auto;
  margin: 10px 0;
}

code {
  font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
  font-size: 0.875em;
}

pre code {
  background: none;
  padding: 0;
  font-size: 0.85em;
  color: #e6edf3;
}

:not(pre) > code {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 1px 6px;
  color: #e6edf3;
}

details {
  margin: 8px 0;
  border: 1px solid #30363d;
  border-radius: 6px;
  overflow: hidden;
}

details summary {
  padding: 8px 14px;
  cursor: pointer;
  background: #161b22;
  color: #8b949e;
  font-size: 0.85em;
  user-select: none;
  list-style: none;
}

details summary:hover { background: #1c2128; color: #c9d1d9; }
details[open] summary { border-bottom: 1px solid #30363d; color: #c9d1d9; }

details.reasoning summary { color: #7ee787; }
details.tool-call  summary code { color: #d2a8ff; }

.details-body { padding: 12px 14px; background: #0d1117; }
.details-body pre { margin: 0; }

.attachment-image {
  max-width: 100%;
  border-radius: 6px;
  margin-top: 10px;
  border: 1px solid #30363d;
}

section.usage {
  margin-top: 32px;
  border-top: 1px solid #30363d;
  padding-top: 16px;
}

section.usage h2 {
  font-size: 1em;
  font-weight: 600;
  color: #8b949e;
  margin: 0 0 10px;
}

h1 { font-size: 1.25em; color: #f0f6fc; }
h2 { font-size: 1.1em;  color: #f0f6fc; margin: 16px 0 8px; }
h3 { font-size: 1em;   color: #f0f6fc; margin: 14px 0 6px; }

strong { color: #f0f6fc; }
em { color: #a5d6ff; font-style: italic; }
`.trim();

// ── Default export path ───────────────────────────────────────────────────────

/**
 * defaultExportPath - Build the default output path for a share export.
 *
 * Format: ~/goodvibes-exports/session-<timestamp>.<ext>
 */
export function defaultExportPath(format: 'html' | 'json' | 'md', homeDirectory: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return join(homeDirectory, 'goodvibes-exports', `session-${ts}.${format}`);
}
