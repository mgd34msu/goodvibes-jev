/**
 * approvals.ts, unit coverage for the decision-trail helpers.
 *
 * The SDK's approval record carries a required `audit` array
 * (SharedApprovalAuditRecord, packages/sdk/src/platform/control-plane/
 * approval-broker.ts) that this client's hand-typed ApprovalRecord previously
 * omitted entirely. `audit` is optional on this client's type because
 * invokeMethod reads the wire response as-is with no runtime schema
 * validation, a mixed-version or pre-audit daemon record may genuinely omit
 * it, and that must read as "no trail recorded", never as an error or a
 * fabricated one.
 */
import { describe, expect, test } from 'bun:test';
import type { ApprovalActionResult, ApprovalAuditRecord, ApprovalRecord } from './goodvibes';
import {
  attributionLabel,
  auditEntryLabel,
  auditTrail,
  isDurableRememberTier,
  readExecPromptAsk,
  readRememberOptions,
  recordedAnswerDelivered,
  recordedReasonStored,
  recordedRememberTier,
} from './approvals';

function baseRecord(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: 'appr-1',
    callId: 'call-1',
    status: 'approved',
    request: {
      callId: 'call-1',
      tool: 'exec',
      args: {},
      category: 'execute',
      analysis: { classification: 'exec', riskLevel: 'medium', summary: 'run a command', reasons: [] },
    },
    createdAt: 100,
    updatedAt: 100,
    metadata: {},
    ...overrides,
  };
}

describe('auditTrail', () => {
  test('returns the audit array verbatim when present', () => {
    const audit: ApprovalAuditRecord[] = [
      { id: 'a1', action: 'created', actor: 'agent-1', createdAt: 100 },
      { id: 'a2', action: 'approved', actor: 'operator', createdAt: 110 },
    ];
    expect(auditTrail(baseRecord({ audit }))).toEqual(audit);
  });

  test('returns an empty array (never undefined/null) when audit is absent', () => {
    const record = baseRecord();
    expect('audit' in record).toBe(false);
    expect(auditTrail(record)).toEqual([]);
  });

  test('returns an empty array when audit is present but empty', () => {
    expect(auditTrail(baseRecord({ audit: [] }))).toEqual([]);
  });
});

describe('auditEntryLabel', () => {
  test('renders action + actor', () => {
    const entry: ApprovalAuditRecord = { id: 'a1', action: 'created', actor: 'agent-1', createdAt: 100 };
    expect(auditEntryLabel(entry)).toContain('created');
    expect(auditEntryLabel(entry)).toContain('agent-1');
  });

  test('renders the actor surface in parentheses when present', () => {
    const entry: ApprovalAuditRecord = { id: 'a1', action: 'claimed', actor: 'operator', actorSurface: 'webui', createdAt: 100 };
    expect(auditEntryLabel(entry)).toContain('operator');
    expect(auditEntryLabel(entry)).toContain('webui');
  });

  test('appends the note after a colon when present', () => {
    const entry: ApprovalAuditRecord = {
      id: 'a1', action: 'denied', actor: 'operator', actorSurface: 'webui', createdAt: 100, note: 'too risky',
    };
    expect(auditEntryLabel(entry)).toContain('too risky');
  });

  test('omits surface and note segments cleanly when both are absent', () => {
    const entry: ApprovalAuditRecord = { id: 'a1', action: 'expired', actor: 'approval-broker', createdAt: 100 };
    const label = auditEntryLabel(entry);
    expect(label).toContain('approval-broker');
    expect(label).not.toContain('undefined');
    expect(label).not.toContain('()');
  });
});

describe('readRememberOptions', () => {
  test('reads well-formed options verbatim and drops malformed entries', () => {
    const record = baseRecord({
      request: {
        callId: 'call-1', tool: 'bash', args: {}, category: 'execute',
        analysis: { classification: 'exec', riskLevel: 'medium', summary: 's', reasons: [] },
        rememberOptions: [
          { tier: 'command-class', label: 'every bun command', detail: 'bun ...' },
          { tier: 'exact' } as never,
          'nonsense' as never,
        ],
      },
    });
    expect(readRememberOptions(record)).toEqual([
      { tier: 'command-class', label: 'every bun command', detail: 'bun ...' },
    ]);
  });

  test('a pre-tier record (no rememberOptions) offers none', () => {
    expect(readRememberOptions(baseRecord())).toEqual([]);
  });
});

describe('isDurableRememberTier', () => {
  test('the four persisting tiers are durable; session is not', () => {
    for (const tier of ['exact', 'command-class', 'path', 'tool']) expect(isDurableRememberTier(tier)).toBe(true);
    expect(isDurableRememberTier('session')).toBe(false);
    expect(isDurableRememberTier('')).toBe(false);
  });
});

describe('readExecPromptAsk', () => {
  test('detects the exec-prompt ask by attribution kind and reads command/prompt/recentOutput', () => {
    const record = baseRecord({
      status: 'pending',
      request: {
        callId: 'c', tool: 'exec:prompt',
        args: { command: 'ssh host', prompt: 'Continue?', recentOutput: 'fingerprint' },
        category: 'execute',
        analysis: { classification: 'exec-terminal-prompt', riskLevel: 'medium', summary: 's', reasons: [] },
        attribution: { kind: 'exec-prompt', command: 'ssh host', prompt: 'Continue?' },
      },
    });
    expect(readExecPromptAsk(record)).toEqual({ command: 'ssh host', prompt: 'Continue?', recentOutput: 'fingerprint' });
  });

  test('falls back to the attribution strings when args are partial', () => {
    const record = baseRecord({
      status: 'pending',
      request: {
        callId: 'c', tool: 'exec:prompt', args: {}, category: 'execute',
        analysis: { classification: 'exec-terminal-prompt', riskLevel: 'medium', summary: 's', reasons: [] },
        attribution: { kind: 'exec-prompt', command: 'ssh host', prompt: 'Continue?' },
      },
    });
    expect(readExecPromptAsk(record)).toEqual({ command: 'ssh host', prompt: 'Continue?', recentOutput: '' });
  });

  test('a non-exec-prompt ask reads as null', () => {
    expect(readExecPromptAsk(baseRecord())).toBeNull();
  });
});

function actionResult(overrides: Partial<ApprovalActionResult> = {}): ApprovalActionResult {
  return { approval: baseRecord(), ...overrides };
}

describe('recordedRememberTier', () => {
  test('trusts the authoritative `recorded` block first', () => {
    expect(recordedRememberTier(actionResult({
      recorded: { approved: true, rememberTier: 'command-class', reasonStored: false, modifiedArgsDelivered: false },
    }))).toBe('command-class');
    // A block that explicitly recorded no tier reports null, even if a stale
    // decision snapshot carried one, the block is authoritative.
    expect(recordedRememberTier(actionResult({
      approval: baseRecord({ decision: { approved: true, rememberTier: 'path' } }),
      recorded: { approved: true, rememberTier: null, reasonStored: false, modifiedArgsDelivered: false },
    }))).toBeNull();
  });

  test('falls back to the decision snapshot for a daemon predating the block', () => {
    expect(recordedRememberTier(actionResult({ approval: baseRecord({ decision: { approved: true, rememberTier: 'path' } }) }))).toBe('path');
    expect(recordedRememberTier(actionResult({ approval: baseRecord({ decision: { approved: true } }) }))).toBeNull();
    expect(recordedRememberTier(actionResult())).toBeNull();
    expect(recordedRememberTier(undefined)).toBeNull();
  });
});

describe('recordedReasonStored', () => {
  test('trusts the block, falls back to a reason on the decision', () => {
    expect(recordedReasonStored(actionResult({
      recorded: { approved: false, rememberTier: null, reasonStored: true, modifiedArgsDelivered: false },
    }))).toBe(true);
    expect(recordedReasonStored(actionResult({
      recorded: { approved: false, rememberTier: null, reasonStored: false, modifiedArgsDelivered: false },
    }))).toBe(false);
    // No block → the decision's reason field is the fallback.
    expect(recordedReasonStored(actionResult({ approval: baseRecord({ decision: { approved: false, reason: 'wrong branch' } }) }))).toBe(true);
    expect(recordedReasonStored(actionResult())).toBe(false);
    expect(recordedReasonStored(undefined)).toBe(false);
  });
});

describe('recordedAnswerDelivered', () => {
  test('trusts the block, falls back to a stamped answer on the decision', () => {
    expect(recordedAnswerDelivered(actionResult({
      recorded: { approved: true, rememberTier: null, reasonStored: false, modifiedArgsDelivered: true },
    }))).toBe(true);
    expect(recordedAnswerDelivered(actionResult({
      recorded: { approved: true, rememberTier: null, reasonStored: false, modifiedArgsDelivered: false },
    }))).toBe(false);
    expect(recordedAnswerDelivered(actionResult({ approval: baseRecord({ decision: { approved: true, modifiedArgs: { answer: 'yes' } } }) }))).toBe(true);
    expect(recordedAnswerDelivered(actionResult())).toBe(false);
    expect(recordedAnswerDelivered(undefined)).toBe(false);
  });
});

describe('attributionLabel: exec-prompt', () => {
  test('names the waiting command', () => {
    expect(attributionLabel({ kind: 'exec-prompt', command: 'ssh host', prompt: 'Continue?' })).toContain('ssh host');
  });
});
