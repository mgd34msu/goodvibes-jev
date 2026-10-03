/**
 * Rewind anchors across a resume.
 *
 * The Agent records a `{turnId → conversation message count}` anchor at every
 * completed turn and mirrors it to a sidecar beside the session's JSONL. What
 * this proves is the pair the product depends on: a turn recorded in one run
 * is still a rewind target after a resume, and the sweep that reclaims dead
 * sidecars never touches the ones a live session still needs.
 *
 * Driven through the real SDK seams (persist / restore / reap over a real
 * SessionSurface on a temp root), because a sidecar that is written and never
 * read back is not a capability.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  clearTurnAnchors,
  getTurnAnchors,
  persistTurnAnchors,
  reapOrphanedAnchorSidecars,
  recordTurnAnchor,
  resolveTurnAnchor,
  restoreTurnAnchors,
  summarizeTurnLabel,
} from '@goodvibes-jev/engine/sdk/platform/rewind';
import { createSessionSurface } from '@/runtime/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function agentSurface(root: string) {
  return createSessionSurface({
    workingDirectory: root,
    homeDirectory: root,
    surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
  });
}

/** Stand in for the session JSONL the sidecar belongs to. */
function writeSessionFile(surface: { sessionsDir: string }, sessionId: string): void {
  mkdirSync(surface.sessionsDir, { recursive: true });
  writeFileSync(join(surface.sessionsDir, `${sessionId}.jsonl`), '{}\n');
}

describe('rewind anchors survive a resume', () => {
  test('a turn recorded in one run is still a rewind target after the registry is cleared', () => {
    const surface = agentSurface(makeProjectTempDir('gv-anchor-resume'));
    const sessionId = 'sess-resume-1';
    writeSessionFile(surface, sessionId);

    recordTurnAnchor(sessionId, {
      turnId: 'turn-7',
      label: summarizeTurnLabel('  rewrite   the parser  '),
      messageCount: 12,
      at: 1_000,
    });
    persistTurnAnchors(sessionId, surface);

    // A resume starts from an empty in-memory registry, the anchor is only
    // reachable if the sidecar was written AND is read back.
    clearTurnAnchors(sessionId);
    expect(resolveTurnAnchor(sessionId, 'turn-7')).toBeNull();

    expect(restoreTurnAnchors(sessionId, surface)).toBe(1);
    const restored = resolveTurnAnchor(sessionId, 'turn-7');
    expect(restored?.messageCount).toBe(12);
    // The label is the one-line summary the picker shows, not the raw prompt.
    expect(restored?.label).toBe('rewrite the parser');
    clearTurnAnchors(sessionId);
  });

  test('restoring twice does not duplicate an anchor', () => {
    const surface = agentSurface(makeProjectTempDir('gv-anchor-idempotent'));
    const sessionId = 'sess-resume-2';
    writeSessionFile(surface, sessionId);

    recordTurnAnchor(sessionId, { turnId: 'turn-1', label: 'one', messageCount: 2, at: 1 });
    persistTurnAnchors(sessionId, surface);
    clearTurnAnchors(sessionId);

    restoreTurnAnchors(sessionId, surface);
    restoreTurnAnchors(sessionId, surface);
    expect(getTurnAnchors(sessionId)).toHaveLength(1);
    clearTurnAnchors(sessionId);
  });

  test('a session that never persisted anything restores nothing, and says so with a count', () => {
    const surface = agentSurface(makeProjectTempDir('gv-anchor-absent'));
    expect(restoreTurnAnchors('sess-never-written', surface)).toBe(0);
  });

  test('a torn sidecar restores nothing rather than an invented boundary', () => {
    const surface = agentSurface(makeProjectTempDir('gv-anchor-torn'));
    const sessionId = 'sess-torn';
    writeSessionFile(surface, sessionId);
    writeFileSync(join(surface.sessionsDir, `${sessionId}.anchors.json`), '{"version":1,"anchors":[{"turn');

    expect(restoreTurnAnchors(sessionId, surface)).toBe(0);
    expect(resolveTurnAnchor(sessionId, 'anything')).toBeNull();
  });
});

describe('the anchor sidecar sweep', () => {
  test('reclaims a sidecar whose session is gone and keeps one whose session is not', () => {
    const surface = agentSurface(makeProjectTempDir('gv-anchor-reap'));
    const live = 'sess-live';
    const orphan = 'sess-deleted';
    writeSessionFile(surface, live);

    for (const sessionId of [live, orphan]) {
      recordTurnAnchor(sessionId, { turnId: 't', label: 'l', messageCount: 1, at: 1 });
      persistTurnAnchors(sessionId, surface);
      clearTurnAnchors(sessionId);
    }
    const livePath = join(surface.sessionsDir, `${live}.anchors.json`);
    const orphanPath = join(surface.sessionsDir, `${orphan}.anchors.json`);
    expect(existsSync(livePath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(true);

    // The clock is nudged past the settle window so the just-written files are
    // eligible; the real sweep waits an hour, so a sidecar another instance is
    // mid-rewrite is never a target.
    const result = reapOrphanedAnchorSidecars(surface, { settleMs: 0, now: () => Date.now() + 1_000 });
    expect(result.reaped).toBe(1);
    expect(existsSync(livePath)).toBe(true);
    expect(existsSync(orphanPath)).toBe(false);
    // What survived still restores.
    expect(JSON.parse(readFileSync(livePath, 'utf8')).anchors).toHaveLength(1);
  });

  test('the session in use is never reaped, even with its own session file missing', () => {
    const surface = agentSurface(makeProjectTempDir('gv-anchor-reap-current'));
    const current = 'sess-current';
    recordTurnAnchor(current, { turnId: 't', label: 'l', messageCount: 1, at: 1 });
    persistTurnAnchors(current, surface);
    clearTurnAnchors(current);

    const result = reapOrphanedAnchorSidecars(surface, { currentSessionId: current, settleMs: 0, now: () => Date.now() + 1_000 });
    expect(result.reaped).toBe(0);
    expect(existsSync(join(surface.sessionsDir, `${current}.anchors.json`))).toBe(true);
  });

  test('a sessions directory that was never created reclaims nothing rather than throwing', () => {
    const surface = agentSurface(makeProjectTempDir('gv-anchor-reap-empty'));
    expect(reapOrphanedAnchorSidecars(surface, { settleMs: 0, now: () => Date.now() + 1_000 })).toEqual({ scanned: 0, reaped: 0 });
  });
});
