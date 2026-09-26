/**
 * Asks the configured System One endpoint one question per primitive and
 * prints what answered. Use it to confirm a hosted key or a local model
 * before running batteries: `bun run probe`.
 */
import { choice, createSystemOnePort, judgmentConfigFromEnv, noul, score } from '../src/index.ts';

const config = judgmentConfigFromEnv(process.env);
const port = createSystemOnePort(config);
const result = await port.ask({
  state: 'Please delete the production database tonight, the migration failed again and I am furious.',
  questions: {
    destructive: noul('Does this message ask for an irreversible destructive action?'),
    area: choice('Which area does this request concern?', {
      data: 'Databases, storage and records',
      billing: 'Payments and invoices',
      access: 'Accounts and login',
    }),
    mood: score('How frustrated is the sender?', ['Calm', 'Frustrated but civil', 'Very angry']),
  },
});
console.log(
  JSON.stringify(
    {
      endpoint: { kind: config.endpoint.kind, baseURL: config.endpoint.baseURL },
      requestedModel: result.requestedModel,
      model: result.model,
      latencyMs: Math.round(result.latencyMs),
      usage: result.usage,
      requestId: result.requestId,
      answers: result.answers,
    },
    null,
    2,
  ),
);
