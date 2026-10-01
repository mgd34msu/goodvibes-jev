import type { JudgmentPort, Questions, Reading } from '@goodvibes-jev/judgment/decisions';
import type {
  AuthenticatedPrincipal, BrowserJudgmentBatteryId, BrowserJudgmentInputMap, BrowserJudgmentValueMap,
} from '@goodvibes-jev/engine/daemon-sdk';
import type { BrowserJudgmentReferences } from './references.js';

export type BrowserJudgmentProjection<V> =
  | { readonly status: 'settled'; readonly value: V; readonly readings: Readonly<Record<string, Reading>> }
  | { readonly status: 'held'; readonly reason: 'uncertain'; readonly readings: Readonly<Record<string, Reading>> };

/** Produced only by the server resolver. A reference proves read access, not outbound permission. */
export interface BrowserJudgmentResolvedInput<S> {
  readonly state: S;
  readonly sourceBinding: string;
  /** Throws a value-free hold if source revision, permission, or lifetime changed. */
  readonly assertCurrent: () => void;
}
export interface BrowserJudgmentResolveContext {
  readonly principal: AuthenticatedPrincipal;
  /** Fresh transport identity/scopes; reference assertions must use this rather than a cached grant. */
  readonly currentPrincipal: () => AuthenticatedPrincipal;
  readonly signal: AbortSignal;
  readonly references: BrowserJudgmentReferences;
}
/** Executable adapter around an existing Battery or named pattern; never received over HTTP. */
export interface BrowserJudgmentBattery<K extends BrowserJudgmentBatteryId, S, R> {
  readonly id: K;
  readonly version: 1;
  /** Fixed questions only. Dynamic state must not be embedded in logged questions. */
  readonly questions: Questions;
  readonly maxCalls: number;
  readonly resolve: (input: BrowserJudgmentInputMap[K], context: BrowserJudgmentResolveContext) => Promise<BrowserJudgmentResolvedInput<S>>;
  readonly run: (port: JudgmentPort, state: S, options: { readonly signal: AbortSignal }) => Promise<R>;
  readonly project: (result: R) => BrowserJudgmentProjection<BrowserJudgmentValueMap[K]>;
}
/** Acquired by server composition. Neither route identity nor port comes from browser JSON. */
export interface BrowserJudgmentRoute {
  readonly revision: string;
  readonly kind: 'hosted' | 'local';
  readonly port: JudgmentPort;
  readonly assertCurrent: () => void;
}
export interface BrowserJudgmentAuthorization {
  readonly principal: AuthenticatedPrincipal;
  readonly battery: BrowserJudgmentBatteryId;
  readonly batteryVersion: 1;
  readonly sourceBinding: string;
  readonly route: Pick<BrowserJudgmentRoute, 'revision' | 'kind'>;
}
