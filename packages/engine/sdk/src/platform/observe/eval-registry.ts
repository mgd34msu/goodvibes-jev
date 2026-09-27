/**
 * EvalRegistry holds the latest evaluation harness run state: the newest
 * result per suite and the newest gate result per suite, for the `/eval`
 * command surface and anything else that shows eval runs.
 *
 * Hoisted from goodvibes-tui's src/panels/eval-registry.ts into the engine's
 * observe subsystem. A plain read model with subscribe and notify; nothing in
 * it is a decision.
 */

import type { EvalGateResult, EvalSuiteResult } from '../runtime/eval/types.js';

export class EvalRegistry {
  private _suiteResults: EvalSuiteResult[] = [];
  private _gateResults: EvalGateResult[] = [];
  private _running = false;
  private _lastRunAt: number | null = null;
  private readonly _subscribers = new Set<() => void>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Records a suite result, replacing the previous result for the same suite. */
  push(result: EvalSuiteResult): void {
    const idx = this._suiteResults.findIndex((r) => r.suite === result.suite);
    if (idx >= 0) {
      this._suiteResults[idx] = result;
    } else {
      this._suiteResults.push(result);
    }
    this._lastRunAt = this.now();
    this._notify();
  }

  /** Records a gate result, replacing the previous gate result for the same suite. */
  pushGate(gate: EvalGateResult): void {
    const idx = this._gateResults.findIndex((g) => g.suite === gate.suite);
    if (idx >= 0) {
      this._gateResults[idx] = gate;
    } else {
      this._gateResults.push(gate);
    }
    this._notify();
  }

  setRunning(running: boolean): void {
    this._running = running;
    this._notify();
  }

  isRunning(): boolean { return this._running; }
  getLastRunAt(): number | null { return this._lastRunAt; }
  getSuiteResults(): EvalSuiteResult[] { return this._suiteResults; }
  getGateResults(): EvalGateResult[] { return this._gateResults; }

  /** Calls `cb` after every change; returns the unsubscribe. */
  subscribe(cb: () => void): () => void {
    this._subscribers.add(cb);
    return () => this._subscribers.delete(cb);
  }

  private _notify(): void {
    for (const cb of this._subscribers) cb();
  }
}
