/**
 * The Activity modal: fleet honesty
 * on its agent rows (the fleet read-model's per-node headline, replaced in
 * place, never a feed, and the stall tell as a quiet-duration marker), its
 * sections, its live search row and its keys.
 */
import { describe, expect, test } from 'bun:test';
import { buildActivityAgentRows, renderActivityModal, type ActivityView } from '../../renderer/activity-modal.ts';
import { ActivityModal } from '../../input/activity-modal.ts';
import { SurfaceModalHost } from '../../input/surface-modal-host.ts';
import { layerText, layerTextBlock } from '../helpers/surface-frame.ts';

function view(agents: ActivityView['now']['agents'], extra: Partial<ActivityView> = {}): ActivityView {
  return { now: { busy: false, agents, processes: 0 }, needsYou: [], comingUp: [], recent: [], ...extra };
}

function render(agents: ActivityView['now']['agents']): string[] {
  return layerText(renderActivityModal({ view: view(agents), query: '', selectedIndex: 0 }, 100, 30));
}

const buildSidebarAgentRows = buildActivityAgentRows;

describe('activity modal fleet rows', () => {
  test('renders the fleet headline for an agent row when present', () => {
    const rows = render([{ label: 'researcher', progress: 'Turn 12 · Bash', headline: 'Summarize the audit' }]);
    const agentRow = rows.find((line) => line.includes('researcher'));
    expect(agentRow).toBeDefined();
    expect(agentRow).toContain('Summarize the audit');
    // The headline WINS over the per-turn progress churn (a feed, not a transition).
    expect(agentRow).not.toContain('Turn 12');
  });

  test('falls back to the progress line when no headline exists', () => {
    const rows = render([{ label: 'researcher', progress: 'gathering sources' }]);
    const agentRow = rows.find((line) => line.includes('researcher'));
    expect(agentRow).toContain('gathering sources');
  });

  test('renders the stall tell as a quiet-duration marker', () => {
    const rows = render([{ label: 'builder', headline: 'Compile the release', quietForMs: 6 * 60_000 }]);
    const agentRow = rows.find((line) => line.includes('builder'));
    expect(agentRow).toContain('quiet 6m');
  });

  test('no quiet marker renders for an active row', () => {
    const rows = render([{ label: 'builder', headline: 'Compile the release' }]);
    const agentRow = rows.find((line) => line.includes('builder'));
    expect(agentRow).not.toContain('quiet');
  });

  test('hour-scale stalls render compactly', () => {
    const rows = render([{ label: 'builder', quietForMs: 90 * 60_000 }]);
    const agentRow = rows.find((line) => line.includes('builder'));
    expect(agentRow).toContain('quiet 1h 30m');
  });

  test('buildSidebarAgentRows joins agents to fleet nodes by id', () => {
    const rows = buildSidebarAgentRows(
      [
        { id: 'a-1', label: 'researcher', latestProgress: ' Turn 3 · Read ' },
        { id: 'a-2', label: 'builder' },
      ],
      [
        { id: 'a-1', headline: { text: 'Map the audit scope' }, stall: { quietForMs: 120_000 } },
        { id: 'unrelated-node' },
      ],
    );
    expect(rows).toEqual([
      { id: 'a-1', label: 'researcher', progress: 'Turn 3 · Read', headline: 'Map the audit scope', quietForMs: 120_000 },
      { id: 'a-2', label: 'builder', progress: undefined, headline: undefined, quietForMs: undefined },
    ]);
  });

  test('a live agent node no local agent carries is shown as running elsewhere', () => {
    const rows = buildSidebarAgentRows(
      [{ id: 'a-1', label: 'researcher' }],
      [
        { id: 'a-1', kind: 'agent', state: 'running' },
        { id: 'd-9', kind: 'agent', state: 'running', label: 'nightly digest', headline: { text: 'Summarizing inbox' } },
      ],
    );
    expect(rows).toEqual([
      { id: 'a-1', label: 'researcher', progress: undefined, headline: undefined, quietForMs: undefined },
      { label: 'nightly digest (elsewhere)', headline: 'Summarizing inbox', quietForMs: undefined },
    ]);
  });

  test('rows this process runs keep the room: eight local agents leave none for elsewhere', () => {
    const rows = buildSidebarAgentRows(
      Array.from({ length: 9 }, (_, i) => ({ id: `a-${i}`, label: `agent ${i}` })),
      [{ id: 'd-9', kind: 'agent', state: 'running', label: 'nightly digest' }],
    );
    expect(rows).toHaveLength(8);
    expect(rows.some((row) => row.label.includes('elsewhere'))).toBe(false);
  });

  test('finished work and non-agent nodes from elsewhere are not rows', () => {
    const rows = buildSidebarAgentRows(
      [],
      [
        { id: 'd-1', kind: 'agent', state: 'completed', label: 'finished digest' },
        { id: 'd-2', kind: 'process', state: 'running', label: 'a background command' },
        { id: 'd-3', kind: 'agent', state: 'blocked', label: 'waiting on approval' },
      ],
    );
    expect(rows.map((row) => row.label)).toEqual(['waiting on approval (elsewhere)']);
  });
});

describe('activity modal', () => {
  const full = view([{ label: 'researcher', headline: 'comparing fares' }], {
    now: { busy: true, label: 'Searching the web', agents: [{ label: 'researcher', headline: 'comparing fares' }], processes: 2 },
    needsYou: ['Approval needed, answer the prompt on screen.'],
    comingUp: ['Reminder at 08:00'],
    recent: [{ at: Date.now(), kind: 'delivery', priority: 'high', text: '[Telegram] Reminder delivered' }],
  });

  test('shows every section as a group, with the full text of each item', () => {
    const text = layerTextBlock(renderActivityModal({ view: full, query: '', selectedIndex: 0 }, 100, 30));
    for (const header of ['✦ now', '✦ needs you', '✦ coming up', '✦ recent']) expect(text).toContain(header);
    expect(text).toContain('Searching the web');
    expect(text).toContain('2 background processes');
    expect(text).toContain('Approval needed, answer the prompt on screen.');
    // The "[Tag]" is dropped: the glyph and color carry the kind.
    expect(text).toContain('Reminder delivered');
    expect(text).not.toContain('[Telegram]');
  });

  test('the search row is always live and filters every section', () => {
    const modal = new ActivityModal({ view: () => full });
    const host = new SurfaceModalHost();
    host.push(modal);
    for (const ch of 'remind') host.handleToken({ type: 'text', value: ch } as never);
    const text = layerTextBlock(modal.render(100, 30));
    expect(text).toContain('remind▏');
    expect(text).toContain('Reminder at 08:00');
    expect(text).not.toContain('Searching the web');
  });

  test('Enter on an agent or process row opens the process monitor and closes the modal', () => {
    let opened = 0;
    const modal = new ActivityModal({ view: () => full, openProcesses: () => { opened += 1; } });
    const host = new SurfaceModalHost();
    host.push(modal);
    host.handleToken({ type: 'key', logicalName: 'down' } as never);
    expect(layerTextBlock(modal.render(100, 30))).toContain('⏎  open process monitor');
    host.handleToken({ type: 'key', logicalName: 'enter' } as never);
    expect(opened).toBe(1);
    expect(host.active).toBe(false);
  });

  test('Enter on an agent this process runs opens it full screen and closes the modal; the monitor is not opened', () => {
    const withId = view([], { now: { busy: false, agents: [{ id: 'a-1', label: 'researcher', headline: 'comparing fares' }], processes: 1 } });
    const targets: Array<{ kind: string; id: string }> = [];
    let monitor = 0;
    const modal = new ActivityModal({ view: () => withId, openProcesses: () => { monitor += 1; }, openSessionView: (target) => { targets.push(target); return true; } });
    const host = new SurfaceModalHost();
    host.push(modal);
    expect(layerTextBlock(modal.render(100, 30))).toContain('⏎  open agent');
    host.handleToken({ type: 'key', logicalName: 'enter' } as never);
    expect(targets).toEqual([{ kind: 'agent', id: 'a-1' }]);
    expect(monitor).toBe(0);
    expect(host.active).toBe(false);
  });

  test('an agent that cannot open full screen falls back to the process monitor', () => {
    const withId = view([], { now: { busy: false, agents: [{ id: 'a-1', label: 'researcher' }], processes: 0 } });
    let monitor = 0;
    const modal = new ActivityModal({ view: () => withId, openProcesses: () => { monitor += 1; }, openSessionView: () => false });
    const host = new SurfaceModalHost();
    host.push(modal);
    host.handleToken({ type: 'key', logicalName: 'enter' } as never);
    expect(monitor).toBe(1);
    expect(host.active).toBe(false);
  });

  test('Esc pops the modal and nothing else', () => {
    const host = new SurfaceModalHost();
    host.push(new ActivityModal({ view: () => full }));
    expect(host.escape()).toBe(true);
    expect(host.active).toBe(false);
    expect(host.escape()).toBe(false);
  });

  test('says so when there is nothing yet', () => {
    expect(layerTextBlock(renderActivityModal({ view: view([]), query: '', selectedIndex: 0 }, 100, 30))).toContain('Nothing yet, activity will show up here.');
  });
});
