import { describe, expect, test } from 'bun:test';
import { useCoreReadings } from './_helpers/core-readings.ts';
import { AdaptivePlanner, type PlannerInputs } from '../sdk/src/platform/core/adaptive-planner.js';
import { JudgmentInputError } from '../sdk/src/platform/gate/judgment-input.js';
import { synthesizeAnswer } from '../sdk/src/platform/knowledge/semantic/answer-llm.js';
import type { AnswerEvidenceProjection } from '../sdk/src/platform/knowledge/semantic/answer-verification/types.js';
import type { KnowledgeSemanticLlm } from '../sdk/src/platform/knowledge/semantic/types.js';

const marker = 'password=SYNTHETIC_CALLER_SNAPSHOT_ONLY';
const options = () => ({ signal: new AbortController().signal, timeoutMs: 1000 });
function capturedLlm() {
  const requests: Parameters<KnowledgeSemanticLlm['completeText']>[0][] = [];
  const llm: KnowledgeSemanticLlm = {
    async completeJson() { throw new Error('Unexpected JSON generation'); },
    async completeText(request) { requests.push(request); return ' Four ports. '; },
  };
  return { llm, requests };
}

describe('answer generation uses the inspected evidence snapshot', () => {
  test('descriptor data reaches generation without rereading a Proxy get trap', async () => {
    let gets = 0;
    const evidence = new Proxy({ reference: 'evidence-1', text: 'Four ports.' }, {
      get(target, key, receiver) { gets++; return key === 'text' ? marker : Reflect.get(target, key, receiver); },
    });
    const { llm, requests } = capturedLlm();
    expect(await synthesizeAnswer(llm, 'How many ports?', 'concise', [evidence], options())).toBe('Four ports.');
    expect(gets).toBe(0);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!.prompt)).toEqual({ query: 'How many ports?', mode: 'concise', evidence: [{ reference: 'evidence-1', text: 'Four ports.' }] });
    expect(JSON.stringify(requests)).not.toContain(marker);
  });
  test('protected descriptor data refuses generation without invoking a benign get trap', async () => {
    let gets = 0;
    const evidence = new Proxy({ reference: 'evidence-1', text: marker }, {
      get(target, key, receiver) { gets++; return key === 'text' ? 'ordinary' : Reflect.get(target, key, receiver); },
    });
    const { llm, requests } = capturedLlm();
    await expect(synthesizeAnswer(llm, 'Question', 'standard', [evidence], options())).rejects.toBeInstanceOf(JudgmentInputError);
    expect(gets).toBe(0); expect(requests).toHaveLength(0);
  });
  test('evidence accessors are refused without execution', async () => {
    let gets = 0;
    const evidence = { reference: 'evidence-1', get text() { gets++; return marker; } };
    const { llm, requests } = capturedLlm();
    await expect(synthesizeAnswer(llm, 'Question', 'standard', [evidence], options())).rejects.toBeInstanceOf(JudgmentInputError);
    expect(gets).toBe(0); expect(requests).toHaveLength(0);
  });
  test('array serialization hooks cannot run after preflight', async () => {
    let calls = 0;
    const evidence: AnswerEvidenceProjection[] = [{ reference: 'evidence-1', text: 'Four ports.' }];
    Object.defineProperty(evidence, 'toJSON', { value() { calls++; return [{ text: marker }]; } });
    const { llm, requests } = capturedLlm();
    await expect(synthesizeAnswer(llm, 'Question', 'standard', evidence, options())).rejects.toBeInstanceOf(JudgmentInputError);
    expect(calls).toBe(0); expect(requests).toHaveLength(0);
  });
  test.each([['concise', 700], ['standard', 1400], ['detailed', 2200]] as const)('preserves %s generation budget and evidence', async (mode, maxTokens) => {
    const { llm, requests } = capturedLlm();
    const evidence = [{ reference: 'evidence-1', title: 'Manual', text: 'Four ports.', facts: ['HDMI ports: four'] }];
    await synthesizeAnswer(llm, 'How many?', mode, evidence, options());
    expect(requests).toHaveLength(1); expect(requests[0]!.maxTokens).toBe(maxTokens);
    expect(JSON.parse(requests[0]!.prompt)).toEqual({ query: 'How many?', mode, evidence });
  });
});

describe('planner materializes inputs before privacy preflight', () => {
  const readings = useCoreReadings({ strategy: 'single' });
  const base = (): PlannerInputs => ({ riskScore: 0.2, latencyBudgetMs: Infinity, isMultiStep: false, remoteAvailable: false, backgroundEligible: false });
  test('a changing task getter is read once and cannot substitute text after validation', async () => {
    let gets = 0;
    const input = { ...base(), get taskDescription() { return ++gets === 1 ? 'Ordinary task' : marker; } };
    const decision = await new AdaptivePlanner().select(input);
    expect(gets).toBe(1); expect(decision.inputs.taskDescription).toBe('Ordinary task');
    expect(readings.requests).toHaveLength(1);
    expect(JSON.stringify(readings.requests)).not.toContain(marker);
    expect(JSON.stringify(readings.requests)).toContain('Ordinary task');
  });
  test('materialized protected text is refused before any judgment request', async () => {
    let gets = 0;
    const input = { ...base(), get taskDescription() { gets++; return marker; } };
    await expect(new AdaptivePlanner().select(input)).rejects.toBeInstanceOf(JudgmentInputError);
    expect(gets).toBe(1); expect(readings.requests).toHaveLength(0);
  });
  test('a Proxy cannot hide the materialized task behind harmless descriptors', async () => {
    let gets = 0;
    const input = new Proxy({ ...base(), taskDescription: 'Ordinary task' }, {
      get(target, key, receiver) { if (key === 'taskDescription') { gets++; return marker; } return Reflect.get(target, key, receiver); },
    });
    await expect(new AdaptivePlanner().select(input)).rejects.toBeInstanceOf(JudgmentInputError);
    expect(gets).toBe(1); expect(readings.requests).toHaveLength(0);
  });
  test('documented unbounded latency and numeric clamping remain intact', async () => {
    const planner = new AdaptivePlanner();
    const unbounded = await planner.select({ ...base(), riskScore: NaN, taskDescription: 'Ordinary task' });
    expect(unbounded.inputs.latencyBudgetMs).toBe(Infinity); expect(unbounded.inputs.riskScore).toBe(0);
    const clamped = await planner.select({ ...base(), riskScore: 9, latencyBudgetMs: -1 });
    expect(clamped.inputs.riskScore).toBe(1); expect(clamped.inputs.latencyBudgetMs).toBe(0);
    expect(readings.requests).toHaveLength(2);
  });
});
