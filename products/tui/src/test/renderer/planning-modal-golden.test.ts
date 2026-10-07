import { describe, expect, test } from 'bun:test';
import { ConfigModal } from '../../input/config-modal.ts';
import { renderConfigModal } from '../../renderer/config-modal.ts';
import { planningModalGoldenSurface } from '../helpers/planning-modal-fixture.ts';
import { frameFromLayer } from '../helpers/surface-frame.ts';
import { assertGoldenIn } from '../helpers/golden-snapshot.ts';

const goldens = new URL('./golden-frames/', import.meta.url).pathname;
async function openPlanning() {
  const surface = await planningModalGoldenSurface();
  const modal = new ConfigModal();
  modal.open(surface);
  await new Promise((resolve) => setTimeout(resolve, 0));
  modal.syncStructure();
  return { modal, surface };
}

describe('planning modal with recorded answer readings', () => {
  for (const { name, width } of [{ name: 'normal', width: 100 }, { name: 'hostile', width: 28 }]) {
    test(`${name} width matches its host-rendered golden`, async () => {
      const { modal, surface } = await openPlanning();
      try {
        expect(surface.buildView().tabs[0]!.rows.some((row) => row.id.endsWith(':scope-focused-first-pass'))).toBe(true);
        const lines = frameFromLayer(renderConfigModal(modal, width, 40), width, 40);
        expect(lines).toHaveLength(40);
        assertGoldenIn(goldens, `planning-modal-${name}`, lines);
      } finally { modal.close(); }
    });
  }

  test('suggestions arriving after navigation preserve the selected manual route', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const surface = await planningModalGoldenSurface(pending);
    const modal = new ConfigModal();
    modal.open(surface);
    await new Promise((resolve) => setTimeout(resolve, 0));
    modal.syncStructure();
    const custom = surface.buildView().tabs[0]!.rows.find((row) => row.id.endsWith(':custom'))!;
    expect(surface.buildView().tabs[0]!.rows.some((row) => row.id.endsWith(':scope-focused-first-pass'))).toBe(false);
    modal.noteInteraction();
    modal.jumpToRow('planning', custom.id);
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(surface.buildView().tabs[0]!.rows.some((row) => row.id.endsWith(':scope-focused-first-pass'))).toBe(true);
    expect(modal.getSelectedRowId()).toBe(custom.id);
    const effects: string[] = [];
    modal.fireAction('enter', {
      print: (text) => effects.push(text),
      executeCommand: async () => { effects.push('unexpected command'); },
      submitInput: () => { effects.push('unexpected submission'); },
    });
    expect(modal.active).toBe(false);
    expect(effects).toEqual(['Reopen /project-plan history to review the current saved question. Use /project-plan answer <question-number|question-id> <your answer> for a saved historical question. This targets the current saved plan. Plain text enters native intake as a separate request.']);
  });

  test('the actual host exposes custom entry and releases modal focus before the composer guidance', async () => {
    const { modal, surface } = await openPlanning();
    const custom = surface.buildView().tabs[0]!.rows.find((row) => row.id.endsWith(':custom'))!;
    modal.jumpToRow('planning', custom.id);
    const effects: string[] = [];
    expect(modal.fireAction('enter', {
      print: (text) => { expect(modal.active).toBe(false); effects.push(text); },
      submitInput: () => { effects.push('unexpected automatic submission'); },
    })).toBe(true);
    expect(modal.active).toBe(false);
    expect(effects).toEqual(['Reopen /project-plan history to review the current saved question. Use /project-plan answer <question-number|question-id> <your answer> for a saved historical question. This targets the current saved plan. Plain text enters native intake as a separate request.']);
  });
});
