import { describe, expect, test } from 'bun:test';
import {
  KNOWN_SESSION_KINDS,
  sessionUpdateIntent,
  unionSessionFromRecord,
  unionSessionsFromListResponse,
  unionSessionsTotal,
  isKnownKind,
  kindLabel,
  projectLabel,
  statusLabel,
  isClosedStatus,
  isReapedStatus,
  canSteer,
  retentionLabel,
  attributionLabel,
  sortUnionSessions,
} from './sessions-union';

// A fixture union covering every declared kind, an UNKNOWN future kind, a closed
// history record, and a record carrying the retention truncation marker.
const FIXTURE_UNION = {
  totals: { sessions: 137 },
  sessions: [
    { id: 's-tui', kind: 'tui', project: 'goodvibes-tui', title: 'TUI coding', status: 'active', updatedAt: 50, messageCount: 12 },
    { id: 's-agent', kind: 'agent', project: 'goodvibes-tui', title: 'Agent run', status: 'active', updatedAt: 40, messageCount: 3, activeAgentId: 'agent-1' },
    { id: 's-webui', kind: 'webui', project: 'goodvibes-webui', title: 'WebUI', status: 'active', updatedAt: 30, messageCount: 5 },
    { id: 's-auto', kind: 'automation', project: 'goodvibes-webui', title: 'Nightly', status: 'active', updatedAt: 20, messageCount: 8 },
    { id: 's-chat', kind: 'companion-chat', project: '', title: 'Phone chat', status: 'active', updatedAt: 60, messageCount: 2 },
    { id: 's-closed', kind: 'tui', project: 'goodvibes-tui', title: 'Old session', status: 'closed', updatedAt: 10, messageCount: 300, retainedMessageCount: 50 },
    { id: 's-future', kind: 'quantum-surface', project: 'lab', title: 'Future kind', status: 'active', updatedAt: 70, messageCount: 1 },
  ],
};

describe('SESSION_UPDATE intent map', () => {
  test('maps concrete wire events to coarse intents (mirrors SDK map)', () => {
    expect(sessionUpdateIntent('session-created')).toBe('created');
    expect(sessionUpdateIntent('session-message-appended')).toBe('updated');
    expect(sessionUpdateIntent('session-reopened')).toBe('updated');
    expect(sessionUpdateIntent('session-input-delivered')).toBe('steered');
    expect(sessionUpdateIntent('session-message-forwarded')).toBe('steered');
    expect(sessionUpdateIntent('session-closed')).toBe('closed');
  });

  test('an unknown future wire event maps to null (caller invalidates defensively)', () => {
    expect(sessionUpdateIntent('session-teleported')).toBeNull();
  });

});

describe('tolerant union extraction', () => {
  test('unwraps {totals, sessions} and normalizes every entry (all kinds render)', () => {
    const records = unionSessionsFromListResponse(FIXTURE_UNION);
    expect(records).toHaveLength(7);
    const kinds = records.map((r) => r.kind);
    for (const known of KNOWN_SESSION_KINDS) {
      // every known kind present in the fixture survives extraction
      if (FIXTURE_UNION.sessions.some((s) => s.kind === known)) {
        expect(kinds).toContain(known);
      }
    }
    // the UNKNOWN future kind is not dropped
    expect(kinds).toContain('quantum-surface');
  });

  test('unknown kind renders verbatim as a neutral-badge label, no throw', () => {
    const record = unionSessionFromRecord({ id: 'x', kind: 'quantum-surface' });
    expect(isKnownKind(record.kind)).toBe(false);
    expect(kindLabel(record.kind)).toBe('quantum-surface');
  });

  test('total is read from the totals envelope for the capped-list honesty note', () => {
    expect(unionSessionsTotal(FIXTURE_UNION)).toBe(137);
    expect(unionSessionsTotal({ sessions: [] })).toBeNull();
  });

  test('does not impose companion literal types; reads kind/status as open strings', () => {
    const record = unionSessionFromRecord({ id: 'a', kind: 'automation', status: 'closed' });
    expect(record.kind).toBe('automation');
    expect(record.status).toBe('closed');
  });

  test('garbage input never throws', () => {
    expect(() => unionSessionsFromListResponse(null)).not.toThrow();
    expect(() => unionSessionsFromListResponse('nope')).not.toThrow();
    expect(unionSessionFromRecord(42).id).toBe('');
  });
});

describe('retention honesty marker', () => {
  test('renders "N of M retained" only when retainedMessageCount < messageCount', () => {
    const record = unionSessionFromRecord({ id: 'r', messageCount: 300, retainedMessageCount: 50 });
    const label = retentionLabel(record);
    expect(label).toContain('50');
    expect(label).toContain('300');
  });

  test('absent retainedMessageCount → NO marker (fully retained, never infer loss)', () => {
    const record = unionSessionFromRecord({ id: 'r', messageCount: 12 });
    expect(record.retainedMessageCount).toBeNull();
    expect(retentionLabel(record)).toBeNull();
  });

  test('retainedMessageCount equal to messageCount → no marker', () => {
    const record = unionSessionFromRecord({ id: 'r', messageCount: 12, retainedMessageCount: 12 });
    expect(retentionLabel(record)).toBeNull();
  });
});

describe('badge labels', () => {
  test('projectLabel: absent project → a non-blank label', () => {
    expect(projectLabel('').length).toBeGreaterThan(0);
    expect(projectLabel('goodvibes-tui')).toBe('goodvibes-tui');
  });

  test('statusLabel: empty status falls back to "active"', () => {
    expect(statusLabel('')).toBe('active');
    expect(statusLabel('closed')).toBe('closed');
  });

  test('isClosedStatus is case-insensitive', () => {
    expect(isClosedStatus('closed')).toBe(true);
    expect(isClosedStatus('CLOSED')).toBe(true);
    expect(isClosedStatus('active')).toBe(false);
  });
});

// B1: closed cross-surface sessions carry an optional, honest reason for WHY
// they closed under metadata.closeReason (SDK's SharedSessionCloseReason).
// An 'idle-reaped' close auto-reopens on the next heartbeat and must render
// distinctly from a deliberate close, never folded into "closed · history".
describe('reaped-as-reaped (closeReason)', () => {
  test('extracts metadata.closeReason from the raw wire record', () => {
    const record = unionSessionFromRecord({ id: 'r', status: 'closed', metadata: { closeReason: 'idle-reaped' } });
    expect(record.closeReason).toBe('idle-reaped');
  });

  test('closeReason defaults to empty string when metadata is absent (pre-feature build)', () => {
    const record = unionSessionFromRecord({ id: 'r', status: 'closed' });
    expect(record.closeReason).toBe('');
  });

  test('closeReason defaults to empty string when metadata is present but has no closeReason', () => {
    const record = unionSessionFromRecord({ id: 'r', status: 'closed', metadata: { other: 'value' } });
    expect(record.closeReason).toBe('');
  });

  test('isReapedStatus: true only when closed AND closeReason is idle-reaped', () => {
    expect(isReapedStatus(unionSessionFromRecord({ id: 'r', status: 'closed', metadata: { closeReason: 'idle-reaped' } }))).toBe(true);
  });

  test('isReapedStatus: false for a deliberate user/surface close', () => {
    expect(isReapedStatus(unionSessionFromRecord({ id: 'r', status: 'closed', metadata: { closeReason: 'user' } }))).toBe(false);
    expect(isReapedStatus(unionSessionFromRecord({ id: 'r', status: 'closed', metadata: { closeReason: 'surface' } }))).toBe(false);
  });

  test('isReapedStatus: false for a closed record with no closeReason at all (tolerant default)', () => {
    expect(isReapedStatus(unionSessionFromRecord({ id: 'r', status: 'closed' }))).toBe(false);
  });

  test('isReapedStatus: false for an active session even if closeReason were somehow present', () => {
    expect(isReapedStatus(unionSessionFromRecord({ id: 'r', status: 'active', metadata: { closeReason: 'idle-reaped' } }))).toBe(false);
  });

  test('an unrecognized closeReason value is preserved verbatim, not dropped', () => {
    const record = unionSessionFromRecord({ id: 'r', status: 'closed', metadata: { closeReason: 'future-reason' } });
    expect(record.closeReason).toBe('future-reason');
    expect(isReapedStatus(record)).toBe(false);
  });
});

// Channel-origin attribution (principals.*, SDK 1.6.1's initiative family),
// metadata.attributedPrincipalId/Name/Known, stamped by channel-profiles/intake.ts.
describe('attribution (attributedPrincipal*)', () => {
  test('a session with no attribution metadata at all gets a null known flag and no label', () => {
    const record = unionSessionFromRecord({ id: 'r', status: 'active' });
    expect(record.attributedPrincipalKnown).toBeNull();
    expect(record.attributedPrincipalName).toBe('');
    expect(attributionLabel(record)).toBeNull();
  });

  test('a known attribution extracts the resolved principal name', () => {
    const record = unionSessionFromRecord({
      id: 'r', status: 'active',
      metadata: { attributedPrincipalId: 'p-1', attributedPrincipalName: 'Mike', attributedPrincipalKnown: true },
    });
    expect(record.attributedPrincipalKnown).toBe(true);
    expect(record.attributedPrincipalName).toBe('Mike');
    expect(attributionLabel(record)).toBe('Mike');
  });

  test('an unmapped sender identity (known:false) still gets a non-blank label, never hidden', () => {
    const record = unionSessionFromRecord({
      id: 'r', status: 'active',
      metadata: { attributedPrincipalKnown: false },
    });
    expect(record.attributedPrincipalKnown).toBe(false);
    expect(attributionLabel(record)?.length ?? 0).toBeGreaterThan(0);
  });

  test('known:true with a somehow-empty name still gets a non-blank label', () => {
    const record = unionSessionFromRecord({
      id: 'r', status: 'active',
      metadata: { attributedPrincipalKnown: true, attributedPrincipalName: '' },
    });
    expect(attributionLabel(record)?.length ?? 0).toBeGreaterThan(0);
  });
});

describe('steer eligibility', () => {
  test('steer only when open AND an agent is bound', () => {
    expect(canSteer(unionSessionFromRecord({ id: 'a', status: 'active', activeAgentId: 'agent-1' }))).toBe(true);
  });

  test('no active agent → not steerable (offer follow-up instead)', () => {
    expect(canSteer(unionSessionFromRecord({ id: 'a', status: 'active' }))).toBe(false);
  });

  test('closed session → not steerable even with an agent id', () => {
    expect(canSteer(unionSessionFromRecord({ id: 'a', status: 'closed', activeAgentId: 'agent-1' }))).toBe(false);
  });
});

describe('sortUnionSessions', () => {
  test('sorts newest-first by updatedAt', () => {
    const records = unionSessionsFromListResponse(FIXTURE_UNION);
    const sorted = sortUnionSessions(records);
    expect(sorted[0].id).toBe('s-future'); // updatedAt 70, highest
    expect(sorted[sorted.length - 1].id).toBe('s-closed'); // updatedAt 10, lowest
  });
});
