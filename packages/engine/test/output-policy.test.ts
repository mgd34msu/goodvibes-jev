/**
 * output-policy.test.ts
 *
 * A `summary` output policy replaces oversized output with a size and kind
 * summary. Empty and JSON output are named in code; any other kind is read by
 * `engine.runtime.output-kind`, and a reading that does not settle is named
 * `unknown`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
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
    );

    expect(audit.actionTaken).toBe('truncated');
    expect(audit.originalSize).toBeGreaterThan(policy.maxBytes);
    expect(audit.resultSize).toBeLessThanOrEqual(policy.maxBytes);
    expect(result.output).toContain('output summarized');
    expect(result.output).toContain('json');
    expect(result.output).not.toContain('"rows"');
    expect(result._policyAudit).toEqual(audit);
  });

  test('other output is named by the kind reading, from its beginning and end', async () => {
    const samples: string[] = [];
    installJudgmentPort(kindPort('xml', 0.95, samples));
    const original = `<html><body>${'<p>row</p>'.repeat(1000)}</body></html>`;
    const { result } = await applyOutputPolicy({ callId: 'call-2', success: true, output: original }, policy, makeOverflowHandler());
    expect(result.output).toContain('xml');
    expect(samples).toHaveLength(1);
    expect(samples[0]!.startsWith('<html><body>')).toBe(true);
    expect(samples[0]!.endsWith('</body></html>')).toBe(true);
    expect(samples[0]!.length).toBeLessThan(original.length);
  });

  test('a reading that does not settle names the kind unknown', async () => {
    installJudgmentPort(kindPort('text', 0.3, []));
    const { result } = await applyOutputPolicy({ callId: 'call-3', success: true, output: 'line\n'.repeat(500) }, policy, makeOverflowHandler());
    expect(result.output).toContain('unknown');
  });

  test('a summary with no judgment port throws', async () => {
    await expect(
      applyOutputPolicy({ callId: 'call-4', success: true, output: 'line\n'.repeat(500) }, policy, makeOverflowHandler()),
    ).rejects.toBeInstanceOf(JudgmentPortMissingError);
  });
});
