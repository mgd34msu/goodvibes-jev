import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { captureStrictJudgmentJson, judgmentInputBoundary } from '@goodvibes-jev/engine/sdk/platform/gate';
import { CONTENT_DERIVATION_SITE } from '@goodvibes-jev/engine/sdk/platform/security';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/sdk/platform/tools';
import { isDeepStrictEqual } from 'node:util';
import { evaluateOutwardEffect, getSessionUntrustedContentLedger } from '../trust/untrusted-content.ts';
import { screenOutboundForCardMaterial } from './payments-channel-guard.ts';

/** Retain the local source record; this does not mint execution or human authority. */
export function captureOperatorRequestPolicy() {
  const ledger = getSessionUntrustedContentLedger();
  const origins = ledger.originsThisTurn, exposures = ledger.exposuresThisTurn, sources = ledger.taintSourcesThisTurn;
  const current = () => captureStrictJudgmentJson([origins.call(ledger), exposures.call(ledger), sources.call(ledger)]);
  const original = current();
  const assertCurrent = () => {
    if (getSessionUntrustedContentLedger() !== ledger || ledger.originsThisTurn !== origins
      || ledger.exposuresThisTurn !== exposures || ledger.taintSourcesThisTurn !== sources
      || !isDeepStrictEqual(current(), original)) throw new ToolInputProjectionError('stale');
  };
  assertCurrent();
  return { assertCurrent, async screen(request: { readonly toolName: string; readonly methodId: string; readonly endpoint: string; readonly payload: Record<string, unknown> },
    options: { readonly signal?: AbortSignal | undefined; readonly assertCurrent: () => void }) {
    const check = () => { options.signal?.throwIfAborted(); options.assertCurrent(); assertCurrent(); };
    check();
    const content = { endpoint: request.endpoint, payload: JSON.stringify(request.payload) };
    // Check the complete retained source before any truncated semantic comparison.
    if (!judgmentInputBoundary(request.toolName, { content, sources: original }).passed) throw new ToolInputProjectionError('held');
    const card = await screenOutboundForCardMaterial({ surface: 'connected-host', message: content.payload, title: content.endpoint },
      { signal: options.signal, assertCurrent: check });
    check();
    if (card) throw new ToolInputProjectionError('held');
    const port = judgmentPort(CONTENT_DERIVATION_SITE);
    const decision = await evaluateOutwardEffect({ request: { toolName: request.toolName, action: request.methodId,
      description: 'invoking the selected connected-host operator effect' }, ledger, content,
      taintOptions: { signal: options.signal, exactMatchFields: ['endpoint'], port: {
        get model() { return port.model; }, ...(port.recorder ? { recorder: port.recorder } : {}),
        async ask(reading) {
          check(); const prior = reading.beforeAttempt;
          const result = await port.ask({ ...reading, beforeAttempt() { prior?.(); check(); } });
          check(); return result;
        },
      } } });
    check();
    if (!decision.allowed) throw new ToolInputProjectionError('held');
  } };
}
