import { fieldKind, redactionCredential, residualCredential } from '@goodvibes-jev/engine/sdk/platform/utils';
import nativeRoute from '../fixtures/e2e-judgments/native-route.json';
import nativeTurn from '../fixtures/e2e-judgments/native-turn.json';
import modelIdentity from '../fixtures/e2e-judgments/model-identity.json';
import modelTier from '../fixtures/e2e-judgments/model-tier.json';
import unavailableModelRoutes from '../fixtures/e2e-judgments/unavailable-model-routes.json';
import unavailableNotices from '../fixtures/e2e-judgments/unavailable-notices.json';

const prompts = ['please answer the e2e marmot question', 'describe the lighthouse keeper routine', 'summarize the heron migration notes'] as const;
const stable = (value: unknown): string => JSON.stringify(value, (_key, entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);

/**
 * Replace only host-generated SHA-256 protocol identities, retaining their
 * equality relationships. All semantic text, complete questions, keys and
 * shape must still match the captured synthetic request exactly.
 */
export function nativeFixtureShape(value: unknown): string {
  const identities = new Map<string, string>();
  return stable(value).replace(/"[a-f0-9]{64}"/g, identity => {
    let slot = identities.get(identity);
    if (!slot) { slot = `"<host-sha256-${identities.size}>"`; identities.set(identity, slot); }
    return slot;
  });
}

type PrivacyKind = 'privacy-field' | 'privacy-source' | 'privacy-residual';
// Explicit authored roles for these native diagnostic fields. Unknown names
// still fail; names that do not establish a value role remain uncertain.
const privacyFieldRoles = {
  "count": "other",
  "sampleIds": "other",
  "path": "other",
  "cachePath": "other",
  "exists": "other",
  "invalidFields": "other",
  "kind": "other",
  "type": "other",
  "method": "other",
  "url": "other",
  "status": "other",
  "latencyMs": "other",
  "provider": "other",
  "providerName": "other",
  "model": "other",
  "baseURL": "other",
  "endpoint": "other",
  "endpointHost": "other",
  "contentLength": "other",
  "contentType": "other",
  "elapsedSeconds": "other",
  "thresholdSeconds": "other",
  "messageCount": "other",
  "toolCount": "other",
  "totalModels": "other",
  "childPid": "other",
  "deadOwnerPid": "other",
  "request": "content",
  "resumed": "other",
  "queued": "other",
  "reaped": "other",
  "skipped": "other",
  "projectRoot": "other",
  "movedTo": "other",
  "moved": "other",
  "discarded": "other",
  "mode": "other",
  "allowInsecureLocalhost": "other",
  "customCaEntryCount": "other",
  "effectiveCaStrategy": "other",
  "gitDir": "other",
  "ready": "other",
  "port": "other",
  "host": "other",
  "tlsMode": "other",
  "scheme": "other",
  "trustProxy": "other",
  "canonicalPath": "other",
  "totalImported": "other",
  "totalSkipped": "other",
  "missing": "other",
  "failed": "other",
  "filePath": "other",
  "tokenCount": "other",
  "max_tokens": "other",
  "requestId": "other",
  "retryStatus": "other",
  "error": "content",
  "lines": "content",
  "proseLines": "content",
  "report": "content",
  "errors": "content",
  "announcement": "content",
  "stdout": "content",
  "message": "content",
  "ENOENT": "uncertain",
  "fields": "uncertain",
  "ledger": "uncertain",
  "sources": "uncertain",
  "unlockPassphrase": "secret",
  "privateSigningMaterial": "secret",
  "loginPassword": "secret",
  "shippingAddress": "owner_profile",
  "billing_address": "owner_profile"
} as const;
const ordinaryDiagnosticTexts = [
  'Unable to connect. Is the computer able to access the url?',
  'the judgment request was rejected',
] as const;
const ordinaryMissingFileSuffixes = [
  "/.goodvibes/daemon/provider-models/aihubmix.json",
  "/.goodvibes/daemon/provider-models/anthropic.json",
  "/.goodvibes/daemon/provider-models/cerebras.json",
  "/.goodvibes/daemon/provider-models/cloudflare-ai-gateway.json",
  "/.goodvibes/daemon/provider-models/copilot-proxy.json",
  "/.goodvibes/daemon/provider-models/deepseek.json",
  "/.goodvibes/daemon/provider-models/fireworks.json",
  "/.goodvibes/daemon/provider-models/gemini.json",
  "/.goodvibes/daemon/provider-models/groq.json",
  "/.goodvibes/daemon/provider-models/huggingface.json",
  "/.goodvibes/daemon/provider-models/litellm.json",
  "/.goodvibes/daemon/provider-models/llm7.json",
  "/.goodvibes/daemon/provider-models/microsoft-foundry.json",
  "/.goodvibes/daemon/provider-models/minimax.json",
  "/.goodvibes/daemon/provider-models/mistral.json",
  "/.goodvibes/daemon/provider-models/moonshot.json",
  "/.goodvibes/daemon/provider-models/nvidia.json",
  "/.goodvibes/daemon/provider-models/ollama-cloud.json",
  "/.goodvibes/daemon/provider-models/openrouter.json",
  "/.goodvibes/daemon/provider-models/qianfan.json",
  "/.goodvibes/daemon/provider-models/qwen.json",
  "/.goodvibes/daemon/provider-models/sglang.json",
  "/.goodvibes/daemon/provider-models/stepfun.json",
  "/.goodvibes/daemon/provider-models/together.json",
  "/.goodvibes/daemon/provider-models/venice.json",
  "/.goodvibes/daemon/provider-models/vercel-ai-gateway.json",
  "/.goodvibes/daemon/provider-models/volcengine.json",
  "/.goodvibes/daemon/provider-models/xai.json",
  "/.goodvibes/daemon/provider-models/xiaomi.json",
  "/.goodvibes/daemon/provider-models/zai.json",
  "/.goodvibes/tui/model-tiers.json",
  "/.goodvibes/tui/provider-models/aihubmix.json",
  "/.goodvibes/tui/provider-models/anthropic.json",
  "/.goodvibes/tui/provider-models/cerebras.json",
  "/.goodvibes/tui/provider-models/cloudflare-ai-gateway.json",
  "/.goodvibes/tui/provider-models/copilot-proxy.json",
  "/.goodvibes/tui/provider-models/deepseek.json",
  "/.goodvibes/tui/provider-models/fireworks.json",
  "/.goodvibes/tui/provider-models/gemini.json",
  "/.goodvibes/tui/provider-models/groq.json",
  "/.goodvibes/tui/provider-models/huggingface.json",
  "/.goodvibes/tui/provider-models/inceptionlabs.json",
  "/.goodvibes/tui/provider-models/litellm.json",
  "/.goodvibes/tui/provider-models/llm7.json",
  "/.goodvibes/tui/provider-models/microsoft-foundry.json",
  "/.goodvibes/tui/provider-models/minimax.json",
  "/.goodvibes/tui/provider-models/mistral.json",
  "/.goodvibes/tui/provider-models/moonshot.json",
  "/.goodvibes/tui/provider-models/nvidia.json",
  "/.goodvibes/tui/provider-models/ollama-cloud.json",
  "/.goodvibes/tui/provider-models/openrouter.json",
  "/.goodvibes/tui/provider-models/qianfan.json",
  "/.goodvibes/tui/provider-models/qwen.json",
  "/.goodvibes/tui/provider-models/sglang.json",
  "/.goodvibes/tui/provider-models/stepfun.json",
  "/.goodvibes/tui/provider-models/together.json",
  "/.goodvibes/tui/provider-models/venice.json",
  "/.goodvibes/tui/provider-models/vercel-ai-gateway.json",
  "/.goodvibes/tui/provider-models/volcengine.json",
  "/.goodvibes/tui/provider-models/xai.json",
  "/.goodvibes/tui/provider-models/xiaomi.json",
  "/.goodvibes/tui/provider-models/zai.json",
  "/.goodvibes/tui/synthetic-identities.json"
] as const;

function privacyAnswers(body: unknown, ordinaryMissingFiles: readonly string[]): { kind: PrivacyKind; answers: unknown } | undefined {
  const serialized = stable(body);
  const matches = (state: unknown, questions: unknown) => serialized === stable({ state, questions, model: nativeRoute.model });
  for (const [field, role] of Object.entries(privacyFieldRoles)) {
    if (!matches({ field }, { kind: fieldKind.items.kind.question })) continue;
    const probabilities = { secret: 0, owner_profile: 0, content: 0, other: 0 };
    if (role === 'uncertain') {
      return { kind: 'privacy-field', answers: { kind: { type: 'choice', choice: 'other', confidence: 0.25,
        probabilities: { secret: 0.25, owner_profile: 0.25, content: 0.25, other: 0.25 } } } };
    }
    probabilities[role] = 1;
    return { kind: 'privacy-field', answers: { kind: { type: 'choice', choice: role, confidence: 1, probabilities } } };
  }
  for (const text of ordinaryDiagnosticTexts) {
    if (matches({ phase: 'source', parts: [{ kind: 'text', text }], target: 'whole-line' }, {
      lineHasCredential: redactionCredential.items.lineHasCredential.question,
      spanIsCredential: redactionCredential.items.spanIsCredential.question,
    })) return { kind: 'privacy-source', answers: {
      lineHasCredential: { type: 'noul', noul: 0 }, spanIsCredential: { type: 'noul', noul: 0 },
    } };
  }
  const residuals: unknown[] = [
    { parts: [{ kind: 'text', text: "'fleet.snapshot' failed: " }, { kind: 'withheld', reference: 'span-1' }, { kind: 'text', text: '' }] },
    ...ordinaryMissingFiles.map(path => ({ parts: [{ kind: 'text', text: 'ENOENT: ' },
      { kind: 'withheld', reference: 'span-1' }, { kind: 'text', text: `, open '${path}'` }] })),
  ];
  for (const state of residuals) {
    if (matches(state, { credentialRemains: residualCredential.items.credentialRemains.question })) {
      return { kind: 'privacy-residual', answers: { credentialRemains: { type: 'noul', noul: 0 } } };
    }
  }
  return undefined;
}

const nativePrompt = nativeRoute.state.originalSource.text;
function nativeRequest(template: typeof nativeRoute | typeof nativeTurn, prompt: string): unknown {
  return JSON.parse(JSON.stringify(template).split(JSON.stringify(nativePrompt)).join(JSON.stringify(prompt)));
}

/** Exact captured synthetic requests, never an approval/classification shortcut. */
export function e2eJudgmentAnswers(body: unknown, ordinaryMissingFiles: readonly string[] = []): { kind: 'tier' | 'identity' | 'native-route' | 'native-turn' | PrivacyKind; answers: unknown } | undefined {
  const privacy = privacyAnswers(body, ordinaryMissingFiles);
  if (privacy) return privacy;
  const serialized = stable(body);
  if (serialized === stable(modelTier)) return { kind: 'tier', answers: {
    frontier: { type: 'noul', noul: 0 }, small: { type: 'noul', noul: 1 },
  } };
  if (serialized === stable(modelIdentity)) return { kind: 'identity', answers: {
    pick: { type: 'choice', choice: 'none', confidence: 1, probabilities: { 'gemini-2.5-pro': 0, 'mercury-2': 0, none: 1 } },
    fits_0: { type: 'noul', noul: 0 }, fits_1: { type: 'noul', noul: 0 },
  } };
  for (const prompt of prompts) {
    if (nativeFixtureShape(body) === nativeFixtureShape(nativeRequest(nativeRoute, prompt))) return { kind: 'native-route', answers: {
      route: { type: 'choice', choice: 'converse', confidence: 0.99, probabilities: { converse: 0.99, answer: 0.005, contract: 0.005 } },
    } };
    if (nativeFixtureShape(body) === nativeFixtureShape(nativeRequest(nativeTurn, prompt))) return { kind: 'native-turn', answers: {
      disposition: { type: 'choice', choice: 'act', confidence: 0.99, probabilities: { act: 0.99, reject: 0.005, revise_0: 0.005 } },
    } };

  }
  return undefined;
}

export function startE2EJudgments(options: { readonly ordinaryHomes?: readonly string[] } = {}) {
  // These exact roots are supplied by the owning temporary-home fixture.
  // No arbitrary path shape or text is treated as safe.
  const ordinaryMissingFiles = Object.freeze((options.ordinaryHomes ?? []).flatMap(home =>
    ordinaryMissingFileSuffixes.map(suffix => `${home}${suffix}`)));
  const accepted: string[] = [];
  const rejected: unknown[] = [];
  const unexpected: unknown[] = [];
  // Captured background registry probes intentionally receive no synthetic
  // classification. They stay unavailable; any new semantic request is a failure.
  const expectedNegative = new Set(unavailableModelRoutes.map(stable));
  // These exact startup notices may stay unclassified. Only their generated
  // session identifier varies; a new notice or question still fails the test.
  const noticeShape = (value: unknown) => stable(value).replace(/user-[a-f0-9]{8}/g, 'user-<id>');
  const expectedNoticeNegative = new Set(unavailableNotices.map(noticeShape));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/systemone') return new Response('not found', { status: 404 });
    let body: unknown;
    try { body = await request.json(); } catch { return new Response('invalid JSON', { status: 400 }); }
    const reading = e2eJudgmentAnswers(body, ordinaryMissingFiles);
    if (!reading) {
      rejected.push(body);
      if (!expectedNegative.has(stable(body)) && !expectedNoticeNegative.has(noticeShape(body))) unexpected.push(body);
      return Response.json({ error: { message: 'Unknown deterministic E2E judgment; rejected' } }, { status: 422 });
    }
    accepted.push(reading.kind);
    return Response.json({ model: nativeRoute.model, answers: reading.answers, usage: { input_tokens: 10, output_tokens: 3 } });
  } });
  return { baseURL: `http://127.0.0.1:${server.port}`, accepted, rejected, unexpected,
    assertNoUnexpected: () => { if (unexpected.length) throw new Error(`E2E encountered ${unexpected.length} unknown judgment request(s): ${JSON.stringify(unexpected)}`); },
    stop: () => { void server.stop(true); },
  };
}
