import { describe, test, expect, mock } from 'bun:test';
import { LiveTailModal, renderLiveTailModal, type LiveTailModalDeps } from '../../renderer/live-tail-modal.ts';
import type { ProcessEntry } from '../../renderer/process-modal.ts';
import { layerTextBlock } from '../helpers/surface-frame.ts';

const W = 100;

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

// Exercise the modal's public process port. Process spawning, judgment, and
// OS cancellation belong to the real-process integration suites.
function createLiveTailModal(processManager: LiveTailModalDeps['processManager'] = {
  getOutput: () => undefined,
  stop: () => false,
}): LiveTailModal {
  return new LiveTailModal({ processManager });
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

  test('getOutput() reads the selected exec entry and combines its current stdout and stderr', () => {
    const id = 'exec-output';
    let output = { stdout: 'hello', stderr: 'warning\n' };
    const getOutput = mock((_id: string) => output);
    const modal = createLiveTailModal({ getOutput, stop: () => false });
    modal.open(makeEntry({ id, label: 'echo hello' }));
    expect(modal.getOutput()).toBe('hello\nwarning');
    expect(getOutput).toHaveBeenLastCalledWith(id);
    output = { stdout: 'hello\nnext line\n', stderr: '' };
    expect(modal.getOutput()).toBe('hello\nnext line');
    expect(getOutput).toHaveBeenCalledTimes(2);
  });

  test('stopProcess() delegates to the selected exec entry and preserves the process port result', () => {
    const id = 'exec-running';
    let running = true;
    const stop = mock((_id: string) => {
      const wasRunning = running;
      running = false;
      return wasRunning;
    });
    const modal = createLiveTailModal({ getOutput: () => undefined, stop });
    modal.open(makeEntry({ id }));
    expect(modal.stopProcess()).toBe(true);
    expect(stop).toHaveBeenLastCalledWith(id);
    expect(running).toBe(false);
    expect(modal.stopProcess()).toBe(false);
    expect(stop).toHaveBeenCalledTimes(2);
  });

  test('a closed modal neither reads output nor stops a process', () => {
    const getOutput = mock((_id: string) => ({ stdout: 'saved output', stderr: '' }));
    const stop = mock((_id: string) => true);
    const modal = createLiveTailModal({ getOutput, stop });
    modal.open(makeEntry());
    modal.close();
    expect(modal.getOutput()).toBe('');
    expect(modal.stopProcess()).toBe(false);
    expect(getOutput).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  test('an empty process buffer and a pruned process have distinct output states', () => {
    const getOutput = mock((id: string) => id === 'empty' ? { stdout: '', stderr: '' } : undefined);
    const modal = createLiveTailModal({ getOutput, stop: () => false });
    modal.open(makeEntry({ id: 'empty' }));
    expect(modal.getOutput()).toBe('(no output yet)');
    expect(getOutput).toHaveBeenLastCalledWith('empty');
    modal.open(makeEntry({ id: 'pruned', status: 'done' }));
    expect(modal.getOutput()).toBe('');
    expect(getOutput).toHaveBeenLastCalledWith('pruned');
  });

  test('a finished process keeps its buffered output when stopping it is no longer possible', () => {
    const id = 'exec-finished';
    const getOutput = mock((_id: string) => ({ stdout: 'finished\n', stderr: '' }));
    const stop = mock((_id: string) => false);
    const modal = createLiveTailModal({ getOutput, stop });
    modal.open(makeEntry({ id, status: 'done', elapsedMs: 6000 }));
    expect(modal.getOutput()).toBe('finished');
    expect(getOutput).toHaveBeenLastCalledWith(id);
    expect(modal.stopProcess()).toBe(false);
    expect(stop).toHaveBeenLastCalledWith(id);
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
