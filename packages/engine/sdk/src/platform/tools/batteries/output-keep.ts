/**
 * `engine.tools.output-keep`: which parts of a tool output too long to show
 * in full are shown (tools/shared/overflow.ts keepForCall). Replaces keeping
 * the first 20 percent and the last 80 percent of the character budget on
 * the assumption that the informative part of long output is at its end.
 *
 * The re-ranking cookbook: code cuts the output into blocks at line breaks,
 * one yes/no per block against the call that produced the output, each in
 * its own request, orders them by probability; code keeps the best blocks
 * that fit the budget and shows them in their original order, marking what
 * was left out.
 *
 * Band: low stakes. The full output is saved and referenced; the reading
 * only decides which parts are shown inline.
 */
import { defineRerank, STAKES_BANDS } from '@goodvibes-jev/judgment';

/** What the rerank sees of one block: where it sits in the output, and its text. */
export function outputBlockView(start: number, text: string, total: number): { position: string; text: string } {
  return { position: `characters ${start} to ${start + text.length} of ${total}`, text };
}

const block = (id: string, start: number, total: number, lines: readonly string[]) => ({ id, content: outputBlockView(start, lines.join('\n'), total) });
const passing = (from: number, count: number) => Array.from({ length: count }, (_, i) => `(pass) cart > line item ${from + i} keeps its price [0.${(i % 9) + 1}ms]`);

const BUN_TEST = 'bun test';
const TEST_PASSES_A = block('passes-1', 0, 9000, passing(1, 14));
const TEST_PASSES_B = block('passes-2', 3000, 9000, passing(15, 14));
const TEST_FAILURE = block('failure', 6000, 9000, [
  '(fail) cart > applies the member discount [2.10ms]',
  '',
  'error: expect(received).toBe(expected)',
  'Expected: 90',
  'Received: 100',
  '      at /repo/test/cart.test.ts:48:31',
  '',
  ' 212 pass',
  ' 1 fail',
  'Ran 213 tests across 14 files. [1.84s]',
]);
const TEST_PASSES_C = block('passes-3', 6000, 9000, passing(29, 14));

const NPM_INSTALL = 'npm install';
const NPM_WARNINGS = block('warnings', 0, 7000, [
  'npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory.',
  'npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported',
  'npm warn deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported',
]);
const NPM_PROGRESS = block('progress', 2000, 7000, [
  'npm http fetch GET 200 https://registry.npmjs.org/react 41ms (cache hit)',
  'npm http fetch GET 200 https://registry.npmjs.org/react-dom 38ms (cache hit)',
  'npm http fetch GET 200 https://registry.npmjs.org/scheduler 12ms (cache hit)',
]);
const NPM_ERROR = block('eresolve', 4000, 7000, [
  'npm error code ERESOLVE',
  'npm error ERESOLVE unable to resolve dependency tree',
  'npm error Found: react@19.0.0',
  'npm error Could not resolve dependency:',
  'npm error peer react@"^18.0.0" from react-beautiful-dnd@13.1.1',
]);

const CARGO_BUILD = 'cargo build --release';
const CARGO_COMPILING = block('compiling', 0, 5000, [
  '   Compiling libc v0.2.155',
  '   Compiling proc-macro2 v1.0.86',
  '   Compiling serde v1.0.204',
  '   Compiling tokio v1.39.2',
]);
const CARGO_ERROR = block('e0308', 2500, 5000, [
  'error[E0308]: mismatched types',
  '  --> src/config.rs:42:24',
  '   |',
  '42 |     let port: u16 = env::var("PORT")?;',
  '   |               ---   ^^^^^^^^^^^^^^^^^ expected `u16`, found `String`',
  'error: could not compile `server` (bin "server") due to 1 previous error',
]);

const DOCKER_BUILD = 'docker build -t web .';
const DOCKER_STEPS = block('steps', 0, 6000, [
  '#5 [2/6] WORKDIR /app',
  '#5 DONE 0.0s',
  '#6 [3/6] COPY package.json package-lock.json ./',
  '#6 DONE 0.1s',
]);
const DOCKER_FAILURE = block('failed', 3000, 6000, [
  '#7 [4/6] RUN npm ci',
  '#7 12.41 npm error code EUSAGE',
  '#7 12.41 npm error The `npm ci` command can only install with an existing package-lock.json',
  'ERROR: failed to solve: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1',
]);

export const outputKeep = defineRerank({
  name: 'engine.tools.output-keep',
  version: 1,
  description: 'Orders the blocks of a tool output too long to show in full by whether each holds what the caller most needs to see from the call.',
  accuracyFloor: 0.85,
  instructions: 'A tool call `query` produced more output than can be shown; the full output is saved, and only some of its blocks will be shown. `candidate` is one block of that output: its `position` in the output and its `text`. Should this block be among those shown, because it holds what the caller most needs to see from this call?',
  criteria: {
    true: 'The block holds part of the call\'s outcome: an error, a failure and its details, a final result or summary, or the specific data the call asked for.',
    false: 'The block holds routine output: progress, download or compile lines, passing checks, deprecation notices, banners, or repeated status lines that say nothing about the outcome.',
  },
  band: STAKES_BANDS.low.yesNo,
  fixtures: [
    { name: 'test failure and summary in a long passing run', query: BUN_TEST, candidates: [TEST_PASSES_A, TEST_PASSES_B, TEST_FAILURE], expect: { top: 'failure' } },
    { name: 'dependency resolution error among install noise', query: NPM_INSTALL, candidates: [NPM_WARNINGS, NPM_ERROR, NPM_PROGRESS], expect: { top: 'eresolve' } },
    { name: 'compile error after compiling lines', query: CARGO_BUILD, candidates: [CARGO_COMPILING, CARGO_ERROR], expect: { top: 'e0308' } },
    { name: 'failed build step', query: DOCKER_BUILD, candidates: [DOCKER_FAILURE, DOCKER_STEPS], expect: { top: 'failed' } },
    { name: 'only passing lines', query: BUN_TEST, candidates: [TEST_PASSES_A, TEST_PASSES_B, TEST_PASSES_C], expect: { top: 'none' } },
  ],
});
