/**
 * Observe: judgment analytics over the decision log (accuracy against
 * confidence, threshold sweeps, drift, question discovery, calls outside a
 * registered battery, judgment cost), the judgment accuracy eval suite, and
 * the eval registry and cost tracker hoisted from the TUI.
 */
export { OBSERVE_THRESHOLDS } from './thresholds.js';
export { loggedReadings, readingsOfEntry, UNNAMED, type LoggedReading } from './log-readings.js';
export {
  batteryAccuracy,
  thresholdSweeps,
  truthChecksByBattery,
  type BatteryAccuracy,
  type BatterySweep,
  type LoggedSweepPoint,
} from './accuracy.js';
export { outcomeShift, readingDrift, type BatteryDrift, type DriftOptions, type DriftWindow } from './drift.js';
export { stuckQuestions, unregisteredCalls, type StuckQuestion, type UnregisteredCalls } from './discovery.js';
export { judgmentCost, judgmentUsageRecord, type JudgmentCost, type JudgmentCostRow } from './judgment-cost.js';
export { analyzeDecisionLog, analyzeEntries, type ObserveOptions, type ObserveReport } from './analyze.js';
export { formatObserveReport } from './format.js';
export { JUDGMENT_EVAL_SUITE, judgmentEvalScenarios } from './judgment-suite.js';
export { EvalRegistry } from './eval-registry.js';
export {
  COST_HISTORY_LENGTH,
  CostTracker,
  type CostTrackerOptions,
  type CostTrackerUsage,
  type SessionPricer,
  type TrackedAgentCost,
} from './cost-tracker.js';
