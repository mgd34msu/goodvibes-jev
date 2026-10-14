#!/usr/bin/env bun
// judgment-lint.ts: registration and fixture checks over engine/product Jev use.
//
//   bun run judgment:lint
//
// Loads every judgment registry in packages/engine and fails (exit 1) when a
// registered decision has no fixture expecting one of its answers, when two
// registries register different decisions under one name, or when source
// visibly asks Jev outside a registered decision: a `define*` decision no
// registry registers, a request built inline and sent to a port's `ask`, or
// an `askAs` outside a decision definer or a registered custom decision with
// the same header and fixtures. Private factories must have known names at
// every call site. See judgment-lint-source.ts.

import { resolve } from 'node:path';
import { coverageFindings, sourceFindings, type LintFinding } from './judgment-lint-rules.ts';
import { loadEngineRegistries } from './judgment-registries.ts';
import { judgmentSourceFiles, WORKSPACE_ROOT } from './judgment-sources.ts';

const { files, decisions, conflicts } = await loadEngineRegistries();
const registered = new Set(decisions.map((decision) => decision.name));
const findings: LintFinding[] = conflicts.map((name) => ({ rule: 'registered-use', where: name, message: 'two registries register different decisions under this name' }));

const coverage = await coverageFindings(decisions);
findings.push(...coverage.findings);

const sources = judgmentSourceFiles();
for (const file of sources) {
  const text = await Bun.file(resolve(WORKSPACE_ROOT, file)).text();
  if (!/\bdefine[A-Z]|\bdecisionHeader\b|\baskAs\b|\bask\b/.test(text)) continue;
  findings.push(...sourceFindings(file, text, registered));
}

console.log(`[judgment-lint] ${decisions.length} registered decisions from ${files.length} registries; ${sources.length} source files scanned`);
if (coverage.open.length > 0) {
  console.log(`[judgment-lint] ${coverage.open.length} question(s) draw their answers from each fixture's own data and have no fixed answer set to cover:`);
  for (const question of coverage.open) console.log(`  ${question}`);
}
if (findings.length > 0) {
  for (const finding of findings) console.error(`[judgment-lint] ${finding.rule}: ${finding.where}: ${finding.message}`);
  console.error(`[judgment-lint] FAIL: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log('[judgment-lint] PASS: registered fixture coverage and source-use checks across engine and products (not proof of semantic coverage or live calibration)');
