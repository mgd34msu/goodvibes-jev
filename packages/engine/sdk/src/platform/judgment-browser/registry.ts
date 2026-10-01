import type { JudgmentPort, Questions } from '@goodvibes-jev/judgment/decisions';
import {
  BROWSER_JUDGMENT_BATTERY_IDS, BROWSER_JUDGMENT_LIMITS, BrowserJudgmentError, captureBrowserJudgmentJson,
  type BrowserJudgmentBatteryId, type BrowserJudgmentInputMap, type BrowserJudgmentValueMap,
} from '@goodvibes-jev/engine/daemon-sdk';
import type { BrowserJudgmentBattery, BrowserJudgmentProjection, BrowserJudgmentResolveContext, BrowserJudgmentResolvedInput } from './types.js';

export interface RegisteredBrowserJudgmentBattery {
  readonly id: BrowserJudgmentBatteryId; readonly version: 1; readonly questions: Questions; readonly maxCalls: number;
  readonly resolve: (input: unknown, context: BrowserJudgmentResolveContext) => Promise<BrowserJudgmentResolvedInput<unknown>>;
  readonly run: (port: JudgmentPort, state: unknown, options: { readonly signal: AbortSignal }) => Promise<unknown>;
  readonly project: (result: unknown) => BrowserJudgmentProjection<BrowserJudgmentValueMap[BrowserJudgmentBatteryId]>;
}

/** Explicit compile-time installation. Calibration's BatteryRegistry is not an HTTP allowlist. */
export class BrowserJudgmentRegistry {
  readonly #entries = new Map<BrowserJudgmentBatteryId, RegisteredBrowserJudgmentBattery>();
  register<K extends BrowserJudgmentBatteryId, S, R>(battery: BrowserJudgmentBattery<K, S, R>): void {
    if (!(BROWSER_JUDGMENT_BATTERY_IDS as readonly string[]).includes(battery.id) || battery.version !== 1
      || this.#entries.has(battery.id) || !Number.isInteger(battery.maxCalls)
      || battery.maxCalls < 1 || battery.maxCalls > BROWSER_JUDGMENT_LIMITS.callsPerRun
      || Object.keys(battery.questions).length === 0) throw new BrowserJudgmentError('JUDGMENT_INVALID_INPUT');
    const questions = captureBrowserJudgmentJson(battery.questions) as Questions;
    this.#entries.set(battery.id, Object.freeze({
      id: battery.id, version: battery.version, questions, maxCalls: battery.maxCalls,
      resolve: (input: unknown, context: BrowserJudgmentResolveContext) => battery.resolve(input as BrowserJudgmentInputMap[K], context),
      run: (port: JudgmentPort, state: unknown, options: { readonly signal: AbortSignal }) => battery.run(port, state as S, options),
      project: (result: unknown) => battery.project(result as R),
    }));
  }
  get(id: BrowserJudgmentBatteryId): RegisteredBrowserJudgmentBattery | undefined { return this.#entries.get(id); }
}
