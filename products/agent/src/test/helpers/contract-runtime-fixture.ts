import type { EntryType, Question } from '@goodvibes-jev/judgment';
/** Offline I/O for the Agent's real composed contract runner. No runner/engine is replaced. */
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { AgentRecord } from '@goodvibes-jev/engine/sdk/platform/tools';
import { getTestRuntimeServices, resetTestRuntimeServices } from './runtime-services.ts';

export const CONTRACT_ASK = 'Cap the delay in src/isolation-fixture.ts';
export const contractPlan = {
  goal: 'Respect the delay cap', criteria: [{ id: 'c1', text: 'The delay is capped', quote: CONTRACT_ASK }],
  groups: [{ id: 'g1', title: 'Cap delay', goal: 'Respect the cap', kind: 'work', dependsOn: [], criteria: [],
    units: [{ id: 'u1', title: 'Cap delay', goal: 'Respect the cap', role: 'implement', brief: CONTRACT_ASK,
      dependsOn: [], files: ['src/isolation-fixture.ts'], criteria: [{ id: 'u1.c1', text: 'The delay is capped', serves: ['c1'] }] }] }],
};

export async function waitForContract(condition: () => boolean, describe: () => string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${describe()}`);
    await Bun.sleep(10);
  }
}

export function contractRuntimeFixture(runUnit: (record: AgentRecord, services: ReturnType<typeof getTestRuntimeServices>) => Promise<void>, planner: (record: AgentRecord) => unknown = () => contractPlan, answer?: (name: string, question: Question, state: EntryType) => unknown) {
  resetTestRuntimeServices();
  const services = getTestRuntimeServices();
  // The real route planner sees one configured, synthetic provider. It still
  // reads tier/fit and chooses a route; external model discovery stays offline.
  const model = services.providerRegistry.listModels().find((entry) => entry.registryKey === 'mock:mock-model');
  if (!model) throw new Error('Missing seeded synthetic model');
  services.providerRegistry.listModels = () => [model];
  services.providerRegistry.getConfiguredProviderIds = () => ['mock'];
  services.providerRegistry.benchmarks.readBenchmarks = async () => undefined;
  const requested: string[] = [];
  const fake = fakePort((rawName, question, state) => {
    requested.push(rawName);
    const name = rawName.split('__').at(-1)!;
    const scripted = answer?.(name, question, state);
    if (scripted !== undefined) return scripted;
    if (name === 'tier') return choiceAnswer(question, 'standard', 0.99);
    if (name === 'intent') return choiceAnswer(question, 'code_change', 0.99);
    if (name === 'domain') return choiceAnswer(question, 'software', 0.99);
    if (name === 'language') return choiceAnswer(question, 'english', 0.99);
    if (name === 'difficulty' || name === 'risk') return scoreAnswer(question, 1, 0.99);
    if (name === 'relation') return choiceAnswer(question, 'supports', 0.99);
    if (name === 'role') return choiceAnswer(question, 'implement', 0.99);
    if (name === 'severity') return choiceAnswer(question, 'major', 0.99);
    if (question.type === 'choice') {
      const selected = Object.keys(question.criteria).find((key) => key.includes('mock:mock-model'));
      if (selected) return choiceAnswer(question, selected, 0.99);
      throw new Error(`Unscripted contract choice ${name}: ${Object.keys(question.criteria).join(',')}`);
    }
    if (name === 'checkable' || name.startsWith('fits_')) return noulAnswer(0.99);
    // Clean shape/plan, standard model, met criteria and no quality defect.
    if (question.type === 'noul') return noulAnswer(0.01);
    throw new Error(`Unscripted contract question ${name}`);
  });
  const previous = installJudgmentPort(fake.port);
  services.agentManager.setExecutor({
    async runAgent(record) {
      if (record.template === 'planner') {
        record.fullOutput = `\`\`\`json\n${JSON.stringify(planner(record))}\n\`\`\``;
        record.status = 'completed';
        record.completedAt = Date.now();
        return;
      }
      // Like a real model call, the first turn yields until spawn registration completes.
      await Bun.sleep(0);
      await runUnit(record, services);
    },
  });
  return { services, requested, dispose() { services.dispose(); installJudgmentPort(previous); } };
}
