import { describe, test, expect, beforeEach } from 'bun:test';
import type { BackgroundProcess } from '@goodvibes-jev/engine/sdk/platform/tools';
import { ProcessModal, renderProcessModal } from '../../renderer/process-modal.ts';
import { activeTokens } from '../../renderer/theme.ts';
import { layerText, layerTextBlock } from '../helpers/surface-frame.ts';

const W = 100;

type TestProcessRecord = BackgroundProcess & {
  status: string;
};

const processes = new Map<string, TestProcessRecord>();

beforeEach(() => {
  processes.clear();
});

function seedProcess(cmd: string, status = 'running'): string {
  const id = `process-${processes.size + 1}`;
  processes.set(id, {
    id,
    cmd,
    status,
    // The manager reports whether a process ended as a field; the status text only describes how.
    done: status !== 'running',
    startTime: Date.now() - 1200,
  } as TestProcessRecord);
  return id;
}

function createProcessModal(): ProcessModal {
  return new ProcessModal({
    processManager: {
      list: () => Array.from(processes.values()),
      getStatus: (id: string) => processes.get(id),
      stop: (id: string) => {
        const record = processes.get(id);
        if (!record) return false;
        record.status = 'done';
        record.done = true;
        return true;
      },
    },
  });
}

describe('ProcessModal state', () => {
  test('initially inactive with no entries', () => {
    const modal = createProcessModal();
    expect(modal.active).toBe(false);
    expect(modal.entries).toEqual([]);
  });

  test('open() sets active=true and selectedIndex=0', () => {
    const modal = createProcessModal();
    modal.open();
    expect(modal.active).toBe(true);
    expect(modal.selectedIndex).toBe(0);
  });

  test('close() sets active=false', () => {
    const modal = createProcessModal();
    modal.open();
    modal.close();
    expect(modal.active).toBe(false);
  });

  test('refresh() populates entries from running shell processes only', () => {
    seedProcess('bun run build');
    seedProcess('bun test', 'done');
    const modal = createProcessModal();
    modal.refresh();
    expect(modal.entries).toHaveLength(1);
    expect(modal.entries[0]?.type).toBe('exec');
    expect(modal.entries[0]?.label).toContain('bun run build');
  });

  test('a process ended by its timeout is not listed as running (its status does not start with "done")', () => {
    seedProcess('for i in 1 2 3; do echo tick; sleep 5; done', 'timed out (signal SIGTERM)');
    seedProcess('bun run dev');
    const modal = createProcessModal();
    modal.refresh();
    expect(modal.entries.map((e) => e.label)).toEqual([expect.stringContaining('bun run dev')]);
  });

  test('moveDown() wraps around to first entry', () => {
    seedProcess('Task A');
    seedProcess('Task B');
    const modal = createProcessModal();
    modal.open();
    expect(modal.selectedIndex).toBe(0);
    modal.moveDown();
    expect(modal.selectedIndex).toBe(1);
    modal.moveDown();
    expect(modal.selectedIndex).toBe(0);
  });

  test('moveUp() wraps around to last entry', () => {
    seedProcess('Task A');
    seedProcess('Task B');
    const modal = createProcessModal();
    modal.open();
    modal.moveUp();
    expect(modal.selectedIndex).toBe(1);
  });

  test('stopSelected() delegates only to ProcessManager', () => {
    const id = seedProcess('sleep 100');
    const modal = createProcessModal();
    modal.open();
    expect(modal.stopSelected()).toBe(true);
    expect(processes.get(id)?.status).toBe('done');
  });
});

describe('renderProcessModal', () => {
  const H = 30;

  test('renders the empty state when no processes are running', () => {
    expect(layerTextBlock(renderProcessModal(createProcessModal(), W, H))).toContain('No running shell processes');
  });

  test('is a kit modal layer that fits the screen', () => {
    const layer = renderProcessModal(createProcessModal(), W, H);
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(W);
    expect(layer.y + layer.lines.length).toBeLessThanOrEqual(H);
  });

  test('renders each process with its status', () => {
    seedProcess('bun run build');
    const modal = createProcessModal();
    modal.open();
    const text = layerTextBlock(renderProcessModal(modal, W, H));
    expect(text).toContain('bun run build');
    expect(text).toContain('running');
    expect(text).toContain('1 running');
  });

  test('the selected process is the gradient row', () => {
    seedProcess('Task A');
    seedProcess('Task B');
    const modal = createProcessModal();
    modal.open();
    modal.moveDown();
    const layer = renderProcessModal(modal, W, H);
    const ink = activeTokens().selectedListItemText;
    const row = layer.lines.findIndex((line) => line.some((c) => c.fg === ink && c.bold && c.char.trim() !== ''));
    expect(layerText(layer)[row]).toContain('Task B');
  });

  test('says Esc leaves the processes running and names the keys', () => {
    seedProcess('Task A');
    const modal = createProcessModal();
    modal.open();
    const text = layerTextBlock(renderProcessModal(modal, W, H));
    expect(text).toContain('Esc closes this view; processes keep running.');
    expect(text).toContain('k  stop process');
    expect(text).not.toContain('[agent]');
  });
});


test('process summaries use current typed records and omit entries removed during refresh', () => {
  const active = seedProcess('synthetic active command');
  const completed = seedProcess('synthetic completed command', 'timed out');
  const activeWithTerminalText = seedProcess('still active despite descriptive status', 'timed out');
  processes.get(activeWithTerminalText)!.done = false;
  const listed = [...processes.values()].map(({ id, cmd, status, done }) => ({ id, pid: 0, cmd, status, done }));
  listed.push({ id: 'already-pruned', pid: 0, cmd: 'missing record', status: 'running', done: false });
  const modal = new ProcessModal({ processManager: {
    list: () => listed,
    getStatus: id => processes.get(id),
    stop: () => false,
  } });
  expect(listed.find(row => row.id === completed)?.done).toBe(true);
  expect(listed.find(row => row.id === activeWithTerminalText)?.done).toBe(false);
  expect(processes.get(completed)?.done).toBe(true);
  modal.refresh();
  expect(modal.entries.map(row => row.id)).toEqual([active, activeWithTerminalText]);
  expect(modal.entries[0]!.elapsedMs).toBeGreaterThanOrEqual(1200);
});
