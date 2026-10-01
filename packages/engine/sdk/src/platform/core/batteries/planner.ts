/** Execution strategy is a reading of the task and available capabilities. */
import { defineBattery, oneOf, STAKES_BANDS } from '@goodvibes-jev/judgment';

export const executionStrategy = defineBattery({
  name: 'engine.core.execution-strategy', version: 1,
  description: 'Choose how to execute the actual task, respecting user constraints, current capabilities and the recorded risk reading.',
  accuracyFloor: 0.9,
  items: {
    strategy: oneOf('Which strategy fits task? Consider dependencies, requested latency, risk and any explicit no-delegation instruction. remote and background are eligible only when their corresponding availability flag is true. isMultiStep is an observation, not a command to parallelize. Choose single when coordination would not help.', {
      single: 'One agent completes the work directly without delegation.',
      cohort: 'A coordinated group handles independently useful pieces and integrates them.',
      background: 'Work belongs in the available background queue without an immediate interactive result.',
      remote: 'The available remote executor is the appropriate place to complete the task.',
    }, STAKES_BANDS.medium.confidence),
  },
  fixtures: [
    { name: 'direct explanation', state: { task: 'Explain how this parser works.', riskScore: 0, latencyBudgetMs: 'unbounded', isMultiStep: false, remoteAvailable: false, backgroundEligible: false }, expect: { strategy: 'single' } },
    { name: 'dependent high-stakes repair', state: { task: 'Carefully repair the active production payment incident yourself. Do not delegate.', riskScore: 1, latencyBudgetMs: 'unbounded', isMultiStep: true, remoteAvailable: true, backgroundEligible: true }, expect: { strategy: 'single' } },
    { name: 'independent components', state: { task: 'Implement the independent API client, UI and documentation in parallel, then integrate and test them.', riskScore: 0.33, latencyBudgetMs: 'unbounded', isMultiStep: true, remoteAvailable: false, backgroundEligible: false }, expect: { strategy: 'cohort' } },
    { name: 'background indexing', state: { task: 'Rebuild the search index overnight in the background queue; no immediate result is needed.', riskScore: 0.33, latencyBudgetMs: 'unbounded', isMultiStep: true, remoteAvailable: false, backgroundEligible: true }, expect: { strategy: 'background' } },
    { name: 'remote workspace', state: { task: 'Run the benchmark on the connected GPU worker where the dataset already resides.', riskScore: 0.33, latencyBudgetMs: 'unbounded', isMultiStep: false, remoteAvailable: true, backgroundEligible: false }, expect: { strategy: 'remote' } },
    { name: 'unavailable remote', state: { task: 'Summarize the local README; the remote worker is unavailable.', riskScore: 0, latencyBudgetMs: 1000, isMultiStep: false, remoteAvailable: false, backgroundEligible: false }, expect: { strategy: 'single' } },
  ],
});
