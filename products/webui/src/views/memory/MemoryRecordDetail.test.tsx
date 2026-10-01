/**
 * MemoryRecordDetail, record detail (type/scope/review-state/provenance) plus a
 * no-secret-render pin: a provenance ref that looks like a filesystem path (or any
 * other sensitive-looking string) must render as plain, inert text, never as a link,
 * never fetched, never specially parsed. This view has no file-read capability and
 * must not invent one via a provenance ref.
 */
import { describe, expect, test } from 'bun:test';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type { MemoryRecord } from '../../lib/goodvibes';
import { MemoryRecordDetail } from './MemoryRecordDetail';

function record(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'r1',
    scope: 'project',
    cls: 'fact',
    summary: 'A recorded fact',
    tags: [],
    provenance: [],
    reviewState: 'fresh',
    confidence: 60,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function render(node: React.ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() => root.render(node));
  return {
    el: container,
    unmount: () => {
      flushSync(() => root.unmount());
      container.remove();
    },
  };
}

describe('MemoryRecordDetail: type/scope/review-state/provenance', () => {
  test('renders the type, scope, and review-state facts', () => {
    const { el, unmount } = render(
      <MemoryRecordDetail record={record({ cls: 'decision', scope: 'team', reviewState: 'reviewed', confidence: 92 })} />,
    );
    expect(el.textContent).toContain('decision');
    expect(el.textContent).toContain('team');
    expect(el.textContent).toContain('reviewed');
    expect(el.textContent).toContain('92%');
    unmount();
  });

  test('a stale/contradicted record surfaces its stale reason plainly', () => {
    const { el, unmount } = render(
      <MemoryRecordDetail record={record({ reviewState: 'contradicted', staleReason: 'Superseded by the 1.1.0 pin decision' })} />,
    );
    expect(el.textContent).toContain('Superseded by the 1.1.0 pin decision');
    unmount();
  });

  test('NO-SECRET-RENDER PIN: a file-path provenance ref renders as plain text, never a link or fetch target', () => {
    const { el, unmount } = render(
      <MemoryRecordDetail record={record({
        provenance: [{ kind: 'file', ref: '/home/user/.env', label: undefined }],
      })} />,
    );
    // The path IS shown, provenance is meant to be legible, but only as inert text.
    expect(el.textContent).toContain('/home/user/.env');
    // Never as a navigable/fetchable link.
    expect(el.querySelector('a[href*=".env"]')).toBeFalsy();
    expect(el.querySelector('[href]')).toBeFalsy();
    expect(el.querySelector('img[src*=".env"]')).toBeFalsy();
    unmount();
  });

});
