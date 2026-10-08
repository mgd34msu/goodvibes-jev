import { describe, expect, test } from 'bun:test';
import { ConfigModal } from '../../input/config-modal.ts';
import { renderConfigModal } from '../../renderer/config-modal.ts';
import { planningModalGoldenSurface } from '../helpers/planning-modal-fixture.ts';
import { frameFromLayer, frameText } from '../helpers/surface-frame.ts';
import { assertGoldenIn } from '../helpers/golden-snapshot.ts';
import type { ProjectPlanningState } from '@goodvibes-jev/engine/sdk/platform/knowledge';
import { createPlanningModalSurface, type PlanningModalService } from '../../views/modals/planning-modal.ts';
import { modalGeometry, MODAL_PAD_X } from '../../renderer/surface-kit.ts';

const goldens = new URL('./golden-frames/', import.meta.url).pathname;
async function openPlanning() {
  const surface = await planningModalGoldenSurface(); const modal = new ConfigModal();
  modal.open(surface); await new Promise(resolve => setTimeout(resolve, 0)); modal.syncStructure();
  return { modal, surface };
}

describe('passive planning history in the actual modal host', () => {
  for (const { name, width } of [{ name: 'normal', width: 100 }, { name: 'hostile', width: 28 }]) {
    test(`${name} width matches its host-rendered golden`, async () => {
      const { modal, surface } = await openPlanning();
      try {
        expect(surface.buildView().tabs[0]!.rows.every(row => row.selectable === false)).toBe(true);
        const lines = frameFromLayer(renderConfigModal(modal, width, 40), width, 40);
        expect(lines).toHaveLength(40); assertGoldenIn(goldens, `planning-modal-${name}`, lines);
      } finally { modal.close(); }
    });
  }

  test('Enter and old approval/dismiss keys cannot send commands or native input', async () => {
    const { modal } = await openPlanning(); const effects: string[] = [];
    for (const key of ['enter', 'a', 'd']) {
      expect(modal.fireAction(key, { print: text => effects.push(text), executeCommand: async () => { effects.push('command'); }, submitInput: () => effects.push('native') })).toBe(false);
    }
    expect(modal.active).toBe(true); expect(effects).toEqual([]);
    modal.close(); expect(modal.active).toBe(false); expect(effects).toEqual([]);
  });

  test('long saved question, answer and metadata tails remain reachable on a narrow, short screen', async () => {
    const state: ProjectPlanningState = {
      id: 'long-history', projectId: 'fixture', knowledgeSpaceId: 'project:fixture', goal: 'Inspect retained history',
      knownContext: [], openQuestions: [], answeredQuestions: [{ id: 'saved-question', status: 'answered',
        prompt: `${'Saved question context '.repeat(50)}QUESTIONEND`, answer: `${'Saved answer detail '.repeat(50)}ANSWEREND` }],
      decisions: [], assumptions: [], constraints: [], risks: [], tasks: [], dependencies: [],
      verificationGates: [], agentAssignments: [], readiness: 'needs-user-input', executionApproved: false,
      createdAt: 0, updatedAt: 0, metadata: { linkedArtifact: `${'Saved artifact detail '.repeat(50)}METADATAEND` },
    };
    const identity = { ok: true as const, projectId: 'fixture', knowledgeSpaceId: 'project:fixture' };
    const service: PlanningModalService = {
      status: async () => ({ ...identity, passiveOnly: true, counts: { states: 1, decisions: 0, languageArtifacts: 0, workPlans: 0, workPlanTasks: 0 }, capabilities: [] }),
      getState: async () => ({ ...identity, state }),
      listDecisions: async () => ({ ...identity, decisions: [] }),
      getLanguage: async () => ({ ...identity, language: null }),
    };
    const modal = new ConfigModal();
    modal.open(createPlanningModalSurface({ projectId: 'fixture', service }));
    await new Promise(resolve => setTimeout(resolve, 0));
    try {
      let rendered = ''; let previousOffset = -1;
      const wrapWidth = Math.max(1, modalGeometry(40, 20).w - 2 * MODAL_PAD_X);
      // Traverse actual rendered lines, not the unwindowed source rows. A row
      // taller than the viewport must expose its tail before scrolling past it.
      for (let count = 0; count < 1000; count++) {
        rendered += frameText(frameFromLayer(renderConfigModal(modal, 40, 20), 40, 20)).join('\n');
        const offset = modal.getRenderModel(wrapWidth).scroll.offset;
        if (offset === previousOffset) break;
        previousOffset = offset;
        modal.moveDown();
      }
      for (const tail of ['QUESTIONEND', 'ANSWEREND', 'METADATAEND']) expect(rendered).toContain(tail);
    } finally { modal.close(); }
  });
});
