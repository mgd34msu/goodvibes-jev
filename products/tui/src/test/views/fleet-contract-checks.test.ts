import { describe, expect, test } from 'bun:test';
import type { ProcessCheckSummary, ProcessNode } from '@goodvibes-jev/engine/sdk/platform/runtime/fleet';
import { renderCheckLines, renderFleetDetailLines } from '../../views/fleet-format.ts';
import { contractFixture } from '../helpers/contract-work-tree-fixtures.ts';
import { lineToString } from '../setup.ts';
const text = (lines: ReturnType<typeof renderCheckLines>) => lines.map(lineToString).join('\n');
const check: ProcessCheckSummary = { met: 1, judged: 3, nudges: 2, criteria: [
  { id: 'a', text: 'The parser handles empty input', verdict: 'met', outcome: 'act' },
  { id: 'b', text: 'Errors report the line number', verdict: 'unmet', outcome: 'act', severity: 'major' },
  { id: 'c', text: 'A retained requirement needs evidence', verdict: 'unshown', outcome: 'confirm' },
  { id: 'd', text: 'A requirement not yet read', verdict: 'unread' },
] };
function node(extra: Partial<ProcessNode> = {}): ProcessNode {
  return { id: 'contract:c1', kind: 'contract', label: 'Parser repair', state: 'done', elapsedMs: 1, costState: 'unpriced', capabilities: { interruptible: false, killable: false, pausable: false, resumable: false, steerable: false }, ...extra };
}
describe('contract criteria in fleet details', () => {
  test('renders only recorded verdicts, bands, corrections and severity', () => {
    const rendered = text(renderCheckLines(check, 80));
    expect(rendered).toContain('1/3 criteria met · 2 corrections');
    for (const verdict of ['met', 'unmet', 'unshown', 'unread']) expect(rendered).toContain(`[${verdict}`);
    expect(rendered).toContain('confirm'); expect(rendered).toContain('major');
    expect(rendered).not.toContain('score');
  });
  test('absent checks stay absent and empty criteria do not fabricate a gate failure', () => {
    expect(text(renderFleetDetailLines(node(), 80, false, false))).not.toContain('criteria met');
    const empty = text(renderCheckLines({ met: 0, judged: 0, nudges: 0, criteria: [] }, 80));
    expect(empty).toContain('No recorded criteria'); expect(empty).not.toContain('failure');
  });
  test('passed lifecycle keeps failed application visible with the actual workspace', () => {
    const contract = contractFixture({ worktreePath: '/synthetic/worktree', commit: { status: 'failed', note: 'Not applied to the selected tree' } });
    const lines = renderFleetDetailLines(node({ raw: contract, check }), 80, false, false);
    const rendered = text(lines);
    expect(rendered).toContain('/synthetic/worktree');
    expect(rendered).toContain('Changes failed: Not applied');
    expect(rendered).toContain('The parser handles empty input');
    for (const line of lines) expect(lineToString(line).length).toBeLessThanOrEqual(80);
  });
});
