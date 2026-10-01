/**
 * highlight.ts, Shared highlight.js instance for the GoodVibes web UI.
 *
 * Registers all supported languages exactly once (module-level singleton).
 * Exports:
 *   - LANGUAGE_ALIASES , normalised alias map
 *   - escapeHtml       , minimal HTML escaper
 *   - normalizeLanguage, alias resolution
 *   - highlightCode    , highlight or auto-detect, falling back to escapeHtml
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

export const LANGUAGE_ALIASES: Record<string, string> = {
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cmd: 'bash',
  cs: 'csharp',
  docker: 'dockerfile',
  env: 'ini',
  htm: 'xml',
  html: 'xml',
  js: 'javascript',
  jsx: 'javascript',
  md: 'markdown',
  mjs: 'javascript',
  ps1: 'shell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  svg: 'xml',
  toml: 'ini',
  ts: 'typescript',
  tsx: 'typescript',
  txt: 'plaintext',
  xml: 'xml',
  yml: 'yaml',
  zsh: 'bash',
};

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
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

/**
 * Highlight `code` for the given `language`.
 *
 * - If `language` resolves to a registered hljs language, use it.
 * - If `language` is empty/unknown but code is non-empty, auto-detect.
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
  if (!normalizedLanguage && code.trim()) {
    const result = hljs.highlightAuto(code);
    return { language: result.language ?? '', html: result.value };
  }
  return { language: normalizedLanguage, html: escapeHtml(code) };
}
