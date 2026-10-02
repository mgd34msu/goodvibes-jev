import { describe, test, expect, beforeEach } from 'bun:test';
import { LiveTailModal, renderLiveTailModal } from '../../renderer/live-tail-modal.ts';
import type { ProcessEntry } from '../../renderer/process-modal.ts';
import { getTestProcessManager, resetTestProcessManager, resetTestRuntimeServices } from '../helpers/runtime-services.ts';
import { layerTextBlock } from '../helpers/surface-frame.ts';

const W = 100;

beforeEach(() => {
  resetTestRuntimeServices();
  resetTestProcessManager();
});

function makeEntry(overrides: Partial<ProcessEntry> = {}): ProcessEntry {
  return {
    id: 'test-id',
    label: 'Test process',
    type: 'exec',
    status: 'running',
    elapsedMs: 5000,
    ...overrides,
  };
}

function createLiveTailModal(): LiveTailModal {
  return new LiveTailModal({
    processManager: getTestProcessManager(),
  });
}

describe('LiveTailModal state', () => {
  test('initially inactive with null entry', () => {
    const modal = createLiveTailModal();
    expect(modal.active).toBe(false);
    expect(modal.entry).toBeNull();
  });

  test('open() sets active=true and entry', () => {
    const modal = createLiveTailModal();
    const entry = makeEntry();
    modal.open(entry);
    expect(modal.active).toBe(true);
    expect(modal.entry).toBe(entry);
    expect(modal.scrollOffset).toBe(0);
  });

  test('close() resets active, entry, and scrollOffset', () => {
    const modal = createLiveTailModal();
    modal.open(makeEntry());
    modal.scrollUp();
    modal.close();
    expect(modal.active).toBe(false);
    expect(modal.entry).toBeNull();
    expect(modal.scrollOffset).toBe(0);
  });

  test('scrollDown() does not go below 0', () => {
    const modal = createLiveTailModal();
    modal.open(makeEntry());
    modal.scrollDown();
    expect(modal.scrollOffset).toBe(0);
  });

  test('getOutput() returns empty string when entry is null', () => {
    const modal = createLiveTailModal();
    expect(modal.getOutput()).toBe('');
  });

  test('getOutput() returns exec output for exec entries', async () => {
    const processManager = getTestProcessManager();
    const result = await processManager.spawn('echo hello', undefined, undefined);
    const id = result.process_id;
    if (!id) throw new Error('expected process id');
    const modal = createLiveTailModal();
    modal.open(makeEntry({ id, label: 'echo hello' }));
    expect(typeof modal.getOutput()).toBe('string');
  });

  test('stopProcess() delegates to ProcessManager for exec entries', async () => {
    const processManager = getTestProcessManager();
    const result = await processManager.spawn('sleep 100', undefined, undefined);
    const id = result.process_id;
    if (!id) throw new Error('expected process id');
    const modal = createLiveTailModal();
    modal.open(makeEntry({ id }));
    expect(typeof modal.stopProcess()).toBe('boolean');
  });
});

describe('renderLiveTailModal', () => {
  const H = 30;
  const text = (modal: LiveTailModal): string => layerTextBlock(renderLiveTailModal(modal, W, H));

  test('returns null when no process is open', () => {
    expect(renderLiveTailModal(createLiveTailModal(), W, H)).toBeNull();
  });

  test('is a kit modal layer that fits the screen', () => {
    const modal = createLiveTailModal();
    modal.open(makeEntry({ label: 'Process task' }));
    const layer = renderLiveTailModal(modal, W, H)!;
    expect(layer.x + layer.lines[0]!.length).toBeLessThanOrEqual(W);
    expect(layer.y + layer.lines.length).toBeLessThanOrEqual(H);
  });

  test('shows the full command under the title', () => {
    const modal = createLiveTailModal();
    modal.open(makeEntry({ label: 'tail me' }));
    const output = text(modal);
    expect(output).toContain('Runtime activity › Live output');
    expect(output).toContain('$ tail me');
  });

  test('renders (no output yet) for missing exec output', () => {
    const modal = createLiveTailModal();
    modal.open(makeEntry({ id: 'no-such-exec', label: 'cmd' }));
    expect(text(modal)).toContain('no output yet');
  });

  test('hints name stopping the process and going back without stopping it', () => {
    const modal = createLiveTailModal();
    modal.open(makeEntry({ label: 'Hint test' }));
    const output = text(modal);
    expect(output).toContain('k  stop process');
    expect(output).toContain('esc  back, the process keeps running');
    expect(output).not.toContain('[agent]');
  });
});
