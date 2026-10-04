import nativeRoute from '../fixtures/e2e-judgments/native-route.json';
import nativeTurn from '../fixtures/e2e-judgments/native-turn.json';
import conversationRoute from '../fixtures/e2e-judgments/conversation-route.json';
import modelIdentity from '../fixtures/e2e-judgments/model-identity.json';
import modelTier from '../fixtures/e2e-judgments/model-tier.json';
import turnQuestions from '../fixtures/e2e-judgments/turn-questions.json';
import unavailableModelRoutes from '../fixtures/e2e-judgments/unavailable-model-routes.json';

const prompts = ['first words in a brand new workspace', 'please answer the e2e marmot question'] as const;
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
const nativePrompt = nativeRoute.state.originalSource.text;
function nativeRequest(template: typeof nativeRoute | typeof nativeTurn, prompt: string): unknown {
  return JSON.parse(JSON.stringify(template).split(JSON.stringify(nativePrompt)).join(JSON.stringify(prompt)));
}

/** Exact captured synthetic requests, never an approval/classification shortcut. */
export function e2eJudgmentAnswers(body: unknown): { kind: 'tier' | 'identity' | 'route' | 'turn' | 'native-route' | 'native-turn'; answers: unknown } | undefined {
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
    if (serialized === stable({ ...conversationRoute, state: { request: prompt } })) return { kind: 'route', answers: {
      route: { type: 'choice', choice: 'converse', confidence: 0.99, probabilities: { converse: 0.99, answer: 0.005, contract: 0.005 } },
    } };
    if (serialized === stable({ state: { purpose: 'conversation', work: prompt }, questions: turnQuestions, model: conversationRoute.model })) return { kind: 'turn', answers: {
      intent: { type: 'choice', choice: 'chat', confidence: 0.99, probabilities: { chat: 0.99, task: 0.005, project: 0.005 } },
      needs_plan: { type: 'noul', noul: 0.01 },
      risk: { type: 'score', score: 0, confidence: 0.99, probabilities: { '0': 0.99, '1': 0.004, '2': 0.003, '3': 0.003 } },
    } };
  }
  return undefined;
}

export function startE2EJudgments() {
  const accepted: string[] = [];
  const rejected: unknown[] = [];
  const unexpected: unknown[] = [];
  // Captured background registry probes intentionally receive no synthetic
  // classification. They stay unavailable; any new semantic request is a failure.
  const expectedNegative = new Set(unavailableModelRoutes.map(stable));
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/systemone') return new Response('not found', { status: 404 });
    let body: unknown;
    try { body = await request.json(); } catch { return new Response('invalid JSON', { status: 400 }); }
    const reading = e2eJudgmentAnswers(body);
    if (!reading) {
      rejected.push(body);
      if (!expectedNegative.has(stable(body))) unexpected.push(body);
      return Response.json({ error: { message: 'Unknown deterministic E2E judgment; rejected' } }, { status: 422 });
    }
    accepted.push(reading.kind);
    return Response.json({ model: conversationRoute.model, answers: reading.answers, usage: { input_tokens: 10, output_tokens: 3 } });
  } });
  return { baseURL: `http://127.0.0.1:${server.port}`, accepted, rejected, unexpected,
    assertNoUnexpected: () => { if (unexpected.length) throw new Error(`E2E encountered ${unexpected.length} unknown judgment request(s): ${JSON.stringify(unexpected)}`); },
    stop: () => { void server.stop(true); },
  };
}
