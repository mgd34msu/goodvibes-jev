/**
 * output-policy.test.ts
 *
 * A `summary` output policy replaces oversized output with a size and kind
 * summary using local string/JSON format and byte/line facts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { OverflowHandler } from '../sdk/src/platform/tools/shared/overflow.js';
import { applyOutputPolicy, type ToolOutputPolicy } from '../sdk/src/platform/runtime/tools/output-policy.js';

function makeOverflowHandler(): OverflowHandler {
  return new OverflowHandler({ baseDir: mkdtempSync(join(tmpdir(), 'goodvibes-output-policy-')) });
}

const policy: ToolOutputPolicy = {
  toolClass: 'analyze',
  maxBytes: 128,
  maxTokens: 32,
  truncationMode: 'summary',
  spillMode: 'inline',
  auditMetadata: true,
};

/** A port answering the kind question with `kind` at `confidence`, recording each sample. */
function kindPort(kind: string, confidence: number, samples: string[]) {
  return fakePort((name: string, question: Question, state: EntryType) => {
    if (name !== 'kind') throw new Error(`output kind port: unexpected question ${name}`);
    samples.push((state as unknown as { sample: string }).sample);
    return choiceAnswer(question, kind, confidence);
  }).port;
}

let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); });

describe('output policy', () => {
  test('summary truncation names JSON output without a reading', async () => {
    const original = JSON.stringify({ rows: Array.from({ length: 200 }, (_, index) => ({ index })) });
    const { result, audit } = await applyOutputPolicy(
      { callId: 'call-1', success: true, output: original },
      policy,
      makeOverflowHandler(),
      'read {}',
    );

    expect(audit.actionTaken).toBe('truncated');
    expect(audit.originalSize).toBeGreaterThan(policy.maxBytes);
    expect(audit.resultSize).toBeLessThanOrEqual(policy.maxBytes);
    expect(result.output).toContain('output summarized');
    expect(result.output).toContain('json');
    expect(result.output).not.toContain('"rows"');
    expect(result._policyAudit).toEqual(audit);
  });

  test('ordinary output remains bounded and needs no semantic label or installed port', async () => {
    const samples: string[] = [];
    installJudgmentPort(kindPort('xml', 0.95, samples));
    const original = `<html><body>${'<p>row</p>'.repeat(1000)}</body></html>`;
    const { result, audit } = await applyOutputPolicy({ callId: 'call-2', success: true, output: original }, policy, makeOverflowHandler(), 'read {}');
    expect(result.output).toContain('text'); expect(audit.resultSize).toBeLessThanOrEqual(policy.maxBytes);
    expect(samples).toHaveLength(0);
    installJudgmentPort(undefined);
    const next = await applyOutputPolicy({ callId: 'call-3', success: true, output: 'line\n'.repeat(500) }, policy, makeOverflowHandler(), 'read {}');
    expect(next.result.output).toContain('text'); expect(next.audit.resultSize).toBeLessThanOrEqual(policy.maxBytes);
  });
});
