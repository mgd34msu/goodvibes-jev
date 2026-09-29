/**
 * `engine.runtime.at-rest-credential`: is a string found in a line about to be
 * written to the owner's own disk (the per-agent transcript journal, the local
 * execution ledger and span file, the crash log) a credential value? Read by
 * at-rest-persistence.ts in place of the rule that masked, as a credential,
 * any `sk-` token of 20 or more characters, any `key-` token of 16 or more,
 * and the word after a case-insensitive `Bearer` (utils/redaction.ts). That
 * rule masked `key-rotation-policy-for-tenants` and the `of` in "the bearer of
 * bad news" in the owner's journal and ledger.
 *
 * The three shapes still FIND the candidate spans in code; they no longer
 * decide. One yes/no per distinct span, each its own request, with the text
 * around the span as context. The issuer-reserved formats (`ghp_`, `gho_`,
 * `github_pat_`, `glpat-`, `xoxb-`, `xoxp-`, `AKIA`) are credentials by the
 * issuer's own definition and stay code.
 *
 * Band: critical stakes. A credential read as ordinary text is written in the
 * clear to disk; ordinary text read as a credential only costs a readable
 * word. The span is kept in the clear only on a no verdict, which the critical
 * band gives at 0.9 confidence or more; yes, uncertain, or no reading at all
 * leaves the span masked.
 */
import { defineBattery, STAKES_BANDS, yesNo } from '@goodvibes-jev/judgment';

/** A type alias rather than an interface, so it is assignable to the port's JSON state type. */
export type AtRestCredentialState = {
  readonly span: string;
  readonly context: string;
};

export const atRestCredential = defineBattery({
  name: 'engine.runtime.at-rest-credential',
  version: 1,
  description: 'Whether a string found in a line written to the owner\'s disk is a credential value that must be masked.',
  accuracyFloor: 0.9,
  items: {
    credential: yesNo(
      '`span` is a string found inside `context`, text an AI coding agent\'s runtime is about to write to a log file. Is `span` itself a credential value: a secret API key, access or bearer token, password or signing secret that would let whoever holds it authenticate as its owner? A string that only resembles one is not: an ordinary word (such as the word after "bearer" in a sentence), a document, branch, file, CSS class or setting name, a placeholder such as YOUR_TOKEN_HERE, or a value made of repeated filler characters.',
      STAKES_BANDS.critical.yesNo,
      {
        true: 'The span is a secret value that grants access to an account or service.',
        false: 'The span is a word, name, identifier or placeholder that grants no access.',
      },
    ),
  },
  fixtures: [
    {
      name: 'OpenAI project key in a shell export',
      state: { span: 'sk-proj-4fQ9xT2mLk8vRw7ZbN3cYp1JhG6sDe0A', context: '{"type":"tool_result","output":"$ export OPENAI_API_KEY=sk-proj-4fQ9xT2mLk8vRw7ZbN3cYp1JhG6sDe0A && bun run dev"}' },
      expect: { credential: 'yes' },
    },
    {
      name: 'OpenRouter key in a config dump',
      state: { span: 'sk-or-v1-7c1e2b9a04d38f6e5a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d', context: '{"provider":"openrouter","apiKey":"sk-or-v1-7c1e2b9a04d38f6e5a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d","model":"openrouter/free"}' },
      expect: { credential: 'yes' },
    },
    {
      name: 'Mailgun key assigned in an env file',
      state: { span: 'key-3ax6xnjp29jd6fds4gc373sgvjxteol0', context: '{"role":"assistant","body":"Added MAILGUN_API_KEY=key-3ax6xnjp29jd6fds4gc373sgvjxteol0 to .env.local"}' },
      expect: { credential: 'yes' },
    },
    {
      name: 'JWT after Bearer in a curl command',
      state: { span: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTQyIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', context: '{"command":"curl -H \\"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTQyIn0.dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk\\" https://api.example.com/v1/me"}' },
      expect: { credential: 'yes' },
    },
    {
      name: 'Google OAuth access token after Bearer',
      state: { span: 'ya29.a0AfB_byC8kQx3mT2vLr9pWnZ7sE4hJ1uYg6oD0cF5bN8aK', context: '{"eventName":"HTTP_REQUEST","payload":{"headers":{"authorization":"Bearer ya29.a0AfB_byC8kQx3mT2vLr9pWnZ7sE4hJ1uYg6oD0cF5bN8aK"}}}' },
      expect: { credential: 'yes' },
    },
    {
      name: 'hex token after Bearer in an HTTP log',
      state: { span: '7f3c9a1e5b2d48f0a6c4e8b1d3f5a7c9', context: '{"output":"GET /v2/repos 401 headers={\\"authorization\\":\\"Bearer 7f3c9a1e5b2d48f0a6c4e8b1d3f5a7c9\\"}"}' },
      expect: { credential: 'yes' },
    },
    {
      name: 'document name starting with key-',
      state: { span: 'key-rotation-policy-for-tenants', context: '{"role":"user","body":"Read docs/key-rotation-policy-for-tenants.md before you change the auth middleware."}' },
      expect: { credential: 'no' },
    },
    {
      name: 'the word after bearer in a sentence',
      state: { span: 'of', context: '{"role":"assistant","body":"Sorry to be the bearer of bad news, but the release build is red again."}' },
      expect: { credential: 'no' },
    },
    {
      name: 'branch name starting with key-',
      state: { span: 'key-value-store-migration-2024', context: '{"command":"git checkout -b key-value-store-migration-2024"}' },
      expect: { credential: 'no' },
    },
    {
      name: 'CSS class starting with sk-',
      state: { span: 'sk-spinner-double-bounce-animation', context: '{"path":"src/Loading.tsx","content":"<div className=\\"sk-spinner-double-bounce-animation\\" aria-busy=\\"true\\" />"}' },
      expect: { credential: 'no' },
    },
    {
      name: 'placeholder after Bearer in setup instructions',
      state: { span: 'YOUR_TOKEN_HERE', context: '{"role":"assistant","body":"Send the header Authorization: Bearer YOUR_TOKEN_HERE with each request."}' },
      expect: { credential: 'no' },
    },
    {
      name: 'the word after Bearer in a protocol description',
      state: { span: 'and', context: '{"role":"assistant","body":"The gateway rejects a request whose scheme is Bearer and whose token has expired."}' },
      expect: { credential: 'no' },
    },
    {
      name: 'setting name starting with key-',
      state: { span: 'key-management-service-endpoint', context: '{"body":"Set key-management-service-endpoint=https://kms.internal.example.com in the deploy config."}' },
      expect: { credential: 'no' },
    },
    {
      name: 'filler placeholder shaped like an sk- key',
      state: { span: 'sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', context: '{"path":"README.md","content":"OPENAI_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx  # replace with your own key"}' },
      expect: { credential: 'no' },
    },
  ],
});
