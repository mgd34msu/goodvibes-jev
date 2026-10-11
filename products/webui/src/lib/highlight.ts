/**
 * highlight.ts, Shared highlight.js instance for the GoodVibes web UI.
 *
 * Registers all supported languages exactly once (module-level singleton).
 * Exports:
 *   - escapeHtml       , minimal HTML escaper
 *   - normalizeLanguage, alias resolution
 *   - highlightCode    , highlight a declared or read language, falling back to escapeHtml
 */

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import go from 'highlight.js/lib/languages/go';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import shell from 'highlight.js/lib/languages/shell';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import wasm from 'highlight.js/lib/languages/wasm';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// ---------------------------------------------------------------------------
// One-time registration (module singleton, safe to import from multiple files)
// ---------------------------------------------------------------------------

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('css', css);
hljs.registerLanguage('diff', diff);
hljs.registerLanguage('dockerfile', dockerfile);
hljs.registerLanguage('go', go);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('java', java);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('php', php);
hljs.registerLanguage('plaintext', plaintext);
hljs.registerLanguage('python', python);
hljs.registerLanguage('ruby', ruby);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('shell', shell);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('wasm', wasm);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('yaml', yaml);

// ---------------------------------------------------------------------------
// Language alias map
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function normalizeLanguage(language: string): string {
  const normalized = language.trim().toLowerCase();
  const grammar = hljs.getLanguage(normalized);
  return grammar ? hljs.listLanguages().find(name => hljs.getLanguage(name) === grammar) ?? normalized : '';
}

/**
 * Highlight `code` for the given `language`.
 *
 * - If `language` resolves to a registered hljs language, use it.
 * - Unknown/absent tags stay plaintext until a source-owned typed reading arrives.
 * - Otherwise escape and return as-is.
 */
export function highlightCode(
  code: string,
  language: string,
): { language: string; html: string } {
  const normalizedLanguage = normalizeLanguage(language);
  if (normalizedLanguage && hljs.getLanguage(normalizedLanguage)) {
    const result = hljs.highlight(code, {
      language: normalizedLanguage,
      ignoreIllegals: true,
    });
    return { language: normalizedLanguage, html: result.value };
  }
  return { language: normalizedLanguage, html: escapeHtml(code) };
}
