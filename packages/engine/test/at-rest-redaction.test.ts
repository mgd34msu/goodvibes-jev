/**
 * at-rest-redaction.test.ts
 *
 * The redaction + retention policy for the raw-content on-disk writers: the
 * transcript journal (agents/session.ts) and the local execution ledger
 * (runtime/telemetry/exporters/local-ledger.ts). Issuer-reserved credential
 * formats are masked by code; a span in a candidate shape (`sk-`, `key-`, the
 * word after `Bearer`) is kept in the clear only when
 * `engine.runtime.at-rest-credential` reads it as not a credential, and is
 * masked while unread, on an uncertain or yes reading, and when no reading can
 * be made. Also pins retention caps, config keys with honest defaults, and the
 * replay path reading redacted records.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { EntryType, Question } from '@goodvibes-jev/judgment';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import {
  redactAtRestLine,
  readAtRestCredentialSpans,
  clearAtRestCredentialReadings,
  resolveAtRestPolicy,
  enforceFileRetention,
  DEFAULT_AT_REST_POLICY,
  AT_REST_CONFIG_KEYS,
} from '../sdk/src/platform/runtime/at-rest-persistence.ts';
import { AgentSession } from '../sdk/src/platform/agents/session.ts';
import { LocalLedgerExporter } from '../sdk/src/platform/runtime/telemetry/exporters/local-ledger.ts';

const tmpDirs: string[] = [];
function mkTemp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gv-atrest-'));
  tmpDirs.push(dir);
  return dir;
}

const API_KEY = 'sk-ABCDEFGHIJKLMNOPQRSTUVWX';
const DOC_NAME = 'key-rotation-policy-for-tenants';
const GITHUB_TOKEN = 'ghp_0123456789012345678901234567890123456789';

/** A port reading each span through `probability` (of being a credential), recording every request. */
function spanPort(probability: (span: string) => number) {
  return fakePort((name: string, _question: Question, state: EntryType) => {
    if (name !== 'credential') throw new Error(`at-rest port: unexpected question ${name}`);
    return noulAnswer(probability((state as { span: string }).span));
  });
}

/** The API key reads as a credential, the document name as not one, anything else as uncertain. */
const KEY_YES_DOC_NO = (span: string): number => (span === API_KEY ? 0.97 : span === DOC_NAME ? 0.02 : 0.5);

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previousPort = installJudgmentPort(undefined);
  clearAtRestCredentialReadings();
});
afterEach(() => {
  installJudgmentPort(previousPort);
  clearAtRestCredentialReadings();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('redactAtRestLine: masks credentials, preserves content, stays valid JSON', () => {
  test('issuer formats and unread candidate spans are masked; the line stays parseable', () => {
    const line = JSON.stringify({
      role: 'user',
      body: `run with token ${API_KEY} and Authorization: Bearer abcdef.ghijkl, see ${DOC_NAME}`,
      ghToken: GITHUB_TOKEN,
    });
    const out = redactAtRestLine(line);
    expect(out).not.toContain(API_KEY);
    expect(out).not.toContain('abcdef.ghijkl');
    expect(out).not.toContain(DOC_NAME);
    expect(out).toContain('[REDACTED_API_KEY]');
    expect(out).toContain('Bearer [REDACTED_TOKEN]');
    expect(out).toContain('[REDACTED_GITHUB_TOKEN]');
    const parsed = JSON.parse(out) as { role: string; body: string };
    expect(parsed.role).toBe('user');
    expect(parsed.body).toContain('run with token');
  });

  test('a span read as not a credential stays in the clear; a yes or an uncertain reading masks', async () => {
    const { port, requests } = spanPort(KEY_YES_DOC_NO);
    installJudgmentPort(port);
    const line = JSON.stringify({ body: `see ${DOC_NAME}; key ${API_KEY}; the bearer of bad news` });
    await readAtRestCredentialSpans([line, line], 'test.at-rest');
    // One request per distinct span, even across lines: the doc name, the key, and "of".
    expect(requests).toHaveLength(3);
    const out = redactAtRestLine(line);
    expect(out).toContain(DOC_NAME);
    expect(out).not.toContain(API_KEY);
    expect(out).toContain('the bearer [REDACTED_TOKEN] bad news');

    await readAtRestCredentialSpans([line], 'test.at-rest');
    expect(requests).toHaveLength(3);
  });

  test('a no that falls short of the critical band still masks', async () => {
    installJudgmentPort(spanPort(() => 0.2).port);
    const line = JSON.stringify({ body: `see ${DOC_NAME}` });
    await readAtRestCredentialSpans([line], 'test.at-rest');
    expect(redactAtRestLine(line)).not.toContain(DOC_NAME);
  });

  test('issuer formats are never asked about', async () => {
    const { port, requests } = spanPort(() => 0.01);
    installJudgmentPort(port);
    const line = JSON.stringify({ body: GITHUB_TOKEN });
    await readAtRestCredentialSpans([line], 'test.at-rest');
    expect(requests).toHaveLength(0);
    expect(redactAtRestLine(line)).toContain('[REDACTED_GITHUB_TOKEN]');
  });

  test('with no port installed the read rejects and the span stays masked', async () => {
    const line = JSON.stringify({ body: `see ${DOC_NAME}` });
    await expect(readAtRestCredentialSpans([line], 'test.at-rest')).rejects.toThrow();
    expect(redactAtRestLine(line)).not.toContain(DOC_NAME);
  });
});

describe('resolveAtRestPolicy: honest defaults + config overrides', () => {
  test('no getter -> redaction on, generous bounded retention', () => {
    expect(resolveAtRestPolicy()).toEqual(DEFAULT_AT_REST_POLICY);
    expect(DEFAULT_AT_REST_POLICY.redact).toBe(true);
    expect(DEFAULT_AT_REST_POLICY.retention.maxAgeMs).toBeGreaterThan(0);
  });

  test('config getter overrides redaction + retention', () => {
    const cfg: Record<string, unknown> = {
      [AT_REST_CONFIG_KEYS.redactEnabled]: false,
      [AT_REST_CONFIG_KEYS.maxAgeDays]: 2,
      [AT_REST_CONFIG_KEYS.maxTotalMb]: 5,
    };
    const policy = resolveAtRestPolicy((key) => cfg[key]);
    expect(policy.redact).toBe(false);
    expect(policy.retention.maxAgeMs).toBe(2 * 24 * 60 * 60 * 1000);
    expect(policy.retention.maxTotalBytes).toBe(5 * 1024 * 1024);
  });

  test('a throwing/invalid getter falls back to defaults, never propagates', () => {
    const policy = resolveAtRestPolicy(() => undefined);
    expect(policy).toEqual(DEFAULT_AT_REST_POLICY);
  });
});

describe('enforceFileRetention: age + size caps, oldest-first', () => {
  test('deletes files older than the age cap', () => {
    const dir = mkTemp();
    const oldFile = join(dir, 'old.jsonl');
    const freshFile = join(dir, 'fresh.jsonl');
    writeFileSync(oldFile, 'x\n');
    writeFileSync(freshFile, 'y\n');
    const old = Date.now() / 1000 - 100 * 24 * 60 * 60;
    utimesSync(oldFile, old, old);
    const outcome = enforceFileRetention([oldFile, freshFile], {
      redact: true,
      retention: { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxTotalBytes: 1024 * 1024 },
    });
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(freshFile)).toBe(true);
    expect(outcome.deletedFiles).toContain(oldFile);
  });

  test('enforces the total-size cap oldest-first', () => {
    const dir = mkTemp();
    const older = join(dir, 'a.jsonl');
    const newer = join(dir, 'b.jsonl');
    writeFileSync(older, 'a'.repeat(2000));
    writeFileSync(newer, 'b'.repeat(2000));
    const t = Date.now() / 1000;
    utimesSync(older, t - 100, t - 100);
    utimesSync(newer, t, t);
    enforceFileRetention([older, newer], {
      redact: true,
      retention: { maxAgeMs: Number.MAX_SAFE_INTEGER, maxTotalBytes: 2500 },
    });
    // Oldest removed first to get under the 2500-byte cap.
    expect(existsSync(older)).toBe(false);
    expect(existsSync(newer)).toBe(true);
  });
});

describe('AgentSession transcript journal: redaction at write', () => {
  test('a line waits for its span readings; the key is masked and the document name kept', async () => {
    installJudgmentPort(spanPort(KEY_YES_DOC_NO).port);
    const dir = mkTemp();
    const session = new AgentSession('agent-1', 'm', 'p', { sessionsDir: dir, stateDir: dir });
    session.appendMessage({ role: 'user', body: `key is ${API_KEY}, policy in ${DOC_NAME}` });
    session.appendMessage({ role: 'assistant', body: 'noted' });
    await session.flush();
    const lines = readFileSync(join(dir, 'agent-1.jsonl'), 'utf8').trim().split('\n');
    // Order kept: the meta line, the line that waited on its readings, then the plain line.
    expect(lines).toHaveLength(3);
    expect(lines[1]).not.toContain(API_KEY);
    expect(lines[1]).toContain('[REDACTED_API_KEY]');
    expect(lines[1]).toContain(DOC_NAME);
    expect(lines[2]).toContain('noted');
  });

  test('when no reading can be made the line is still written, with the span masked', async () => {
    const dir = mkTemp();
    const session = new AgentSession('agent-4', 'm', 'p', { sessionsDir: dir, stateDir: dir });
    session.appendMessage({ body: `policy in ${DOC_NAME}` });
    await session.flush();
    const contents = readFileSync(join(dir, 'agent-4.jsonl'), 'utf8');
    expect(contents).not.toContain(DOC_NAME);
    expect(contents).toContain('[REDACTED_API_KEY]');
  });

  test('redaction can be disabled by policy (opt-out)', () => {
    const dir = mkTemp();
    const session = new AgentSession('agent-2', 'm', 'p', { sessionsDir: dir, stateDir: dir }, {
      redact: false,
      retention: DEFAULT_AT_REST_POLICY.retention,
    });
    session.appendMessage({ body: GITHUB_TOKEN });
    const contents = readFileSync(join(dir, 'agent-2.jsonl'), 'utf8');
    expect(contents).toContain(GITHUB_TOKEN);
  });

  test('constructing a session prunes stale sibling journals (retention enforcement point)', () => {
    const dir = mkTemp();
    const stale = join(dir, 'stale.jsonl');
    writeFileSync(stale, 'old\n');
    const old = Date.now() / 1000 - 100 * 24 * 60 * 60;
    utimesSync(stale, old, old);
    // New session with a tight age cap prunes the stale journal on construction.
    new AgentSession('agent-3', 'm', 'p', { sessionsDir: dir, stateDir: dir }, {
      redact: true,
      retention: { maxAgeMs: 24 * 60 * 60 * 1000, maxTotalBytes: 1024 * 1024 },
    });
    expect(readdirSync(dir)).not.toContain('stale.jsonl');
  });
});

describe('LocalLedgerExporter execution ledger: redaction + replay', () => {
  test('recordEvent masks a credential span, and readRunEntries returns the redacted record after flush', async () => {
    installJudgmentPort(spanPort(KEY_YES_DOC_NO).port);
    const dir = mkTemp();
    const exporter = new LocalLedgerExporter({
      filePath: join(dir, 'spans.jsonl'),
      ledgerFilePath: join(dir, 'run.ledger.jsonl'),
    });
    exporter.recordEvent({
      runId: 'run-1',
      rev: 1,
      eventName: 'TOOL_RESULT',
      payload: { output: `token ${API_KEY} printed` },
      ts: Date.now(),
    });
    await exporter.flush();
    const raw = readFileSync(join(dir, 'run.ledger.jsonl'), 'utf8');
    expect(raw).not.toContain(API_KEY);
    expect(raw).toContain('[REDACTED_API_KEY]');
    const entries = exporter.readRunEntries('run-1');
    expect(entries).toHaveLength(1);
    expect(JSON.stringify(entries[0]!.payload)).toContain('[REDACTED_API_KEY]');
  });

  test('export waits for the readings of the spans in the batch', async () => {
    installJudgmentPort(spanPort(KEY_YES_DOC_NO).port);
    const dir = mkTemp();
    const filePath = join(dir, 'spans.jsonl');
    const exporter = new LocalLedgerExporter({ filePath });
    const span = { name: `read ${DOC_NAME}`, attributes: { key: API_KEY }, spanContext: { traceId: 't', spanId: 's' } };
    await exporter.export([span as never]);
    const raw = readFileSync(filePath, 'utf8');
    expect(raw).toContain(DOC_NAME);
    expect(raw).not.toContain(API_KEY);
  });
});
