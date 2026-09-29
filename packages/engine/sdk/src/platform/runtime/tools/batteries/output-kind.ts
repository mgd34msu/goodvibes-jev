/**
 * `engine.runtime.output-kind`: what kind of content an oversized tool
 * output is, for the one-line summary that replaces it under a `summary`
 * output policy (tools/output-policy.ts classifyOutput). Replaces two
 * guesses: any text starting with a letter tag and ending with `>` was
 * called xml (so an HTML page read as xml), and text was called binary-like
 * when control characters passed max(4, 2%) of it. Empty output and output
 * that parses as JSON stay code.
 *
 * One choice per summarized output; state: `{ sample, characters }`, where
 * the sample is the output's head and tail.
 *
 * Band: low stakes. The kind is one word in a summary line the model reads;
 * the output is summarized either way.
 */
import { defineBattery, oneOf, STAKES_BANDS } from '@goodvibes-jev/judgment';

export const OUTPUT_KIND_OPTIONS = {
  xml: 'Markup: XML or HTML documents, SVG, or other angle-bracket tag markup.',
  'binary-like': 'Binary or non-text data shown as text: raw bytes, control characters, garbled encodings, a dumped image, archive or executable.',
  text: 'Readable text: logs, prose, source code, command output, CSV or other plain text.',
} as const;

export type OutputKindOption = keyof typeof OUTPUT_KIND_OPTIONS;

const sample = (text: string) => ({ sample: text, characters: text.length });

export const outputKind = defineBattery({
  name: 'engine.runtime.output-kind',
  version: 1,
  description: 'What kind of content an oversized tool output is: markup, binary-like data or readable text.',
  accuracyFloor: 0.9,
  items: {
    kind: oneOf(
      '`sample` is the beginning and end of a tool output of `characters` characters that is too large to show in full. What kind of content is it?',
      OUTPUT_KIND_OPTIONS,
      STAKES_BANDS.low.confidence,
    ),
  },
  fixtures: [
    { name: 'xml document', state: sample('<?xml version="1.0"?>\n<project><dependencies><dependency><groupId>org.junit</groupId></dependency></dependencies></project>'), expect: { kind: 'xml' } },
    { name: 'html page', state: sample('<!DOCTYPE html>\n<html lang="en"><head><title>Docs</title></head><body><h1>Install</h1><p>Run the installer.</p></body></html>'), expect: { kind: 'xml' } },
    { name: 'svg image', state: sample('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 2L2 7l10 5 10-5-10-5z"/></svg>'), expect: { kind: 'xml' } },
    { name: 'png bytes dumped', state: sample('\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR\u0000\u0000\u0002\u0000\u0000\u0000\u0001\u0000\b\u0006\u0000\u0000\u0000ôxÔú\u0000\u0000\u0000\u0004gAMA'), expect: { kind: 'binary-like' } },
    { name: 'elf executable', state: sample('\u007fELF\u0002\u0001\u0001\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0003\u0000>\u0000\u0001\u0000\u0000\u0000@\u0010\u0000\u0000\u0000\u0000\u0000\u0000@\u0000'), expect: { kind: 'binary-like' } },
    { name: 'zip archive', state: sample('PK\u0003\u0004\u0014\u0000\u0000\u0000\b\u0000¡\u0083!WÃ´\u0012Øá\u0000\u0000\u0000\u0084\u0001\u0000\u0000\u000b\u0000\u001c\u0000content.xml'), expect: { kind: 'binary-like' } },
    { name: 'build log', state: sample('[1/412] Compiling src/main.rs\n[2/412] Compiling src/lib.rs\nwarning: unused variable `x`\n --> src/lib.rs:14:9\n...\nFinished release [optimized] target(s) in 38.2s'), expect: { kind: 'text' } },
    { name: 'source code with a comparison', state: sample('function clamp(n: number, lo: number, hi: number) {\n  return n < lo ? lo : n > hi ? hi : n;\n}\n...\nexport default clamp;'), expect: { kind: 'text' } },
    { name: 'csv rows', state: sample('id,name,created_at\n1,alpha,2026-01-02\n2,beta,2026-01-03\n...\n9921,omega,2026-09-01'), expect: { kind: 'text' } },
    { name: 'terminal output with color codes', state: sample('\u001b[32mPASS\u001b[0m test/a.test.ts\n\u001b[32mPASS\u001b[0m test/b.test.ts\n...\nTests: 412 passed, 412 total'), expect: { kind: 'text' } },
    { name: 'git diff', state: sample('diff --git a/src/app.ts b/src/app.ts\n@@ -1,4 +1,5 @@\n-import x from "x";\n+import y from "y";\n...\n+export { y };'), expect: { kind: 'text' } },
    { name: 'markdown prose', state: sample('# Release notes\n\nThis release adds offline mode and fixes the login redirect.\n...\n## Upgrading\nRun the migration once.'), expect: { kind: 'text' } },
  ],
});
