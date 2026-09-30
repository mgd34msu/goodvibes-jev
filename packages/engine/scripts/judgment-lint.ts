#!/usr/bin/env bun
// judgment-lint.ts: the semantic CI lints over the engine's Jev use.
//
//   bun run judgment:lint
//
// Loads every judgment registry in packages/engine and fails (exit 1) when a
// registered decision has no fixture expecting one of its answers, when two
// registries register different decisions under one name, or when engine
// source asks Jev outside a registered decision: a `define*` decision no
// registry registers, a request built inline and sent to a port's `ask`, or
// an `askAs` outside a decision definer or a registered custom decision with
// the same header and fixtures. Private factories must have known names at
// every call site. See judgment-lint-source.ts.

import { relative, resolve } from 'node:path';
import { coverageFindings, sourceFindings, type LintFinding } from './judgment-lint-rules.ts';
import { ENGINE_ROOT, loadEngineRegistries } from './judgment-registries.ts';

const SOURCE = '*/src/**/*.ts';
const SKIPPED = /(^|\/)(node_modules|dist)\/|\.d\.ts$/;

const { files, decisions, conflicts } = await loadEngineRegistries();
const registered = new Set(decisions.map((decision) => decision.name));
const findings: LintFinding[] = conflicts.map((name) => ({ rule: 'registered-use', where: name, message: 'two registries register different decisions under this name' }));

const coverage = await coverageFindings(decisions);
findings.push(...coverage.findings);

const sources = [...new Bun.Glob(SOURCE).scanSync({ cwd: ENGINE_ROOT })].filter((file) => !SKIPPED.test(file)).sort();
for (const file of sources) {
  const text = await Bun.file(resolve(ENGINE_ROOT, file)).text();
  if (!/\bdefine[A-Z]|\bdecisionHeader\(|\.ask\(|\baskAs\(/.test(text)) continue;
  findings.push(...sourceFindings(relative(resolve(ENGINE_ROOT, '../..'), resolve(ENGINE_ROOT, file)), text, registered));
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
console.log('[judgment-lint] PASS: every answer of every registered decision has a fixture, and every Jev call goes through a registered decision');
